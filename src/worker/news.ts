import type { AlertCandidate, FeedDef, FeedState, NewsRow, Severity } from '../types';
import { findCluster, itemId, normalizeTitle, type ClusterRef } from '../core/dedupe';
import { looksRelevant, scoreByKeywords, type ScoredHeadline } from '../core/keywords';
import { routeNews } from '../core/newsRoute';
import { parseFeed, type RssItem } from '../providers/rss';
import { scoreBatch, llmUsagePct, type HeadlineIn, type LlmUsage } from '../llm/score';
import { errMsg, request } from '../util/http';
import { sanitize } from '../util/text';
import { emit, setKv, systemAlert, type Ctx } from './ctx';
import { trackSource } from './health';

const MAX_SEEN = 40; // feeds expose <= 15 items; a short memory keeps the per-minute DB read small (egress + CPU)
const MAX_AGE_SCORE_MS = 6 * 3600_000;

interface Pooled { id: string; feed: FeedDef; item: RssItem; title: string; source: string; norm: string }

const ARROW = { up: '↑', down: '↓', mixed: '↕' } as const;

function impactLine(ctx: Ctx, s: ScoredHeadline): string {
  const names = new Map(ctx.cfg.assets.map((a) => [a.id, a.id]));
  const parts = s.affected_assets.slice(0, 6).map((a) => `${names.get(a) ?? a} ${ARROW[s.likely_direction[a] ?? 'mixed']}`);
  return parts.length ? `${parts.join(', ')} (likely direction, not a forecast)` : 'No specific watched asset identified; watch broad risk sentiment.';
}

export async function runNews(ctx: Ctx): Promise<{ feedStates: FeedState[]; newsRows: NewsRow[] }> {
  const { cfg, now, state } = ctx;
  const feedStates: FeedState[] = [];
  const newsRows: NewsRow[] = [];
  const due = cfg.news.feeds.filter((_, i) => (ctx.minute + i) % cfg.news.feeds[i].everyMin === 0);
  if (!due.length) return { feedStates, newsRows };

  const fetched = await Promise.all(
    due.map(async (f) => {
      try {
        const { text } = await request(f.url, { ...ctx.o, timeoutMs: 6000, maxBytes: 300_000, headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' } });
        return { f, items: parseFeed(text, f.maxItems ?? 15), err: null as string | null, budget: false };
      } catch (e) {
        return { f, items: [] as RssItem[], err: errMsg(e), budget: (e as Error).name === 'BudgetExceeded' };
      }
    }),
  );

  const pool: Pooled[] = [];
  const feedSeenAdd = new Map<string, string[]>();
  const stateOf = (id: string) => state.feeds[id];

  for (const r of fetched) {
    const st = stateOf(r.f.id);
    if (r.budget) continue;
    if (r.err) {
      feedStates.push({ feed_id: r.f.id, seen: st?.seen ?? [], last_ok: st?.last_ok ?? null, last_err: r.err.slice(0, 200), fails: (st?.fails ?? 0) + 1 });
      trackSource(ctx, `feed:${r.f.id}`, `Feed "${r.f.name}"`, false, r.err, 6);
      continue;
    }
    trackSource(ctx, `feed:${r.f.id}`, `Feed "${r.f.name}"`, true, undefined, 6);
    const seen = new Set(st?.seen ?? []);
    const add: string[] = [];
    const first = !st; // first ever poll: seed silently so history never floods the phone
    for (const it of r.items) {
      const id = itemId(r.f.id, it.guid || it.link, it.title);
      if (seen.has(id)) continue;
      const stale = it.published !== null && now - it.published > MAX_AGE_SCORE_MS;
      const irrelevant = (r.f.kind === 'general' || r.f.kind === 'crypto') && !looksRelevant(it.title);
      if (first || stale || irrelevant) { add.push(id); continue; }
      const isGn = r.f.url.includes('news.google.com');
      let title = sanitize(it.title, 220);
      if (isGn) title = title.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, '');
      pool.push({ id, feed: r.f, item: it, title, source: isGn && it.publisher ? it.publisher : r.f.name, norm: normalizeTitle(it.title) });
    }
    feedSeenAdd.set(r.f.id, add);
    feedStates.push({ feed_id: r.f.id, seen: st?.seen ?? [], last_ok: new Date(now).toISOString(), last_err: null, fails: 0 });
  }

  // newest first; cap how many we process this minute (the rest stay unseen and are picked up next minute)
  pool.sort((a, b) => (b.item.published ?? now) - (a.item.published ?? now));
  const selected = pool.slice(0, cfg.news.maxScoredPerRun);
  for (const p of selected) feedSeenAdd.get(p.feed.id)!.push(p.id);
  for (const fs of feedStates) {
    const add = feedSeenAdd.get(fs.feed_id) ?? [];
    fs.seen = [...add, ...fs.seen].slice(0, MAX_SEEN);
  }
  if (!selected.length) return { feedStates, newsRows };

  // ---- cluster against recent stored items + items earlier in this batch (cross-source dedupe)
  let recent: ClusterRef[] = [];
  try {
    recent = (await ctx.store.recentNews(now - 3 * 3600_000)).map((r) => ({ id: r.id, cluster_id: r.cluster_id, title_norm: r.title_norm, source: r.source }));
  } catch (e) {
    ctx.errors.push(`recentNews: ${errMsg(e)}`);
  }
  const watch: Record<string, { sources: string[]; headline: string; reason: string; assets: string[]; dir: Record<string, 'up' | 'down' | 'mixed'>; at: number; published: number }> = { ...(ctx.kv.watch_clusters ?? {}) };
  for (const [k, v] of Object.entries(watch)) if (now - v.at > 6 * 3600_000) delete watch[k];
  let watchChanged = false;

  const fresh: Array<Pooled & { cluster: string; sources: Set<string> }> = [];
  const batchRefs: ClusterRef[] = [];
  const clusterSources = new Map<string, Set<string>>();
  for (const p of selected) {
    const m = findCluster(p.norm, [...batchRefs, ...recent], cfg.news.similarity);
    if (m) {
      // duplicate story: remember the extra publisher, record it, and check pending corroborations
      const set = clusterSources.get(m.cluster_id) ?? new Set<string>();
      set.add(p.source);
      clusterSources.set(m.cluster_id, set);
      newsRows.push(toNewsRow(p, m.cluster_id, false, 'NONE', 'duplicate', { duplicateOf: m.id }));
      const w = watch[m.cluster_id];
      if (w) {
        if (!w.sources.includes(p.source)) w.sources.push(p.source);
        watchChanged = true;
        if (w.sources.length >= 2) {
          emit(ctx, {
            dedupeKey: `news:${m.cluster_id}:WORLD_ENDING`, kind: 'news', severity: 'WORLD_ENDING', headline: w.headline,
            what: `${w.reason} Now corroborated by ${w.sources.slice(0, 3).join(', ')}.`,
            impact: `${w.assets.map((a) => `${a} ${ARROW[w.dir[a] ?? 'mixed']}`).join(', ') || 'broad risk assets'} (likely direction, not a forecast)`,
            source: w.sources.join(' + '), sourceTime: w.published, assetIds: w.assets, payload: { cluster: m.cluster_id, escalation: true },
          }, 'pending', 'escalated: second publisher corroborated');
          delete watch[m.cluster_id];
        }
      }
      continue;
    }
    const cluster = p.id;
    batchRefs.push({ id: p.id, cluster_id: cluster, title_norm: p.norm, source: p.source });
    fresh.push({ ...p, cluster, sources: new Set([p.source]) });
  }

  // ---- score: LLM chain in batches, keyword fallback
  let usage = ctx.kv.llm as LlmUsage | undefined;
  const scored = new Map<string, { s: ScoredHeadline; scorer: string }>();
  for (let i = 0; i < fresh.length; i += cfg.news.batchSize) {
    const batch = fresh.slice(i, i + cfg.news.batchSize);
    const items: HeadlineIn[] = batch.map((b) => ({ id: b.id, title: b.title, source: b.source, summary: b.item.summary }));
    const run = await scoreBatch(items, cfg.assets.map((a) => a.id), cfg, ctx.env, usage, now, { fetch: ctx.fetch, budget: ctx.budget });
    usage = run.usage;
    if (run.errors.length) ctx.notes.push(`llm: ${run.errors.join('; ')}`);
    for (const b of batch) {
      const llm = run.results.get(b.id);
      if (llm) scored.set(b.id, { s: llm, scorer: run.provider ?? 'llm' });
      else scored.set(b.id, { s: scoreByKeywords(b.title, b.item.summary), scorer: 'keywords' });
    }
    if (run.exhausted && usage && usage.exhaustedNotifiedDay !== usage.day) {
      usage = { ...usage, exhaustedNotifiedDay: usage.day };
      systemAlert(ctx, 'llm-exhausted', 'LLM quota exhausted', 'Every free LLM provider is capped or rate-limited right now. Headlines are scored by keywords only (more conservative) until quotas reset.', { bucketMin: 720 });
    }
  }
  if (usage) {
    const pct = llmUsagePct(usage, cfg, ctx.env);
    if (pct >= cfg.health.llmWarnAtPct && usage.warnedDay !== usage.day) {
      usage = { ...usage, warnedDay: usage.day };
      systemAlert(ctx, 'llm-warn', 'LLM daily quota almost used', `The LLM chain has used ${pct.toFixed(0)}% of today's self-imposed caps. Keyword fallback takes over when it runs out.`, { bucketMin: 720 });
    }
    setKv(ctx, 'llm', usage);
  }

  // ---- route
  const hour = new Date(now).toISOString().slice(0, 13);
  let burst = ctx.kv.news_burst?.hour === hour ? ctx.kv.news_burst.n : 0;
  for (const p of fresh) {
    const { s, scorer } = scored.get(p.id)!;
    newsRows.push(toNewsRow(p, p.cluster, s.is_market_moving, s.severity, scorer, { ...s }));
    if (s.severity === 'NONE') continue;
    const ageMin = p.item.published ? (now - p.item.published) / 60000 : null;
    const route = routeNews({ severity: s.severity, trust: p.feed.trust, distinctSources: 1, ageMin, mediumThisHour: burst }, cfg);
    if (route.status === 'ignore') continue;
    const cand: AlertCandidate = {
      dedupeKey: `news:${p.cluster}:${route.severity}`, kind: 'news', severity: route.severity,
      headline: p.title,
      what: `${s.one_line_reason}${p.source ? ` (${p.source})` : ''}`,
      impact: impactLine(ctx, s), source: p.source, sourceTime: p.item.published ?? now, assetIds: s.affected_assets,
      payload: { cluster: p.cluster, scorer, url: p.item.link || undefined },
    };
    emit(ctx, cand, route.status, route.reason);
    if (route.status === 'pending' && route.severity === 'MEDIUM') burst++;
    if (route.awaitingCorroboration) {
      watch[p.cluster] = { sources: [p.source], headline: p.title, reason: s.one_line_reason, assets: s.affected_assets, dir: s.likely_direction, at: now, published: p.item.published ?? now };
      watchChanged = true;
    }
  }
  if (burst !== (ctx.kv.news_burst?.hour === hour ? ctx.kv.news_burst.n : 0)) setKv(ctx, 'news_burst', { hour, n: burst });
  if (watchChanged) setKv(ctx, 'watch_clusters', watch);
  return { feedStates, newsRows };
}

function toNewsRow(p: Pooled, cluster: string, moving: boolean, sev: Severity | 'NONE', scorer: string, score: Record<string, unknown>): NewsRow {
  return {
    id: p.id, published_at: p.item.published ? new Date(p.item.published).toISOString() : null, source: p.source, feed_id: p.feed.id,
    title: p.title, title_norm: p.norm, url: p.item.link ? p.item.link.slice(0, 500) : null, cluster_id: cluster,
    is_market_moving: moving, severity: sev, scorer, score,
  };
}
