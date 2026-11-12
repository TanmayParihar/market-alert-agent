import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { buildDigest } from '../src/digest/build';
import type { MacroEventRow, Snapshot } from '../src/types';

const NOW = Date.parse('2026-11-13T03:00:00Z'); // 08:30 IST
const snaps = new Map<string, Snapshot>(
  Object.entries({ SPX: [7591, 7619], NDX: [25335, 25466], GOLD: [3886, 4000], BTC: [71000, 73925], VIX: [18.85, 17.49], NIFTY: [25299, 25044], USDINR: [94.03, 93.68] })
    .map(([id, [price, prev]]) => [id, { id, price, prevClose: prev, ts: NOW / 1000, source: 't' }]),
);
const ev: MacroEventRow = { id: 'e', source: 'faireconomy', title: 'PPI m/m', country: 'USD', impact: 'High', event_time: '2026-11-13T13:30:00.000Z', forecast: '0.4%', previous: '1.3%', actual: null, status: 'scheduled', watch: true, approx: false, resolver: null, attempts: 0, meta: {} };
const base = { nowMs: NOW, cfg: config, snaps, low: [{ created_at: '2026-11-12T20:00:00Z', headline: 'Silver down 3.9% on the day', kind: 'price', asset_ids: ['SILVER'] }], events: [ev], heartbeat: { at: NOW - 45_000 }, waDown: false, llmPct: 12.3, missing: ['SOL'] };

describe('daily digest', () => {
  it('India digest: alive line, overnight moves, LOW items, next-24h macro in IST', () => {
    const t = buildDigest({ ...base, kind: 'india' });
    expect(t).toContain('India pre-open digest');
    expect(t).toContain('08:30 IST');
    expect(t).toContain('✅ Agent alive · Worker last ran 1 min ago');
    expect(t).toContain('S&P -0.37%');
    expect(t).toContain('Gold -2.85%');
    expect(t).toContain('⚪ LOW items since last digest (1)');
    expect(t).toContain('Silver down 3.9% on the day');
    expect(t).toContain('19:00 USD PPI m/m (fcst 0.4%, prev 1.3%)'); // 13:30Z = 19:00 IST
    expect(t).toContain('(no data: SOL)');
    expect(t).toContain('not advice');
  });

  it('flags a stale Worker in the morning digest instead of staying silent', () => {
    const t = buildDigest({ ...base, kind: 'india', heartbeat: { at: NOW - 3 * 3600_000 } });
    expect(t).toContain('⚠️ Worker last ran 180 min ago');
    expect(buildDigest({ ...base, kind: 'india', heartbeat: null })).toContain('last ran never');
  });

  it('US digest leads with India close and has no duplicate alive line', () => {
    const t = buildDigest({ ...base, kind: 'us' });
    expect(t).toContain('US pre-open digest');
    expect(t.indexOf('India close')).toBeLessThan(t.indexOf('US (last close'));
    expect(t).not.toContain('Agent alive');
  });

  it('caps the LOW list and says how many more', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ created_at: '2026-11-12T20:00:00Z', headline: `item ${i}`, kind: 'news', asset_ids: [] }));
    const t = buildDigest({ ...base, kind: 'india', low: many });
    expect(t).toContain(`+${30 - config.digest.maxLowItems} more`);
  });
});
