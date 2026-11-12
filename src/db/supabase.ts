import type { ApplyPayload, AssetState, Env, FeedState, MacroEventRow, NewsRow, Store, TickState } from '../types';
import { getJson, request, type Budget, type Fetcher } from '../util/http';

/**
 * Supabase over plain PostgREST (no SDK = no bundle weight / CPU). The Worker needs only two RPC round-trips per
 * minute: agent_tick_state (read everything) and agent_apply (one transaction of writes).
 * Secret keys (sb_secret_...) go in the `apikey` header only; legacy service_role JWTs also go in Authorization.
 */
export function supabaseHeaders(key: string): Record<string, string> {
  // Supabase answers 401 "Forbidden use of secret API key in browser" when the User-Agent looks like a browser
  // (anything starting with "Mozilla"), so server calls must identify themselves plainly.
  const h: Record<string, string> = { apikey: key, 'content-type': 'application/json', 'user-agent': 'market-alert-agent/1.0' };
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
  return h;
}

export class SupabaseStore implements Store {
  constructor(private env: Env, private io: { fetch?: Fetcher; budget?: Budget } = {}) {}

  private base() { return this.env.SUPABASE_URL.replace(/\/$/, ''); }

  async rpc<T = any>(fn: string, body: unknown): Promise<T> {
    const { text } = await request(`${this.base()}/rest/v1/rpc/${fn}`, {
      fetch: this.io.fetch, budget: this.io.budget, priority: true, timeoutMs: 8000, method: 'POST',
      headers: supabaseHeaders(this.env.SUPABASE_SERVICE_KEY), body: JSON.stringify(body),
    });
    return text ? JSON.parse(text) : (null as T);
  }

  async select<T = any>(path: string): Promise<T[]> {
    return getJson<T[]>(`${this.base()}/rest/v1/${path}`, {
      fetch: this.io.fetch, budget: this.io.budget, priority: true, timeoutMs: 8000, headers: supabaseHeaders(this.env.SUPABASE_SERVICE_KEY),
    });
  }

  async loadTickState(nowMs: number): Promise<TickState> {
    const r = await this.rpc('agent_tick_state', { p_now: new Date(nowMs).toISOString() });
    const assets: Record<string, AssetState> = {};
    for (const a of r.assets ?? []) assets[a.asset_id] = { ...a, ring: a.ring ?? [], last_alert: a.last_alert ?? null };
    const feeds: Record<string, FeedState> = {};
    for (const f of r.feeds ?? []) feeds[f.feed_id] = { ...f, seen: f.seen ?? [] };
    return {
      assets, feeds, kv: r.kv ?? {}, pending: r.pending ?? [], events: (r.events ?? []) as MacroEventRow[],
      eventCount48h: Number(r.event_count_48h ?? 0),
    };
  }

  async apply(p: ApplyPayload): Promise<{ inserted: string[] }> {
    const r = await this.rpc('agent_apply', { p });
    return { inserted: r?.inserted ?? [] };
  }

  async recentNews(sinceMs: number) {
    const since = new Date(sinceMs).toISOString();
    return this.select<Pick<NewsRow, 'id' | 'cluster_id' | 'title_norm' | 'source' | 'severity'>>(
      `news_items?select=id,cluster_id,title_norm,source,severity&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=400`,
    );
  }

  /** Generic helper for the GitHub scripts. */
  async query<T = any>(path: string): Promise<T[]> { return this.select<T>(path); }
}
