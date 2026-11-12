import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { deliver, type DeliverItem, type WaState } from '../src/notify/router';
import { ENV, mkFetch, noSleep, TG, tgOk, textOf, WA, waOk } from './helpers';

const NOW = Date.parse('2026-11-13T09:02:00Z');
const item = (id: string, severity: DeliverItem['severity'], extra: Partial<DeliverItem> = {}): DeliverItem => ({
  id, severity, ...extra,
  msg: { severity, headline: `headline ${id}`, what: 'what', impact: 'impact', source: 'src', sourceTime: NOW },
});
const run = (items: DeliverItem[], routes: Parameters<typeof mkFetch>[0], wa: WaState = { fails: 0, down: false }) => {
  const f = mkFetch(routes);
  return deliver(items, ENV, config, wa, { fetch: f.fetch, sleepFn: noSleep, now: () => NOW }).then((r) => ({ r, f }));
};

describe('delivery: WhatsApp primary, Telegram failover', () => {
  it('MEDIUM goes to WhatsApp only when WhatsApp works', async () => {
    const { r, f } = await run([item('a', 'MEDIUM')], [[WA, waOk], [TG, tgOk]]);
    expect(f.count(WA)).toBe(1); expect(f.count(TG)).toBe(0);
    expect(r.outcomes[0]).toMatchObject({ id: 'a', status: 'sent', channels: ['whatsapp'] });
  });

  it('retries WhatsApp with backoff, then sends the same alert to Telegram with a failure note', async () => {
    const { r, f } = await run([item('a', 'MEDIUM')], [[WA, () => new Response('boom', { status: 500 })], [TG, tgOk]]);
    expect(f.count(WA)).toBe(config.channels.retries);
    expect(f.count(TG)).toBe(1);
    const tg = textOf(f.calls.find((c) => TG.test(c.url))!);
    expect(tg.startsWith('⚠️ WhatsApp delivery failed')).toBe(true);
    expect(tg).toContain('headline a');
    expect(r.outcomes[0]).toMatchObject({ status: 'sent', channels: ['telegram'] });
    expect(r.outcomes[0].attempts.filter((a) => a.channel === 'whatsapp' && !a.ok)).toHaveLength(config.channels.retries);
  });

  it('treats a CallMeBot error body (HTTP 200) as a failure', async () => {
    const { r, f } = await run([item('a', 'MEDIUM')], [[WA, () => 'ERROR: apikey is invalid'], [TG, tgOk]]);
    expect(f.count(TG)).toBe(1);
    expect(r.outcomes[0].channels).toEqual(['telegram']);
  });

  it('retries a timeout/network error too', async () => {
    let n = 0;
    const { r, f } = await run([item('a', 'MEDIUM')], [[WA, () => { if (++n < 3) throw new Error('network down'); return waOk(); }], [TG, tgOk]]);
    expect(f.count(WA)).toBe(3); expect(f.count(TG)).toBe(0);
    expect(r.outcomes[0]).toMatchObject({ status: 'sent', channels: ['whatsapp'] });
  });

  it('HIGH and WORLD-ENDING always go to BOTH channels, without waiting for a failure', async () => {
    for (const sev of ['HIGH', 'WORLD_ENDING'] as const) {
      const { r, f } = await run([item('a', sev)], [[WA, waOk], [TG, tgOk]]);
      expect(f.count(WA)).toBe(1); expect(f.count(TG)).toBe(1);
      expect(r.outcomes[0].channels.sort()).toEqual(['telegram', 'whatsapp']);
      expect(textOf(f.calls.find((c) => TG.test(c.url))!)).not.toContain('delivery failed');
    }
  });

  it('HIGH is still delivered via Telegram when WhatsApp is down', async () => {
    const { r } = await run([item('a', 'HIGH')], [[WA, () => new Response('x', { status: 503 })], [TG, tgOk]]);
    expect(r.outcomes[0]).toMatchObject({ status: 'sent', channels: ['telegram'] });
  });

  it('never drops an alert when every channel fails: stays pending, then is marked failed after many rounds', async () => {
    const down: Parameters<typeof mkFetch>[0] = [[WA, () => new Response('x', { status: 500 })], [TG, () => new Response('x', { status: 500 })]];
    expect((await run([item('a', 'MEDIUM')], down)).r.outcomes[0].status).toBe('pending');
    expect((await run([item('a', 'MEDIUM', { priorAttempts: 11 })], down)).r.outcomes[0].status).toBe('failed');
  });

  it('merges same-minute alerts into ONE WhatsApp message', async () => {
    const { r, f } = await run([item('a', 'MEDIUM'), item('b', 'MEDIUM'), item('c', 'MEDIUM')], [[WA, waOk], [TG, tgOk]]);
    expect(f.count(WA)).toBe(1);
    expect(textOf(f.calls[0])).toContain('3 alerts');
    expect(r.outcomes.every((o) => o.status === 'sent')).toBe(true);
  });

  it('respects the per-minute message cap: extra alerts stay queued', async () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`m${i}`, 'MEDIUM'));
    const { r, f } = await run(many, [[WA, waOk], [TG, tgOk]]);
    expect(f.count(WA)).toBeLessThanOrEqual(config.channels.maxMessagesPerRun);
    expect(r.outcomes).toHaveLength(30);
    expect(r.outcomes.filter((o) => o.status === 'pending').length).toBeGreaterThan(0);
    expect(r.outcomes.filter((o) => o.status === 'sent').length + r.outcomes.filter((o) => o.status === 'pending').length).toBe(30);
  });

  it('forceBoth (system alerts) uses both channels even at MEDIUM', async () => {
    const { f } = await run([item('s', 'MEDIUM', { forceBoth: true })], [[WA, waOk], [TG, tgOk]]);
    expect(f.count(WA)).toBe(1); expect(f.count(TG)).toBe(1);
  });
});

describe('WhatsApp health notices', () => {
  const failWa: Parameters<typeof mkFetch>[0] = [[WA, () => new Response('x', { status: 500 })], [TG, tgOk]];

  it('sends ONE "looks down" note after N consecutive failures, not on every alert', async () => {
    let wa: WaState = { fails: 0, down: false };
    const notes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { r, f } = await run([item(`a${i}`, 'MEDIUM')], failWa, wa);
      wa = r.wa;
      notes.push(f.calls.filter((c) => TG.test(c.url) && textOf(c).includes('looks down')).length);
    }
    expect(notes.reduce((a, b) => a + b, 0)).toBe(1);
    expect(notes[config.channels.whatsappDownAfter - 1]).toBe(1);
    expect(wa.down).toBe(true);
  });

  it('sends ONE recovery note when WhatsApp works again', async () => {
    const { r, f } = await run([item('a', 'MEDIUM')], [[WA, waOk], [TG, tgOk]], { fails: 5, down: true });
    expect(r.wa).toEqual({ fails: 0, down: false });
    expect(f.calls.filter((c) => TG.test(c.url) && textOf(c).includes('recovered'))).toHaveLength(1);
    const again = await run([item('b', 'MEDIUM')], [[WA, waOk], [TG, tgOk]], r.wa);
    expect(again.f.count(TG)).toBe(0);
  });
});

describe('Telegram-only mode (WhatsApp not configured, e.g. CallMeBot bot full)', () => {
  const NO_WA = { ...ENV, CALLMEBOT_PHONE: '', CALLMEBOT_APIKEY: '' };
  const runNoWa = (items: DeliverItem[]) => {
    const f = mkFetch([[WA, waOk], [TG, tgOk]]);
    return deliver(items, NO_WA, config, { fails: 0, down: false }, { fetch: f.fetch, sleepFn: noSleep, now: () => NOW }).then((r) => ({ r, f }));
  };
  it('never touches WhatsApp and adds no failover prefix or down notices', async () => {
    const { r, f } = await runNoWa([item('a', 'MEDIUM'), item('b', 'HIGH'), item('c', 'WORLD_ENDING')]);
    expect(f.count(WA)).toBe(0);
    expect(f.count(TG)).toBe(1); // merged into one message
    const text = textOf(f.calls[0]);
    expect(text).not.toContain('WhatsApp');
    expect(text).toContain('3 alerts');
    expect(r.outcomes.every((o) => o.status === 'sent' && o.channels.join() === 'telegram')).toBe(true);
    expect(r.waChanged).toBe(false);
    expect(r.wa).toEqual({ fails: 0, down: false });
  });
  it('a Telegram failure keeps the alert pending for retry', async () => {
    const f = mkFetch([[TG, () => new Response('x', { status: 500 })]]);
    const r = await deliver([item('a', 'MEDIUM')], NO_WA, config, { fails: 0, down: false }, { fetch: f.fetch, sleepFn: noSleep, now: () => NOW });
    expect(r.outcomes[0].status).toBe('pending');
  });
});
