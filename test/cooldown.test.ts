import { describe, expect, it } from 'vitest';
import { decideCooldown, type CooldownInput } from '../src/core/cooldown';
import { config } from '../agent.config';

const NOW = Date.parse('2026-11-13T09:00:00Z');
const base = (o: Partial<CooldownInput>): CooldownInput => ({
  severity: 'MEDIUM', window: 'h1', pct: -2, nowMs: NOW, last: null, cooldownMin: config.cooldownMin, sigmaDaily: 1, extensionSigma: 0.75, ...o,
});
const last = (minAgo: number, severity: any = 'MEDIUM', window: any = 'h1', pct = -2) => ({ severity, at: NOW - minAgo * 60_000, pct, window });

describe('per-asset cooldown', () => {
  it('first alert passes', () => expect(decideCooldown(base({}))).toEqual({ allow: true, reason: 'first' }));

  it('same severity inside the cooldown is suppressed', () => {
    expect(decideCooldown(base({ last: last(10) }))).toEqual({ allow: false, reason: 'cooldown' });
    expect(decideCooldown(base({ last: last(59) })).allow).toBe(false);
  });

  it('a LOWER severity inside the cooldown is suppressed too', () => {
    expect(decideCooldown(base({ severity: 'LOW', last: last(5, 'HIGH') })).allow).toBe(false);
  });

  it('escalation to a higher severity breaks through the cooldown', () => {
    expect(decideCooldown(base({ severity: 'HIGH', last: last(2, 'MEDIUM') }))).toEqual({ allow: true, reason: 'escalation' });
    expect(decideCooldown(base({ severity: 'WORLD_ENDING', last: last(1, 'HIGH') })).allow).toBe(true);
  });

  it('cooldown length depends on the previous severity', () => {
    expect(decideCooldown(base({ last: last(40, 'HIGH') })).allow).toBe(false); // HIGH cooldown 45
    expect(decideCooldown(base({ severity: 'HIGH', last: last(46, 'HIGH') })).allow).toBe(true);
  });

  it('after the cooldown a fresh 15m/1h move passes', () => {
    expect(decideCooldown(base({ last: last(61) }))).toEqual({ allow: true, reason: 'cooldown_expired' });
  });

  it('after the cooldown a same-severity SESSION move needs to have extended', () => {
    const s = (pct: number) => base({ window: 'session', pct, last: last(90, 'MEDIUM', 'session', -2.8) });
    expect(decideCooldown(s(-2.9))).toEqual({ allow: false, reason: 'no_extension' });
    expect(decideCooldown(s(-3.6))).toEqual({ allow: true, reason: 'extended' });
    expect(decideCooldown(s(2.7))).toEqual({ allow: true, reason: 'reversed' });
  });

  it('a very old last alert (12h+) no longer blocks', () => {
    expect(decideCooldown(base({ window: 'session', last: last(60 * 13, 'MEDIUM', 'session', -2.8) })).allow).toBe(true);
  });
});
