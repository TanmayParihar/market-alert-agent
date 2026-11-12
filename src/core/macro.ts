import type { AgentConfig, AlertCandidate, MacroEventRow, MacroEventRule, Severity } from '../types';
import { formatIST, partsOf } from '../util/time';
import { sanitize } from '../util/text';

/** "0.3%" -> 0.3 ; "150K" -> 150 ; "1.2M" -> 1200 ; "-12.3B" -> -12300000 (K is the base unit). */
export function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([KMBT%])?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch ((m[2] ?? '').toUpperCase()) {
    case 'K': return v;
    case 'M': return v * 1e3;
    case 'B': return v * 1e6;
    case 'T': return v * 1e9;
    default: return v;
  }
}

export function matchRule(cfg: AgentConfig, title: string, country: string): MacroEventRule | null {
  for (const r of cfg.macro.rules) {
    if (r.country === country && new RegExp(r.match, 'i').test(title)) return r;
  }
  return null;
}

export function isRateDecision(label: string): boolean {
  return /rate decision|policy decision|MPC/i.test(label);
}

export interface Surprise { z: number | null; diff: number | null; direction: 'higher' | 'lower' | 'inline' | 'unknown' }

export function surprise(actual: string | null, forecast: string | null, sigma: number): Surprise {
  const a = parseNumber(actual);
  const f = parseNumber(forecast);
  if (a === null || f === null) return { z: null, diff: null, direction: 'unknown' };
  const diff = a - f;
  const z = sigma > 0 ? Math.abs(diff) / sigma : 0;
  const direction = Math.abs(diff) < sigma * 0.25 ? 'inline' : diff > 0 ? 'higher' : 'lower';
  return { z, diff, direction };
}

/**
 * Result severity: Tier-1 releases are MEDIUM; a >= 2 sigma surprise (or a rate decision that differs from consensus) is HIGH.
 * A scheduled release alone is never WORLD-ENDING (emergency actions arrive through the news path).
 */
export function resultSeverity(s: Surprise, rateDecision: boolean): Severity {
  if (rateDecision && s.direction !== 'inline' && s.direction !== 'unknown') return 'HIGH';
  if (s.z !== null && s.z >= 2) return 'HIGH';
  return 'MEDIUM';
}

export function buildHeadsUp(ev: MacroEventRow, rule: MacroEventRule | null, fixedHints: { hintHigher?: string; hintLower?: string } | null, nowMs: number): AlertCandidate {
  const when = Date.parse(ev.event_time);
  const mins = Math.max(0, Math.round((when - nowMs) / 60000));
  const label = rule?.label ?? ev.title;
  const hh = rule?.hintHigher ?? fixedHints?.hintHigher;
  const hl = rule?.hintLower ?? fixedHints?.hintLower;
  const facts = [ev.forecast ? `forecast ${ev.forecast}` : null, ev.previous ? `previous ${ev.previous}` : null].filter(Boolean).join(', ');
  return {
    dedupeKey: `macro:${ev.id}:headsup`,
    kind: 'macro',
    severity: 'MEDIUM',
    headline: `${label} due in ${mins} min`,
    what: `${label} at ${formatIST(when, nowMs)}${facts ? ` (${facts})` : ''}.${ev.approx ? ' Date approximate - verify.' : ''}`,
    impact: hh && hl ? `Hotter/stronger than forecast: ${hh}. Weaker/cooler: ${hl}.` : 'Expect volatility in USD, Gold, equities and BTC around the release.',
    source: ev.source === 'config' ? 'Official schedule' : 'Economic calendar',
    sourceTime: when,
    assetIds: [],
    payload: { eventId: ev.id },
  };
}

export function buildResult(
  ev: MacroEventRow, rule: MacroEventRule | null, actual: string, note: string | null, nowMs: number,
  fixedHints: { hintHigher?: string; hintLower?: string } | null = null,
): AlertCandidate {
  const sigma = rule?.sigma ?? 0.25;
  const label = rule?.label ?? ev.title;
  const s = surprise(actual, ev.forecast, sigma);
  const sev = resultSeverity(s, isRateDecision(label));
  const hh = rule?.hintHigher ?? fixedHints?.hintHigher;
  const hl = rule?.hintLower ?? fixedHints?.hintLower;
  const verdict = s.direction === 'inline' ? 'in line' : s.direction === 'higher' ? 'above forecast' : s.direction === 'lower' ? 'below forecast' : 'vs forecast n/a';
  const impact = s.direction === 'higher' ? hh : s.direction === 'lower' ? hl : null;
  return {
    dedupeKey: `macro:${ev.id}:result`,
    kind: 'macro',
    severity: sev,
    headline: `${label}: ${actual}, ${verdict}`,
    what: `Actual ${actual} vs forecast ${ev.forecast ?? 'n/a'}${ev.previous ? ` (previous ${ev.previous})` : ''}.${note ? ' ' + sanitize(note, 160) : ''}`,
    impact: impact ?? 'Result roughly in line: limited surprise, watch the first reaction in USD, Gold and index futures.',
    source: note ? 'Official release / press (LLM-extracted)' : 'BLS',
    sourceTime: nowMs,
    assetIds: [],
    payload: { eventId: ev.id, actual, forecast: ev.forecast, z: s.z },
  };
}

// ----- BLS computation (pure) -----

export interface BlsPoint { year: string; period: string; value: string }

/** Reference month of a release: the month BEFORE the release month (US Eastern). */
export function expectedRefMonth(eventMs: number): { year: number; month: number } {
  const p = partsOf(eventMs, 'America/New_York');
  let year = Number(p.year);
  let month = Number(p.month) - 1;
  if (month === 0) { month = 12; year -= 1; }
  return { year, month };
}

const key = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

export function computeBls(
  points: BlsPoint[], transform: 'mom' | 'yoy' | 'level' | 'change', expected: { year: number; month: number },
): { value: number; text: string } | null {
  const map = new Map<string, number>();
  for (const p of points) {
    const m = /^M(\d\d)$/.exec(p.period);
    if (!m || m[1] === '13') continue;
    const v = parseFloat(p.value);
    if (Number.isFinite(v)) map.set(key(Number(p.year), Number(m[1])), v);
  }
  const cur = map.get(key(expected.year, expected.month));
  if (cur === undefined) return null; // release not published yet
  const prevM = expected.month === 1 ? { y: expected.year - 1, m: 12 } : { y: expected.year, m: expected.month - 1 };
  switch (transform) {
    case 'level': return { value: cur, text: `${cur.toFixed(1)}%` };
    case 'mom': {
      const prev = map.get(key(prevM.y, prevM.m));
      if (prev === undefined) return null;
      const v = Math.round(((cur / prev - 1) * 100) * 10) / 10;
      return { value: v, text: `${v.toFixed(1)}%` };
    }
    case 'yoy': {
      const prev = map.get(key(expected.year - 1, expected.month));
      if (prev === undefined) return null;
      const v = Math.round(((cur / prev - 1) * 100) * 10) / 10;
      return { value: v, text: `${v.toFixed(1)}%` };
    }
    case 'change': {
      const prev = map.get(key(prevM.y, prevM.m));
      if (prev === undefined) return null;
      const v = Math.round(cur - prev);
      return { value: v, text: `${v}K` };
    }
  }
}
