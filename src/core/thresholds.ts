import type { AgentConfig, AssetDef, Severity, WindowCfg, WindowId } from '../types';
import { SEVERITIES, rank } from './severity';

/** Normal (1-sigma) move of the asset over the window, in %. */
export function sigmaFor(asset: AssetDef, w: WindowCfg): number {
  if (w.id === 'session' || !w.minutes) return asset.dailyVolPct;
  return asset.dailyVolPct * Math.sqrt(w.minutes / asset.tradingMinutes);
}

/** Absolute-% thresholds per severity for one asset+window (explicit overrides win; floors apply). */
export function thresholdsFor(asset: AssetDef, w: WindowCfg): Record<Severity, number> {
  const sigma = sigmaFor(asset, w);
  const out = {} as Record<Severity, number>;
  for (const s of SEVERITIES) {
    const explicit = asset.thresholds?.[w.id]?.[s];
    let v = explicit ?? w.k[s] * sigma;
    if (explicit === undefined && s !== 'LOW') {
      const floor = asset.floorPct?.[w.id];
      if (floor !== undefined) v = Math.max(v, floor * (s === 'MEDIUM' ? 1 : s === 'HIGH' ? 1.6 : 2.6));
    }
    out[s] = v;
  }
  // keep strictly ordered even with odd overrides: lower levels give way to higher ones first (so an explicit
  // MEDIUM below the computed LOW lowers LOW), then anything still out of order is lifted.
  for (let i = SEVERITIES.length - 2; i >= 0; i--) {
    const lo = SEVERITIES[i], hi = SEVERITIES[i + 1];
    if (out[lo] >= out[hi]) out[lo] = out[hi] / 1.05;
  }
  let prev = 0;
  for (const s of SEVERITIES) {
    if (out[s] <= prev) out[s] = prev * 1.05;
    prev = out[s];
  }
  return out;
}

/** Highest severity whose threshold |pct| reaches, or null. */
export function severityForMove(absPct: number, th: Record<Severity, number>): Severity | null {
  let hit: Severity | null = null;
  for (const s of SEVERITIES) if (absPct >= th[s]) hit = s;
  return hit;
}

export interface MoveHit {
  window: WindowId;
  pct: number; // signed
  severity: Severity;
  threshold: number;
}

export function evaluateMoves(
  asset: AssetDef,
  moves: Partial<Record<WindowId, number | null>>,
  cfg: Pick<AgentConfig, 'windows'>,
): MoveHit[] {
  const hits: MoveHit[] = [];
  for (const w of cfg.windows) {
    const pct = moves[w.id];
    if (pct === null || pct === undefined || !Number.isFinite(pct)) continue;
    const th = thresholdsFor(asset, w);
    const sev = severityForMove(Math.abs(pct), th);
    if (sev) hits.push({ window: w.id, pct, severity: sev, threshold: th[sev] });
  }
  return hits.sort((a, b) => rank(b.severity) - rank(a.severity) || Math.abs(b.pct) - Math.abs(a.pct));
}

export function thresholdTable(cfg: Pick<AgentConfig, 'assets' | 'windows'>): string {
  const lines: string[] = [];
  lines.push('asset'.padEnd(14) + 'window'.padEnd(9) + 'sigma%'.padStart(8) + 'LOW'.padStart(9) + 'MEDIUM'.padStart(9) + 'HIGH'.padStart(9) + 'WORLD'.padStart(9));
  for (const a of cfg.assets) {
    for (const w of cfg.windows) {
      const th = thresholdsFor(a, w);
      lines.push(
        a.id.padEnd(14) + w.id.padEnd(9) + sigmaFor(a, w).toFixed(3).padStart(8) +
          [th.LOW, th.MEDIUM, th.HIGH, th.WORLD_ENDING].map((x) => (x.toFixed(2) + '%').padStart(9)).join(''),
      );
    }
  }
  return lines.join('\n');
}
