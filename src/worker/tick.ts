import type { AlertCandidate, AlertRow, AlertUpdate, AssetState, AgentConfig, Env, MacroEventRow, Store, TickState } from '../types';
import { decideCooldown } from '../core/cooldown';
import { buildPriceCandidate, evaluatePrice, type PriceHit } from '../core/priceTriggers';
import { rank } from '../core/severity';
import { sigmaFor } from '../core/thresholds';
import { confirms, fetchPrices, fetchSecondary } from '../providers/prices';
import { deliver, type DeliverItem, type WaState } from '../notify/router';
import type { ChannelIO } from '../notify/channels';
import { Budget, errMsg, type Fetcher } from '../util/http';
import { emit, emitSuppressed, setKv, type Ctx } from './ctx';
import { trackSource } from './health';
import { runNews } from './news';
import { runMacro } from './macro';
import { runCryptoSignals } from './cryptoSignals';
import { runGithub } from './github';

export interface TickDeps {
  env: Env;
  cfg: AgentConfig;
  store: Store;
  nowMs: number;
  fetch?: Fetcher;
  io?: Pick<ChannelIO, 'dryRun' | 'log' | 'sleepFn'>;
  budget?: Budget;
}

export interface TickSummary {
  ok: boolean;
  ms: number;
  subrequests: number;
  created: number;
  sent: number;
  pendingLeft: number;
  errors: string[];
  notes: string[];
  rows: AlertRow[];
}

const ASSET_CONFIRM_MAX = 2;

/** One minute of work. Each section is isolated: an exception in one never stops the others. */
export async function runTick(d: TickDeps): Promise<TickSummary> {
  const t0 = Date.now();
  const budget = d.budget ?? new Budget(48, 12);
  const errors: string[] = [];
  const notes: string[] = [];
  const empty = (): TickSummary => ({ ok: false, ms: Date.now() - t0, subrequests: budget.used, created: 0, sent: 0, pendingLeft: 0, errors, notes, rows: [] });

  let state: TickState;
  try {
    state = await d.store.loadTickState(d.nowMs);
  } catch (e) {
    errors.push(`state: ${errMsg(e)}`);
    return empty(); // without state we cannot dedupe safely; the GitHub heartbeat notices a silent Worker
  }

  const ctx: Ctx = {
    env: d.env, cfg: d.cfg, store: d.store, now: d.nowMs, minute: Math.floor(d.nowMs / 60000), budget, fetch: d.fetch,
    o: { fetch: d.fetch, budget, timeoutMs: 7000 }, state, kv: { ...state.kv }, kvOut: {}, rows: [], errors, notes,
  };

  const assets: AssetState[] = [];
  const feeds: any[] = [];
  const newsRows: any[] = [];
  let eventUpdates: Array<Partial<MacroEventRow> & { id: string }> = [];

  // The sections run in a fixed order; subrequest budget is shared (prices first, then news, then extras).
  await section(ctx, 'prices', async () => { assets.push(...(await runPrices(ctx))); });
  await section(ctx, 'crypto', () => runCryptoSignals(ctx));
  await section(ctx, 'news', async () => {
    const r = await runNews(ctx);
    feeds.push(...r.feedStates);
    newsRows.push(...r.newsRows);
  });
  await section(ctx, 'macro', async () => { eventUpdates = await runMacro(ctx); });
  await section(ctx, 'github', () => runGithub(ctx));

  // ---- Phase 1: persist state + new alert rows FIRST (so nothing is lost if delivery crashes)
  setKv(ctx, 'heartbeat', { at: ctx.now, ms: Date.now() - t0, sub: budget.used, errs: errors.length, v: 1 });
  let inserted: Set<string>;
  try {
    const r = await d.store.apply({ assets, feeds, news_items: newsRows, alerts_insert: ctx.rows, events: eventUpdates, kv: ctx.kvOut });
    inserted = new Set(r.inserted);
  } catch (e) {
    errors.push(`apply: ${errMsg(e)}`);
    return { ...empty(), rows: ctx.rows };
  }

  // ---- Phase 2: deliver every pending alert (new + retries from earlier minutes)
  const fresh = ctx.rows.filter((r) => r.status === 'pending' && inserted.has(r.id));
  const retries = state.pending.filter((p) => !fresh.some((f) => f.id === p.id));
  const toSend: DeliverItem[] = [...retries, ...fresh].map((r) => toDeliverItem(r));
  let sent = 0;
  let pendingLeft = 0;
  if (toSend.length) {
    const dry = d.env.DRY_RUN === '1' || d.io?.dryRun === true;
    const waState: WaState = ctx.kv.wa_state ?? { fails: 0, down: false };
    const res = await deliver(toSend, d.env, d.cfg, waState, { fetch: d.fetch, budget, dryRun: dry, log: d.io?.log, sleepFn: d.io?.sleepFn });
    const nowIso = new Date(ctx.now).toISOString();
    const updates: AlertUpdate[] = res.outcomes.map((o) => ({
      id: o.id, status: o.status, reason: o.reason ?? null, channels: dry && o.status === 'sent' ? ['dry-run'] : o.channels,
      delivery: o.attempts, attempts_inc: o.attempts.length ? 1 : 0, sent_at: o.status === 'sent' ? nowIso : null,
    }));
    sent = updates.filter((u) => u.status === 'sent').length;
    pendingLeft = updates.filter((u) => u.status === 'pending').length;
    try {
      await d.store.apply({ alerts_update: updates, kv: res.waChanged ? { wa_state: res.wa } : {} });
    } catch (e) {
      errors.push(`apply2: ${errMsg(e)}`);
    }
  }

  return {
    ok: !errors.some((e) => e.startsWith('state') || e.startsWith('apply')), ms: Date.now() - t0, subrequests: budget.used, created: inserted.size, sent,
    pendingLeft, errors, notes, rows: ctx.rows,
  };
}

async function section(ctx: Ctx, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    ctx.errors.push(`${name}: ${errMsg(e)}`);
  }
}

export function toDeliverItem(r: Pick<AlertRow, 'id' | 'severity' | 'headline' | 'what' | 'impact' | 'source' | 'source_time' | 'payload' | 'attempts'>): DeliverItem {
  const p = (r.payload ?? {}) as { forceBoth?: boolean; marker?: string };
  return {
    id: r.id, severity: r.severity, forceBoth: p.forceBoth === true, priorAttempts: r.attempts ?? 0,
    msg: { severity: r.severity, headline: r.headline, what: r.what, impact: r.impact, source: r.source, sourceTime: r.source_time ? Date.parse(r.source_time) : null, marker: p.marker },
  };
}

// -------------------------------------------------------------------------------------------------------------
// Prices
// -------------------------------------------------------------------------------------------------------------
async function runPrices(ctx: Ctx): Promise<AssetState[]> {
  const { cfg, now } = ctx;
  const totalDue = ctx.minute % cfg.crypto.totalMarketEveryMin === 0;
  const pr = await fetchPrices(cfg, now, ctx.o, { totalDue });
  const th = cfg.health.sourceFailAfter;
  for (const [name, s] of Object.entries(pr.status)) trackSource(ctx, `price:${name}`, `Price source ${name}`, s.ok, s.err, th);
  if (pr.missing.length) ctx.notes.push(`no price from any source: ${pr.missing.join(',')}`);

  const out: AssetState[] = [];
  let confirmsUsed = 0;
  for (const asset of cfg.assets) {
    const snap = pr.snaps.get(asset.id);
    if (!snap) continue;
    const st = ctx.state.assets[asset.id];
    const ev = evaluatePrice(asset, snap, st, now, cfg);
    out.push({
      asset_id: asset.id,
      last_price: ev.stale ? st?.last_price ?? snap.price : snap.price,
      prev_close: snap.prevClose ?? st?.prev_close ?? null,
      last_ts: snap.ts, source: snap.source, ring: ev.ring, last_alert: st?.last_alert ?? null,
    });
    if (ev.stale || !ev.hit) continue;

    let hit: PriceHit = ev.hit;
    let note = '';
    // cross-check big moves with an independent source; downgrade if it does not agree
    if (rank(hit.severity) >= rank(cfg.confirmFrom) && confirmsUsed < ASSET_CONFIRM_MAX) {
      confirmsUsed++;
      const sec = await fetchSecondary(asset, snap.source, Math.floor(now / 1000), ctx.o).catch(() => null);
      if (!sec) note = ' Single data source (could not cross-check).';
      else if (hit.window !== 'level' && !confirms(ev.moves.session ?? hit.pct, sec)) {
        hit = { ...hit, severity: 'MEDIUM' };
        note = ` NOT confirmed by ${sec.source} (treat with care).`;
      } else note = ` Confirmed by ${sec.source}.`;
    }

    const cand = buildPriceCandidate(asset, snap, ev, hit, now, note);
    const sigmaDaily = sigmaFor(asset, cfg.windows.find((w) => w.id === 'session')!);
    const d = decideCooldown({
      severity: hit.severity, window: hit.window, pct: hit.pct, nowMs: now, last: st?.last_alert ?? null,
      cooldownMin: cfg.cooldownMin, sigmaDaily, extensionSigma: cfg.sessionExtensionSigma,
    });
    const last = out[out.length - 1];
    if (!d.allow) {
      if (hit.severity !== 'LOW') emitSuppressed(ctx, cand, d.reason);
      continue;
    }
    last.last_alert = { severity: hit.severity, at: now, pct: hit.pct, window: hit.window };
    emit(ctx, cand, hit.severity === 'LOW' ? 'digest_pending' : 'pending', hit.severity === 'LOW' ? 'LOW: collected for the next digest' : d.reason === 'escalation' ? 'escalation broke through cooldown' : null);
  }
  return out;
}

export type { AlertCandidate };
