import type { LastAlert, Severity, WindowId } from '../types';
import { rank } from './severity';

export interface CooldownInput {
  severity: Severity;
  window: WindowId | 'level' | 'circuit';
  /** signed % move that triggered it */
  pct: number;
  nowMs: number;
  last: LastAlert | null;
  cooldownMin: Record<Severity, number>;
  /** daily sigma of the asset (for the "has the move extended?" rule) */
  sigmaDaily: number;
  extensionSigma: number;
}

export type CooldownDecision =
  | { allow: true; reason: 'first' | 'escalation' | 'cooldown_expired' | 'extended' | 'reversed' | 'stale_last' }
  | { allow: false; reason: 'cooldown' | 'no_extension' };

const STALE_LAST_MS = 12 * 3600_000;

/**
 * Per-asset cooldown.
 *  - First alert, or an escalation to a HIGHER severity, always passes (breaks through the cooldown).
 *  - Inside the cooldown (length depends on the previous alert's severity) everything else is suppressed.
 *  - After it, a same-severity "session" move only re-alerts if it has extended by `extensionSigma` daily sigmas
 *    (so one long grind lower does not ping every hour); fresh 15m/1h moves pass.
 */
export function decideCooldown(i: CooldownInput): CooldownDecision {
  const l = i.last;
  if (!l) return { allow: true, reason: 'first' };
  const elapsed = i.nowMs - l.at;
  if (rank(i.severity) > rank(l.severity)) return { allow: true, reason: 'escalation' };
  if (elapsed < i.cooldownMin[l.severity] * 60_000) return { allow: false, reason: 'cooldown' };
  if (elapsed >= STALE_LAST_MS) return { allow: true, reason: 'stale_last' };
  if (i.window === 'session' && l.window === 'session') {
    if (Math.sign(i.pct) !== Math.sign(l.pct)) return { allow: true, reason: 'reversed' };
    if (Math.abs(i.pct) >= Math.abs(l.pct) + i.extensionSigma * i.sigmaDaily) return { allow: true, reason: 'extended' };
    return { allow: false, reason: 'no_extension' };
  }
  return { allow: true, reason: 'cooldown_expired' };
}
