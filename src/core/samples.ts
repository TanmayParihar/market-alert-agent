import type { Sample } from '../types';

/**
 * Per-asset price memory ("ring"): [epochSec, price] pairs for the last ~75 minutes.
 * Last 20 minutes are kept at full resolution; older entries are thinned to one per 5 minutes.
 * ~30 entries per asset keeps the per-minute state read tiny, and lets 15m / 1h moves be computed from OUR OWN
 * history, so they work with any data source (including ones that only give a single quote).
 */
const MAX_AGE = 75 * 60;
const FULL_RES = 20 * 60;
const BUCKET = 5 * 60;

export function mergeSamples(ring: Sample[], add: Sample[], nowSec: number): Sample[] {
  const byTs = new Map<number, number>();
  for (const [t, p] of ring) byTs.set(t, p);
  for (const [t, p] of add) if (Number.isFinite(t) && Number.isFinite(p) && p > 0) byTs.set(Math.floor(t), p);
  const all = [...byTs.entries()].filter(([t]) => nowSec - t <= MAX_AGE && t <= nowSec + 120).sort((a, b) => a[0] - b[0]);
  const out: Sample[] = [];
  const lastInBucket = new Map<number, Sample>();
  for (const [t, p] of all) {
    if (nowSec - t <= FULL_RES) out.push([t, p]);
    else lastInBucket.set(Math.floor(t / BUCKET), [t, p]);
  }
  return [...lastInBucket.values(), ...out].sort((a, b) => a[0] - b[0]);
}

/**
 * Price at (or just before) `nowSec - windowSec`. Returns null if our history has no sample close enough
 * (market was closed, worker was down) so a stale reference can never create a fake move.
 */
export function refPrice(ring: Sample[], nowSec: number, windowSec: number, toleranceSec: number): number | null {
  const target = nowSec - windowSec;
  let best: Sample | null = null;
  for (const s of ring) {
    if (s[0] <= target && (!best || s[0] > best[0])) best = s;
  }
  if (!best) return null;
  return target - best[0] <= toleranceSec ? best[1] : null;
}

export const pctChange = (now: number, ref: number): number => ((now - ref) / ref) * 100;
