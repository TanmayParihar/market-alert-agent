import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { mergeSamples, pctChange, refPrice } from '../src/core/samples';
import { evaluatePrice } from '../src/core/priceTriggers';
import type { AssetState, Sample, Snapshot } from '../src/types';
import { parseYahooSpark, parseCnbc } from '../src/providers/quotes';
import { confirms } from '../src/providers/prices';
import { oiDropPct, summariseOkx, tierFor } from '../src/providers/crypto';

const NOW = Date.parse('2026-11-13T15:00:00Z');
const nowSec = NOW / 1000;
const asset = (id: string) => config.assets.find((a) => a.id === id)!;
const snap = (id: string, price: number, prev: number | null, ts = nowSec, extra: Partial<Snapshot> = {}): Snapshot => ({ id, price, prevClose: prev, ts, source: 'test', ...extra });
const st = (id: string, ring: Sample[] = [], last_price: number | null = null): AssetState => ({ asset_id: id, last_price, prev_close: null, last_ts: null, source: null, ring, last_alert: null });

describe('price history ring', () => {
  it('thins old samples and drops anything older than 75 minutes', () => {
    let ring: Sample[] = [];
    for (let m = 80; m >= 0; m--) ring = mergeSamples(ring, [[nowSec - m * 60, 100 + m]], nowSec - m * 60 + 0);
    ring = mergeSamples(ring, [], nowSec);
    expect(ring.every((s) => nowSec - s[0] <= 75 * 60)).toBe(true);
    expect(ring.length).toBeLessThan(40);
    const old = ring.filter((s) => nowSec - s[0] > 20 * 60);
    for (let i = 1; i < old.length; i++) expect(old[i][0] - old[i - 1][0]).toBeGreaterThanOrEqual(240);
  });

  it('finds the reference price for a window, and refuses stale references', () => {
    const ring: Sample[] = [[nowSec - 900, 100], [nowSec - 60, 101]];
    expect(refPrice(ring, nowSec, 900, 360)).toBe(100);
    expect(refPrice([[nowSec - 1500, 100]], nowSec, 900, 360)).toBeNull(); // 10 min too old => market closed / worker was down
    expect(refPrice([], nowSec, 900, 360)).toBeNull();
    expect(pctChange(101, 100)).toBeCloseTo(1);
  });
});

describe('price triggers', () => {
  it('session move of -2.9% on the S&P is MEDIUM', () => {
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 7400, 7619.38), undefined, NOW, config);
    expect(ev.hit).toMatchObject({ severity: 'MEDIUM', window: 'session' });
  });

  it('15-minute window uses OUR history (works for single-quote sources)', () => {
    const ring: Sample[] = [[nowSec - 900, 7500]];
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 7440, null), st('SPX', ring), NOW, config); // -0.8% in 15m (> 0.686 MEDIUM)
    expect(ev.moves.m15).toBeCloseTo(-0.8, 1);
    expect(ev.hit).toMatchObject({ severity: 'MEDIUM', window: 'm15' });
  });

  it('stale data (market closed) never triggers', () => {
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 1000, 7619, nowSec - 3 * 3600), undefined, NOW, config);
    expect(ev.stale).toBe(true);
    expect(ev.hit).toBeNull();
  });

  it('glitch guard: absurd short-window index moves are ignored', () => {
    const ring: Sample[] = [[nowSec - 900, 10]];
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 7400, 7400), st('SPX', ring), NOW, config);
    expect(ev.moves.m15).toBeNull();
    expect(ev.hit).toBeNull();
  });

  it('VIX level crossing fires once, on the crossing minute only', () => {
    const cross = evaluatePrice(asset('VIX'), snap('VIX', 25.2, 24.0), st('VIX', [], 24.5), NOW, config);
    expect(cross.hit).toMatchObject({ severity: 'MEDIUM', window: 'level' });
    const stays = evaluatePrice(asset('VIX'), snap('VIX', 25.4, 24.0), st('VIX', [], 25.2), NOW, config);
    expect(stays.hit).toBeNull();
  });

  it('a market-wide circuit-breaker decline is WORLD-ENDING', () => {
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 92.5, 100), undefined, NOW, config);
    expect(ev.hit?.severity).toBe('WORLD_ENDING');
  });

  it('NSE index +10% (circuit) is WORLD-ENDING in either direction', () => {
    expect(evaluatePrice(asset('NIFTY'), snap('NIFTY', 110.5, 100), undefined, NOW, config).hit?.severity).toBe('WORLD_ENDING');
    expect(evaluatePrice(asset('NIFTY'), snap('NIFTY', 89, 100), undefined, NOW, config).hit?.severity).toBe('WORLD_ENDING');
  });

  it('data-source halt flag raises at least HIGH', () => {
    const ev = evaluatePrice(asset('SPX'), snap('SPX', 7600, 7619, nowSec, { halted: true }), undefined, NOW, config);
    expect(ev.hit?.severity).toBe('HIGH');
  });

  it('crypto: BTC -8% on the day is MEDIUM, -12% is HIGH', () => {
    expect(evaluatePrice(asset('BTC'), snap('BTC', 92, 100), undefined, NOW, config).hit?.severity).toBe('MEDIUM');
    expect(evaluatePrice(asset('BTC'), snap('BTC', 88, 100), undefined, NOW, config).hit?.severity).toBe('HIGH');
  });
});

describe('providers: parsing and cross-checks', () => {
  it('parses Yahoo spark (batch) responses incl. previous close and series', () => {
    const json = { '^GSPC': { timestamp: [nowSec - 600, nowSec - 300, nowSec - 20], close: [100, null, 101], previousClose: 99.5 } };
    const m = parseYahooSpark(json, config.assets, nowSec);
    const s = m.get('SPX')!;
    expect(s.price).toBe(101); expect(s.prevClose).toBe(99.5); expect(s.source).toBe('Yahoo Finance');
    expect(s.series!.length).toBe(2);
  });

  it('parses CNBC quotes with thousands separators and halt flags', () => {
    const json = { FormattedQuoteResult: { FormattedQuote: [{ symbol: '.SPX', code: 0, last: '7,591.30', previous_day_closing: '7,619.38', last_time: '2026-11-12T15:43:06.000-0500', EventData: { is_halted: 'Y' } }, { symbol: '.BSESN', code: 3 }] } };
    const m = parseCnbc(json, config.assets);
    expect(m.get('SPX')).toMatchObject({ price: 7591.3, prevClose: 7619.38, halted: true });
    expect(m.has('SENSEX')).toBe(false);
  });

  it('second-source confirmation requires the same direction and at least half the move', () => {
    expect(confirms(-8, snap('SPX', 92, 100))).toBe(true);
    expect(confirms(-8, snap('SPX', 99, 100))).toBe(false);
    expect(confirms(-8, snap('SPX', 108, 100))).toBe(false);
    expect(confirms(-8, snap('SPX', 99, null))).toBe(true); // cannot judge => do not block
  });

  it('OKX liquidation summary converts contracts to USD inside the window only', () => {
    const rows = [{ uly: 'BTC-USDT', details: [{ ts: String(NOW - 60_000), sz: '1000', bkPx: '70000', posSide: 'long' }, { ts: String(NOW - 3600_000), sz: '9999', bkPx: '70000', posSide: 'long' }] }];
    const r = summariseOkx(rows, 5, NOW);
    expect(r.usd).toBeCloseTo(1000 * 0.01 * 70000); expect(r.n).toBe(1);
    expect(tierFor(r.usd, config.crypto.liquidations.usdThresholds)).toBeNull();
    expect(tierFor(200e6, config.crypto.liquidations.usdThresholds)).toBe('HIGH');
  });

  it('open-interest drop is measured from the peak', () => {
    expect(oiDropPct([{ openInterest: '95' }, { openInterest: '100' }, { openInterest: '99' }])).toBeCloseTo(5);
    expect(oiDropPct([{ openInterest: '100' }])).toBe(0);
  });
});

import { fmtNum } from '../src/core/priceTriggers';
import { fetchPrices, pickFreshest } from '../src/providers/prices';
import { mkFetch } from './helpers';

describe('number formatting', () => {
  it('groups thousands without Intl and trims zeros', () => {
    expect(fmtNum(3879.7)).toBe('3,879.7');
    expect(fmtNum(7591.3)).toBe('7,591.3');
    expect(fmtNum(25299.35)).toBe('25,299.35');
    expect(fmtNum(-1234.5)).toBe('-1,234.5');
    expect(fmtNum(94.0425)).toBe('94.043');
    expect(fmtNum(0.00123)).toBe('0.00123');
    expect(fmtNum(2_498_206_958_490)).toBe('2,498,206,958,490');
  });
});

describe('two-source price selection', () => {
  const mk = (id: string, ts: number, price: number, source: string, extra: Partial<Snapshot> = {}): Snapshot => ({ id, price, prevClose: null, ts, source, ...extra });

  it('the fresher quote wins, but Yahoo history and previous close are kept', () => {
    const y = mk('VIX', 1000, 18, 'Yahoo Finance', { series: [[900, 17.9]], prevClose: 17.5 });
    const c = mk('VIX', 1900, 19, 'CNBC');
    expect(pickFreshest(y, c)).toMatchObject({ price: 19, source: 'CNBC', prevClose: 17.5, series: [[900, 17.9]] });
  });
  it('ties go to Yahoo; a single source is used as is', () => {
    expect(pickFreshest(mk('A', 5, 1, 'Yahoo Finance'), mk('A', 5, 2, 'CNBC'))?.source).toBe('Yahoo Finance');
    expect(pickFreshest(undefined, mk('A', 5, 2, 'CNBC'))?.source).toBe('CNBC');
    expect(pickFreshest(mk('A', 5, 1, 'Yahoo Finance'), undefined)?.source).toBe('Yahoo Finance');
  });
  it('end to end: Yahoo VIX is 15 min old, CNBC is live => CNBC quote is used; if CNBC is down Yahoo still works', async () => {
    const now = NOW;
    const yj = { '^VIX': { timestamp: [nowSec - 1100, nowSec - 900], close: [18, 18.1], previousClose: 17.5 } };
    const cj = { FormattedQuoteResult: { FormattedQuote: [{ symbol: '.VIX', code: 0, last: '19.20', previous_day_closing: '17.49', last_time: new Date(now).toISOString(), EventData: {} }] } };
    const f = mkFetch([[/yahoo\.com/, () => yj], [/quote\.cnbc\.com/, () => cj]]);
    const r = await fetchPrices(config, now, { fetch: f.fetch }, { totalDue: false });
    expect(r.snaps.get('VIX')).toMatchObject({ source: 'CNBC', price: 19.2 });
    expect(r.status.yahoo.ok && r.status.cnbc.ok).toBe(true);
    const f2 = mkFetch([[/yahoo\.com/, () => yj]]);
    const r2 = await fetchPrices(config, now, { fetch: f2.fetch }, { totalDue: false });
    expect(r2.snaps.get('VIX')?.source).toBe('Yahoo Finance');
    expect(r2.status.cnbc.ok).toBe(false); // visible to health tracking
  });
});
