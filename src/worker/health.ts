import type { Ctx } from './ctx';
import { setKv, systemAlert } from './ctx';

export interface SrcHealth { fails: number; notified: boolean }

/**
 * Track consecutive failures per data source. One alert when a source crosses the threshold, one when it recovers.
 * (Silence must never mean "broken": see also the GitHub heartbeat workflow for a dead Worker.)
 */
export function trackSource(ctx: Ctx, key: string, label: string, ok: boolean, err: string | undefined, threshold: number): void {
  const all: Record<string, SrcHealth> = { ...(ctx.kv.src_health ?? {}) };
  const cur = all[key] ?? { fails: 0, notified: false };
  let changed = false;
  if (ok) {
    if (cur.fails || cur.notified) {
      if (cur.notified) systemAlert(ctx, `src-ok:${key}`, `${label} recovered`, `${label} is delivering data again after ${cur.fails} failed polls.`);
      all[key] = { fails: 0, notified: false };
      changed = true;
    }
  } else {
    const fails = cur.fails + 1;
    let notified = cur.notified;
    if (fails >= threshold && !notified) {
      notified = true;
      systemAlert(ctx, `src-fail:${key}`, `${label} failing`, `${label} has failed ${fails} polls in a row (${(err ?? 'unknown error').slice(0, 120)}). Fallback sources are being used where available.`);
    }
    all[key] = { fails, notified };
    changed = true;
  }
  if (changed) setKv(ctx, 'src_health', all);
}
