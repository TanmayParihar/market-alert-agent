import { config } from '../../agent.config';
import { SupabaseStore } from '../db/supabase';
import { fetchPrices } from '../providers/prices';
import { Budget } from '../util/http';
import type { Env } from '../types';
import { runTick } from './tick';
import { sendSamples } from '../notify/samples';
import { request } from '../util/http';
import { parseFeed } from '../providers/rss';

// Minimal Workers types (kept local so the repo type-checks with plain @types/node)
interface ScheduledEvent { scheduledTime: number; cron: string }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void }

export default {
  /** Fast path: runs every minute (cron "* * * * *"). */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowMs = Math.floor((event.scheduledTime || Date.now()) / 60000) * 60000;
    // ONE budget shared by every outbound call, Supabase included: 47 of the free plan's 50 subrequests,
    // 12 of which are reserved for state writes and message delivery so optional polling can never starve them.
    const budget = new Budget(47, 12);
    const store = new SupabaseStore(env, { budget });
    const s = await runTick({ env, cfg: config, store, nowMs, budget });
    // one compact log line per run (Workers free plan: 200k log events/day; this uses 1,440)
    console.log(JSON.stringify({ ok: s.ok, ms: s.ms, sub: s.subrequests, created: s.created, sent: s.sent, pending: s.pendingLeft, errs: s.errors, notes: s.notes.slice(0, 4) }));
    void ctx;
  },

  /** Admin endpoints. /health is public and minimal; /test and /probe need ?token=ADMIN_TOKEN. */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') {
      try {
        const hb = (await new SupabaseStore(env).loadTickState(Date.now())).kv.heartbeat;
        return json({ ok: !!hb && Date.now() - hb.at < config.health.workerStaleMinutes * 60_000, lastRunAgoSec: hb ? Math.round((Date.now() - hb.at) / 1000) : null });
      } catch {
        return json({ ok: false }, 503);
      }
    }
    const authed = !!env.ADMIN_TOKEN && url.searchParams.get('token') === env.ADMIN_TOKEN;
    if (!authed) return new Response('not found', { status: 404 });
    if (url.pathname === '/test') {
      // one sample alert of each severity through the real channels (use ?dry=1 to only print to logs)
      const r = await sendSamples(env, config, { dryRun: url.searchParams.get('dry') === '1' });
      return json(r);
    }
    if (url.pathname === '/probe') {
      // calls EVERY price provider once from Cloudflare's network (shows which sources work from here)
      const budget = new Budget(48, 0);
      const pr = await fetchPrices(config, Date.now(), { budget, timeoutMs: 7000 }, { totalDue: true, probeAll: true });
      return json({ status: pr.status, got: [...pr.snaps.values()].map((s) => ({ id: s.id, price: s.price, src: s.source, ageSec: Math.round(Date.now() / 1000 - s.ts) })), missing: pr.missing, subrequests: budget.used });
    }
    if (url.pathname === '/feeds') {
      // polls every news feed once FROM Cloudflare's network: status, latency, items (find throttled/blocked feeds)
      const out = await Promise.all(config.news.feeds.map(async (f) => {
        const t0 = Date.now();
        try {
          const { text } = await request(f.url, { timeoutMs: 15000, maxBytes: 300_000 });
          return { id: f.id, ok: true, ms: Date.now() - t0, items: parseFeed(text, 15).length };
        } catch (e) {
          return { id: f.id, ok: false, ms: Date.now() - t0, error: String((e as Error).message).slice(0, 80) };
        }
      }));
      return json(out);
    }
    return new Response('not found', { status: 404 });
  },
};
