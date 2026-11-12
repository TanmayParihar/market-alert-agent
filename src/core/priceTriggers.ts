import type { AgentConfig, AlertCandidate, AssetDef, AssetState, Sample, Severity, Snapshot, WindowId } from '../types';
import { mergeSamples, pctChange, refPrice } from './samples';
import { evaluateMoves } from './thresholds';
import { rank } from './severity';

export interface PriceHit {
  severity: Severity;
  window: WindowId | 'level' | 'circuit';
  pct: number;
  label: string;
}

export interface PriceEval {
  stale: boolean;
  ring: Sample[];
  moves: Partial<Record<WindowId, number | null>>;
  hit: PriceHit | null;
  /** best hit, even if LOW (LOW goes to the digest) */
}

/** window -> tolerance in seconds when looking up our own history */
const WINDOW_SEC: Record<'m15' | 'h1', { sec: number; tol: number }> = { m15: { sec: 900, tol: 360 }, h1: { sec: 3600, tol: 660 } };
const GLITCH_PCT = 25; // |move| above this on an index/fx short window is treated as a bad tick

export function evaluatePrice(asset: AssetDef, snap: Snapshot, st: AssetState | undefined, nowMs: number, cfg: AgentConfig): PriceEval {
  const nowSec = Math.floor(nowMs / 1000);
  const prevRing = st?.ring ?? [];
  const stale = nowSec - snap.ts > asset.maxStaleMin * 60;
  if (stale) return { stale: true, ring: prevRing, moves: {}, hit: null };

  const add: Sample[] = [...(snap.series ?? []), [snap.ts, snap.price]];
  const ring = mergeSamples(prevRing, add, nowSec);

  const moves: Partial<Record<WindowId, number | null>> = {};
  for (const w of ['m15', 'h1'] as const) {
    const ref = refPrice(ring.filter((s) => s[0] < snap.ts), snap.ts, WINDOW_SEC[w].sec, WINDOW_SEC[w].tol);
    moves[w] = ref ? pctChange(snap.price, ref) : null;
  }
  moves.session = snap.prevClose && snap.prevClose > 0 ? pctChange(snap.price, snap.prevClose) : null;

  // glitch guard: absurd short-window moves on indices/FX are data errors, not news
  if (asset.cls === 'index' || asset.cls === 'fx') {
    for (const w of ['m15', 'h1'] as const) if (moves[w] !== null && Math.abs(moves[w]!) > GLITCH_PCT) moves[w] = null;
    if (moves.session !== null && Math.abs(moves.session!) > 40) moves.session = null;
  }

  const hits: PriceHit[] = [];
  for (const h of evaluateMoves(asset, moves, cfg)) {
    hits.push({ severity: h.severity, window: h.window, pct: h.pct, label: windowLabel(h.window) });
  }

  // level crossings (VIX / India VIX): fire once when crossing upward since the previous minute
  const prev = st?.last_price ?? null;
  for (const lv of asset.levels ?? []) {
    if (prev !== null && prev < lv.gte && snap.price >= lv.gte) {
      hits.push({ severity: lv.severity, window: 'level', pct: moves.session ?? 0, label: lv.label });
    }
  }

  // circuit-breaker proximity (previous-close based) and explicit halt flags
  const s = moves.session;
  if (s !== null && s !== undefined) {
    for (const c of asset.circuit ?? []) {
      const tripped = c.direction === 'down' ? s <= -c.pct : Math.abs(s) >= c.pct;
      if (tripped) hits.push({ severity: c.severity, window: 'circuit', pct: s, label: c.label });
    }
  }
  if (snap.halted) hits.push({ severity: 'HIGH', window: 'circuit', pct: s ?? 0, label: 'trading halt flag set by data source' });

  hits.sort((a, b) => rank(b.severity) - rank(a.severity) || Math.abs(b.pct) - Math.abs(a.pct));
  return { stale: false, ring, moves, hit: hits[0] ?? null };
}

export function windowLabel(w: WindowId | 'level' | 'circuit'): string {
  return w === 'm15' ? 'in 15 min' : w === 'h1' ? 'in 1 hour' : w === 'session' ? 'on the day' : w;
}

export function fmtNum(n: number): string {
  // manual grouping: Number#toLocaleString is slow (Intl) and this runs on a 10 ms CPU budget
  const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 3 : 5;
  const [int, frac] = Math.abs(n).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = frac ? frac.replace(/0+$/, '') : '';
  return (n < 0 ? '-' : '') + grouped + (f ? '.' + f : '');
}
export const fmtPct = (p: number): string => `${p >= 0 ? '+' : ''}${p.toFixed(Math.abs(p) >= 10 ? 1 : 2)}%`;

export function buildPriceCandidate(asset: AssetDef, snap: Snapshot, ev: PriceEval, hit: PriceHit, nowMs: number, confirmNote = ''): AlertCandidate {
  const dir = hit.pct >= 0 ? 'up' : 'down';
  const mag = Math.abs(hit.pct).toFixed(Math.abs(hit.pct) >= 10 ? 1 : 2);
  const headline =
    hit.window === 'level' || hit.window === 'circuit'
      ? `${asset.name}: ${hit.label}`
      : `${asset.name} ${dir} ${mag}% ${hit.label}`;
  const m = ev.moves;
  const parts = [`${asset.name} at ${fmtNum(snap.price)}`];
  if (snap.prevClose) parts[0] += ` (${fmtPct(m.session ?? 0)} vs prev close ${fmtNum(snap.prevClose)})`;
  const sub: string[] = [];
  if (m.m15 != null) sub.push(`15m ${fmtPct(m.m15)}`);
  if (m.h1 != null) sub.push(`1h ${fmtPct(m.h1)}`);
  const what = parts[0] + (sub.length ? `. ${sub.join(', ')}.` : '.') + confirmNote;
  const kind = asset.cls === 'vol' || hit.window === 'level' ? 'vol' : asset.cls === 'crypto' || asset.cls === 'crypto_total' ? 'crypto' : 'price';
  const bucket = Math.floor(nowMs / (10 * 60_000));
  return {
    dedupeKey: `price:${asset.id}:${hit.window}:${hit.severity}:${bucket}`,
    kind: kind === 'crypto' ? 'price' : kind,
    severity: hit.severity,
    headline,
    what,
    impact: `${asset.id} ${dir === 'down' ? 'weakness' : 'strength'} → ${dir === 'down' ? asset.hintDown : asset.hintUp}`,
    source: snap.source,
    sourceTime: snap.ts * 1000,
    assetIds: [asset.id],
    payload: { window: hit.window, pct: hit.pct, price: snap.price, moves: ev.moves },
  };
}
