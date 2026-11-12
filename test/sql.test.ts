import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Runs the real schema.sql (tables + agent_tick_state / agent_apply / agent_prune) in an in-process Postgres.
let db: PGlite;
const apply = async (p: unknown) => (await db.query<{ r: any }>('select public.agent_apply($1::jsonb) as r', [JSON.stringify(p)])).rows[0].r;
const state = async () => (await db.query<{ r: any }>('select public.agent_tick_state(now()) as r')).rows[0].r;
const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const alert = (id: string, key: string, extra: Record<string, unknown> = {}) => ({
  id, dedupe_key: key, kind: 'price', severity: 'HIGH', status: 'pending', reason: null, headline: 'h', what: 'w', impact: 'i', source: 's',
  source_time: new Date().toISOString(), asset_ids: ['SPX', 'NDX'], payload: { a: 1 }, ...extra,
});

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync('sql/schema.sql', 'utf8'));
});

describe('schema.sql', () => {
  it('can be re-run safely (idempotent)', async () => {
    await db.exec(readFileSync('sql/schema.sql', 'utf8'));
  });

  it('inserts alerts and reports only NEW ids (dedupe_key is unique => no duplicate delivery)', async () => {
    const r1 = await apply({ alerts_insert: [alert(ID1, 'k1')] });
    expect(r1.inserted).toEqual([ID1]);
    const r2 = await apply({ alerts_insert: [alert(ID2, 'k1'), alert(ID2, 'k2')] });
    expect(r2.inserted).toEqual([ID2]); // 'k1' duplicate ignored, 'k2' new
    const rows = (await db.query('select id, asset_ids from public.alerts order by dedupe_key')).rows as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].asset_ids).toEqual(['SPX', 'NDX']);
  });

  it('agent_tick_state returns pending alerts, kv and assets in ONE call', async () => {
    await apply({ kv: { heartbeat: { at: 123 } }, assets: [{ asset_id: 'SPX', last_price: 7400.5, prev_close: 7600, last_ts: 1790000000, source: 'Yahoo Finance', ring: [[1790000000, 7400.5]], last_alert: null }] });
    const s = await state();
    expect(s.pending.map((p: any) => p.id).sort()).toEqual([ID1, ID2]);
    expect(s.kv.heartbeat).toEqual({ at: 123 });
    expect(s.assets[0]).toMatchObject({ asset_id: 'SPX', last_price: 7400.5, last_alert: null });
    expect(s.assets[0].ring).toEqual([[1790000000, 7400.5]]);
  });

  it('stores last_alert objects and replaces them', async () => {
    await apply({ assets: [{ asset_id: 'SPX', last_price: 1, prev_close: 1, last_ts: 1, source: 'x', ring: [], last_alert: { severity: 'HIGH', at: 5, pct: -4, window: 'session' } }] });
    expect((await state()).assets[0].last_alert).toEqual({ severity: 'HIGH', at: 5, pct: -4, window: 'session' });
  });

  it('records delivery outcome: status, channels, appended attempt log', async () => {
    const att = [{ channel: 'whatsapp', ok: false, at: 'x', attempt: 1 }, { channel: 'telegram', ok: true, at: 'x', attempt: 1 }];
    await apply({ alerts_update: [{ id: ID1, status: 'sent', channels: ['telegram'], delivery: att, attempts_inc: 1, sent_at: new Date().toISOString() }] });
    await apply({ alerts_update: [{ id: ID1, status: 'sent', delivery: [{ channel: 'x', ok: true, at: 'y', attempt: 9 }] }] });
    const row = (await db.query('select status, channels, delivery, attempts, sent_at from public.alerts where id = $1', [ID1])).rows[0] as any;
    expect(row).toMatchObject({ status: 'sent', channels: ['telegram'], attempts: 1 });
    expect(row.delivery).toHaveLength(3);
    expect(row.sent_at).toBeTruthy();
    expect((await state()).pending.map((p: any) => p.id)).toEqual([ID2]); // sent alerts are no longer pending
  });

  it('news items are insert-once; feeds upsert', async () => {
    const n = { id: 'n1', published_at: null, source: 'BBC', feed_id: 'bbc', title: 't', title_norm: 't', url: null, cluster_id: 'n1', is_market_moving: true, severity: 'HIGH', scorer: 'keywords', score: { a: 1 } };
    await apply({ news_items: [n, n], feeds: [{ feed_id: 'bbc', seen: ['a', 'b'], last_ok: new Date().toISOString(), last_err: null, fails: 0 }] });
    await apply({ feeds: [{ feed_id: 'bbc', seen: ['c'], last_ok: null, last_err: 'boom', fails: 2 }] });
    expect((await db.query('select count(*)::int as c from public.news_items')).rows[0]).toEqual({ c: 1 });
    expect((await state()).feeds[0]).toMatchObject({ feed_id: 'bbc', seen: ['c'], fails: 2, last_err: 'boom' });
  });

  it('calendar refresh never overwrites actual / status / attempts of a macro event', async () => {
    const ev = { id: 'ev1', source: 'faireconomy', title: 'CPI m/m', country: 'USD', impact: 'High', event_time: new Date(Date.now() + 20 * 60_000).toISOString(), forecast: '0.3%', previous: '0.6%', watch: true, approx: false, resolver: { type: 'bls' } };
    await apply({ events_upsert: [ev] });
    await apply({ events: [{ id: 'ev1', status: 'result_sent', actual: '0.4%', attempts: 3 }] });
    await apply({ events_upsert: [{ ...ev, forecast: '0.2%' }] });
    const row = (await db.query('select forecast, actual, status, attempts, watch, resolver from public.macro_events where id = $1', ['ev1'])).rows[0] as any;
    expect(row).toMatchObject({ forecast: '0.2%', actual: '0.4%', status: 'result_sent', attempts: 3, watch: true, resolver: { type: 'bls' } });
  });

  it('tick_state only returns events in the poll window that are not finished', async () => {
    await apply({ events_upsert: [
      { id: 'soon', source: 'config', title: 'A', country: 'USD', impact: 'High', event_time: new Date(Date.now() + 10 * 60_000).toISOString(), watch: true },
      { id: 'far', source: 'config', title: 'B', country: 'USD', impact: 'High', event_time: new Date(Date.now() + 5 * 3600_000).toISOString(), watch: true },
    ] });
    const s = await state();
    const ids = s.events.map((e: any) => e.id);
    expect(ids).toContain('soon'); expect(ids).not.toContain('far'); expect(ids).not.toContain('ev1');
    expect(s.event_count_48h).toBeGreaterThanOrEqual(3);
  });

  it('pending alerts older than 6 h are marked failed instead of retried forever', async () => {
    await apply({ alerts_insert: [alert('33333333-3333-3333-3333-333333333333', 'old')] });
    await db.query("update public.alerts set created_at = now() - interval '7 hours' where dedupe_key = 'old'");
    await state();
    expect((await db.query("select status from public.alerts where dedupe_key = 'old'")).rows[0]).toEqual({ status: 'failed' });
  });

  it('agent_prune runs and enforces the check constraints', async () => {
    expect((await db.query<{ r: any }>('select public.agent_prune() as r')).rows[0].r).toHaveProperty('news_items');
    await expect(apply({ alerts_insert: [alert('44444444-4444-4444-4444-444444444444', 'bad', { severity: 'CATASTROPHIC' })] })).rejects.toThrow();
  });

  it('every table has row level security enabled (public key can read nothing)', async () => {
    const rows = (await db.query("select relname, relrowsecurity from pg_class where relname in ('alerts','asset_state','feed_state','news_items','macro_events','kv')")).rows as any[];
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true);
  });
});
