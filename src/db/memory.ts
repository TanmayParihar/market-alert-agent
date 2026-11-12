import type { AlertRow, ApplyPayload, AssetState, FeedState, MacroEventRow, NewsRow, Store, TickState } from '../types';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** In-memory Store used by `npm run dry-run` and the tests. Mirrors agent_apply semantics. */
export class MemoryStore implements Store {
  assets: Record<string, AssetState> = {};
  feeds: Record<string, FeedState> = {};
  kv: Record<string, any> = {};
  alerts: Array<AlertRow & { status: string; channels?: string[] }> = [];
  news: NewsRow[] = [];
  events: Record<string, MacroEventRow> = {};
  applyCalls = 0;

  async loadTickState(nowMs: number): Promise<TickState> {
    return {
      assets: clone(this.assets), feeds: clone(this.feeds), kv: clone(this.kv),
      pending: this.alerts.filter((a) => a.status === 'pending').slice(0, 30).map((a) => clone(a)),
      events: Object.values(this.events).filter(
        (e) => (e.status === 'scheduled' || e.status === 'headsup_sent') && Date.parse(e.event_time) > nowMs - 45 * 60_000 && Date.parse(e.event_time) < nowMs + 75 * 60_000,
      ).map((e) => clone(e)),
      eventCount48h: Object.values(this.events).filter((e) => Date.parse(e.event_time) > nowMs && Date.parse(e.event_time) < nowMs + 48 * 3600_000).length,
    };
  }

  async apply(p: ApplyPayload): Promise<{ inserted: string[] }> {
    this.applyCalls++;
    for (const a of p.assets ?? []) this.assets[a.asset_id] = clone(a);
    for (const f of p.feeds ?? []) this.feeds[f.feed_id] = clone(f);
    for (const n of p.news_items ?? []) if (!this.news.some((x) => x.id === n.id)) this.news.push(clone(n));
    const inserted: string[] = [];
    for (const a of p.alerts_insert ?? []) {
      if (this.alerts.some((x) => x.dedupe_key === a.dedupe_key)) continue;
      this.alerts.push({ ...clone(a), attempts: 0, delivery: [] });
      inserted.push(a.id);
    }
    for (const u of p.alerts_update ?? []) {
      const a = this.alerts.find((x) => x.id === u.id);
      if (!a) continue;
      a.status = u.status;
      if (u.reason) a.reason = u.reason;
      if (u.channels) a.channels = u.channels;
      if (u.delivery) a.delivery = [...(a.delivery ?? []), ...u.delivery];
      a.attempts = (a.attempts ?? 0) + (u.attempts_inc ?? 0);
    }
    for (const e of p.events_upsert ?? []) this.events[e.id] = { ...(this.events[e.id] ?? {}), ...clone(e), actual: this.events[e.id]?.actual ?? e.actual, status: this.events[e.id]?.status ?? e.status };
    for (const u of p.events ?? []) if (this.events[u.id]) Object.assign(this.events[u.id], u);
    for (const [k, v] of Object.entries(p.kv ?? {})) this.kv[k] = clone(v);
    return { inserted };
  }

  async recentNews(sinceMs: number) {
    return this.news.filter((n) => !n.published_at || Date.parse(n.published_at) > sinceMs - 3600_000 * 3).map((n) => ({
      id: n.id, cluster_id: n.cluster_id, title_norm: n.title_norm, source: n.source, severity: n.severity,
    }));
  }
}
