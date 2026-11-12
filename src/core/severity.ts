import type { Severity } from '../types';

export const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'WORLD_ENDING'];

const RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, WORLD_ENDING: 4 };

export const EMOJI: Record<Severity, string> = { LOW: '⚪', MEDIUM: '🟡', HIGH: '🔴', WORLD_ENDING: '🚨' };
export const LABEL: Record<Severity, string> = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', WORLD_ENDING: 'WORLD-ENDING' };

export const rank = (s: Severity | null | undefined): number => (s ? RANK[s] : 0);
export const maxSeverity = (a: Severity, b: Severity): Severity => (rank(a) >= rank(b) ? a : b);
export const atLeast = (s: Severity, min: Severity): boolean => rank(s) >= rank(min);

export function parseSeverity(v: unknown): Severity | 'NONE' {
  if (typeof v !== 'string') return 'NONE';
  const t = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (t === 'LOW' || t === 'MEDIUM' || t === 'HIGH' || t === 'WORLD_ENDING') return t;
  return 'NONE';
}

/**
 * The rubric. One definition used by: the LLM prompt, the README, and the keyword/price/macro mappers.
 * Price/vol triggers map to it with sigma multiples (agent.config.ts); news via LLM or keywords; macro via surprise size.
 */
export const RUBRIC = {
  LOW: {
    meaning: 'Notable but routine. Never sent instantly; goes into the next daily digest.',
    price: 'A move of roughly 1.8-2.5 normal-volatility units (e.g. S&P -1.8% on the day).',
    news: 'Company or sector headline, analyst call, minor policy chatter with no clear read-through to a watched asset.',
    macro: 'Second-tier data, in line with forecast.',
    vol: 'VIX drifting up a few points inside a normal range.',
  },
  MEDIUM: {
    meaning: 'Likely to move a market you watch today. Sent instantly.',
    price: 'About 2.5-4 units (S&P -2.5%, BTC -7% on the day, gold +0.4% in 15 minutes).',
    news: 'Surprise policy or tariff announcement, sanctions on a major producer, large bank/exchange trouble in one region, major crypto regulatory action, big-cap corporate shock.',
    macro: 'Tier-1 release (CPI, payrolls, central-bank decision) - heads-up and result; surprise under ~2 sigma.',
    vol: 'VIX crosses 25, India VIX crosses 20, USD/INR jumps ~0.4% in a session.',
  },
  HIGH: {
    meaning: 'Major, cross-market impact likely. Sent instantly to BOTH channels.',
    price: 'About 4-7 units (S&P -4%, Nifty -3.6%, BTC -11% on the day).',
    news: 'Military escalation between significant powers, emergency central-bank action, failure of a systemically relevant bank or top-10 crypto exchange, major sanctions regime change, oil-supply shock.',
    macro: 'Tier-1 surprise of 2+ sigma (e.g. CPI 0.2pp above consensus) or a rate decision opposite to consensus.',
    vol: 'VIX crosses 35, India VIX crosses 28, crypto liquidation cascade (>5% open-interest wiped).',
  },
  WORLD_ENDING: {
    meaning: 'Rare systemic shock (2008, March 2020, a major war outbreak, a top-tier exchange collapse). Sent instantly to BOTH channels.',
    price: '7+ units, or a market-wide circuit breaker (US -7% L1, NSE index -10%).',
    news: 'Outbreak of war involving major powers, nuclear event, collapse of a top-tier bank/exchange/stablecoin, sovereign default of a major economy, trading halted market-wide.',
    macro: 'Never from a scheduled release alone; emergency inter-meeting central-bank action arrives via news.',
    vol: 'VIX above 50 or a circuit-breaker halt.',
  },
} as const;

export function rubricForPrompt(): string {
  return SEVERITIES.map((s) => `${s}: ${RUBRIC[s].meaning} News examples: ${RUBRIC[s].news}`).join('\n');
}
