import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { evaluateMoves, severityForMove, sigmaFor, thresholdsFor } from '../src/core/thresholds';
import { atLeast, EMOJI, LABEL, maxSeverity, parseSeverity, rank, SEVERITIES } from '../src/core/severity';

const asset = (id: string) => config.assets.find((a) => a.id === id)!;
const win = (id: string) => config.windows.find((w) => w.id === id)!;

describe('volatility-scaled thresholds', () => {
  it('scales daily vol to short windows by sqrt(time)', () => {
    expect(sigmaFor(asset('SPX'), win('m15'))).toBeCloseTo(1.0 * Math.sqrt(15 / 390), 6);
    expect(sigmaFor(asset('SPX'), win('h1'))).toBeCloseTo(1.0 * Math.sqrt(60 / 390), 6);
    expect(sigmaFor(asset('SPX'), win('session'))).toBe(1.0);
  });

  it('S&P defaults: session MEDIUM 2.5%, HIGH 4%, WORLD 7%; 15m MEDIUM ~0.69%', () => {
    const s = thresholdsFor(asset('SPX'), win('session'));
    expect(s.MEDIUM).toBeCloseTo(2.5); expect(s.HIGH).toBeCloseTo(4); expect(s.WORLD_ENDING).toBeCloseTo(7);
    expect(thresholdsFor(asset('SPX'), win('m15')).MEDIUM).toBeCloseTo(0.686, 2);
  });

  it('a more volatile asset needs a bigger move for the same severity', () => {
    const btc = thresholdsFor(asset('BTC'), win('session')).MEDIUM;
    const spx = thresholdsFor(asset('SPX'), win('session')).MEDIUM;
    const inr = thresholdsFor(asset('USDINR'), win('session')).MEDIUM;
    expect(btc).toBeGreaterThan(spx);
    expect(spx).toBeGreaterThan(inr);
  });

  it('thresholds are strictly increasing LOW < MEDIUM < HIGH < WORLD for every asset and window', () => {
    for (const a of config.assets) for (const w of config.windows) {
      const t = thresholdsFor(a, w);
      expect(t.LOW).toBeLessThan(t.MEDIUM); expect(t.MEDIUM).toBeLessThan(t.HIGH); expect(t.HIGH).toBeLessThan(t.WORLD_ENDING);
    }
  });

  it('noise floor lifts MEDIUM+ for very calm assets (USD/INR 15m)', () => {
    const t = thresholdsFor(asset('USDINR'), win('m15'));
    expect(t.MEDIUM).toBeCloseTo(0.12);
    expect(t.LOW).toBeLessThan(0.12);
  });

  it('explicit per-asset overrides replace the scaled value', () => {
    const a = { ...asset('SPX'), thresholds: { session: { MEDIUM: 1.5 } } };
    const t = thresholdsFor(a, win('session'));
    expect(t.MEDIUM).toBe(1.5);
    expect(t.LOW).toBeLessThan(1.5); // LOW gives way instead of MEDIUM being pushed up
  });

  it('maps a move to the highest severity reached', () => {
    const t = thresholdsFor(asset('SPX'), win('session'));
    expect(severityForMove(1.0, t)).toBeNull();
    expect(severityForMove(1.9, t)).toBe('LOW');
    expect(severityForMove(2.6, t)).toBe('MEDIUM');
    expect(severityForMove(4.1, t)).toBe('HIGH');
    expect(severityForMove(7.0, t)).toBe('WORLD_ENDING');
    expect(severityForMove(12, t)).toBe('WORLD_ENDING');
  });

  it('evaluateMoves ranks hits by severity and ignores nulls', () => {
    const hits = evaluateMoves(asset('SPX'), { m15: null, h1: 1.5, session: -4.5 }, config);
    expect(hits[0]).toMatchObject({ window: 'session', severity: 'HIGH' });
    expect(hits.some((h) => h.window === 'm15')).toBe(false);
    expect(hits.find((h) => h.window === 'h1')?.severity).toBe('MEDIUM');
  });
});

describe('severity helpers', () => {
  it('orders and parses severities', () => {
    expect(SEVERITIES.map(rank)).toEqual([1, 2, 3, 4]);
    expect(maxSeverity('LOW', 'HIGH')).toBe('HIGH');
    expect(atLeast('HIGH', 'HIGH')).toBe(true);
    expect(atLeast('MEDIUM', 'HIGH')).toBe(false);
    expect(parseSeverity('world-ending')).toBe('WORLD_ENDING');
    expect(parseSeverity('World Ending')).toBe('WORLD_ENDING');
    expect(parseSeverity('catastrophic')).toBe('NONE');
    expect(parseSeverity(5)).toBe('NONE');
  });
  it('uses a distinct emoji per level', () => {
    expect(new Set(SEVERITIES.map((s) => EMOJI[s])).size).toBe(4);
    expect(LABEL.WORLD_ENDING).toBe('WORLD-ENDING');
  });
});
