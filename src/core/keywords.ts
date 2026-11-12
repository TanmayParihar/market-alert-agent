import type { Severity } from '../types';
import { rank } from './severity';

export interface ScoredHeadline {
  is_market_moving: boolean;
  severity: Severity | 'NONE';
  affected_assets: string[];
  likely_direction: Record<string, 'up' | 'down' | 'mixed'>;
  one_line_reason: string;
}

interface Rule { re: RegExp; sev: Severity; assets: Record<string, 'up' | 'down' | 'mixed'>; reason: string }

const RISK_OFF = { SPX: 'down', NDX: 'down', NIFTY: 'down', BTC: 'down', GOLD: 'up', VIX: 'up', CRUDE: 'up' } as const;

/**
 * Fallback scorer used when every LLM is unavailable. Deliberately conservative:
 * WORLD-ENDING needs an unambiguous pattern; negations ("rules out", "denies") downgrade one level.
 */
const RULES: Rule[] = [
  { re: /\b(declares?|declared|declaration of) war\b/i, sev: 'WORLD_ENDING', assets: RISK_OFF, reason: 'Declaration of war' },
  { re: /\bnuclear (strike|attack|detonation|weapon (used|detonated))\b|\bnuke[sd]? (hit|struck)\b/i, sev: 'WORLD_ENDING', assets: RISK_OFF, reason: 'Nuclear attack reported' },
  { re: /\b(invade[sd]?|invasion of)\b.*\b(taiwan|nato|poland|baltic|japan|south korea)\b/i, sev: 'WORLD_ENDING', assets: RISK_OFF, reason: 'Invasion involving a major power' },
  { re: /\b(global|world) (markets?|stocks?|equities) (crash|meltdown|collapse|rout)\b/i, sev: 'WORLD_ENDING', assets: RISK_OFF, reason: 'Global market crash' },
  { re: /\b(binance|coinbase|okx|bybit|kraken|ftx)\b.*\b(collapse[sd]?|insolven\w+|halts? (all )?withdrawals|files? for bankruptcy)\b/i, sev: 'WORLD_ENDING', assets: { BTC: 'down', ETH: 'down', SOL: 'down', CRYPTO_TOTAL: 'down' }, reason: 'Top-tier crypto exchange failure' },
  { re: /\bmarket-?wide (trading )?halt\b|\bcircuit breakers? (was |were )?(triggered|tripped|hit)\b/i, sev: 'WORLD_ENDING', assets: RISK_OFF, reason: 'Market-wide circuit breaker' },

  { re: /\bemergency (rate )?(cut|hike|meeting)\b/i, sev: 'HIGH', assets: { SPX: 'mixed', GOLD: 'up', USDINR: 'mixed' }, reason: 'Emergency central-bank action' },
  { re: /\bstrait of hormuz\b.*\b(clos\w+|block\w+|attack\w*)\b/i, sev: 'HIGH', assets: { CRUDE: 'up', GOLD: 'up', SPX: 'down', NIFTY: 'down' }, reason: 'Oil chokepoint disruption' },
  { re: /\b(missile|air ?strike|drone) (strikes?|attacks?)\b.*\b(oil|refiner\w*|tanker|saudi|iran|israel)\b/i, sev: 'HIGH', assets: { CRUDE: 'up', GOLD: 'up', SPX: 'down' }, reason: 'Military strike near oil supply' },
  { re: /\bbank (collapses?|fails?|failure)\b|\bbank runs?\b|\b(lender|bank) (seized|taken over) by regulators?\b/i, sev: 'HIGH', assets: { SPX: 'down', BANKNIFTY: 'down', GOLD: 'up', BTC: 'mixed' }, reason: 'Bank failure / run' },
  { re: /\bsovereign default\b|\bdefault(s|ed)? on (its )?(sovereign )?(debt|bonds)\b/i, sev: 'HIGH', assets: RISK_OFF, reason: 'Sovereign default' },
  { re: /\bstablecoin\b.*\b(depeg\w*|collapse[sd]?)\b|\b(usdt|usdc|tether)\b.*\bdepeg\w*\b/i, sev: 'HIGH', assets: { BTC: 'down', ETH: 'down', CRYPTO_TOTAL: 'down' }, reason: 'Stablecoin depeg' },
  { re: /\b(crypto )?exchange\b.*\bhack(ed)?\b.*\$\s?\d+(\.\d+)?\s?billion|\bhack(ed)?\b.*\$\s?\d+(\.\d+)?\s?billion/i, sev: 'HIGH', assets: { BTC: 'down', ETH: 'down', CRYPTO_TOTAL: 'down' }, reason: 'Billion-dollar crypto hack' },

  { re: /\b(rate cut|rate hike|raises? (interest )?rates|cuts? (interest )?rates|holds? rates)\b/i, sev: 'MEDIUM', assets: { USDINR: 'mixed', GOLD: 'mixed', SPX: 'mixed' }, reason: 'Central-bank rate decision' },
  { re: /\btariffs?\b.*\b(impose[sd]?|announce[sd]?|hike[sd]?|raise[sd]?|slap\w*)\b|\b(impose[sd]?|announce[sd]?|slap\w*)\b.*\btariffs?\b/i, sev: 'MEDIUM', assets: { SPX: 'down', NIFTY: 'down', USDINR: 'up' }, reason: 'New tariffs' },
  { re: /\bsanctions?\b.*\b(oil|russia|china|iran|saudi|bank)\b/i, sev: 'MEDIUM', assets: { CRUDE: 'up', GOLD: 'up' }, reason: 'Sanctions affecting commodities/markets' },
  { re: /\bopec\+?\b.*\b(surprise|emergency|slash\w*|cut\w*|raise[sd]?)\b/i, sev: 'MEDIUM', assets: { CRUDE: 'mixed' }, reason: 'OPEC output decision' },
  { re: /\b(sec|cftc)\b.*\b(sues?|charges?|bans?|rejects?|approves?)\b.*\b(crypto|bitcoin|ether|etf|exchange)\b/i, sev: 'MEDIUM', assets: { BTC: 'mixed', ETH: 'mixed', CRYPTO_TOTAL: 'mixed' }, reason: 'Crypto regulatory action' },
  { re: /\b(ban|bans|banned|banning)\b.*\b(crypto|bitcoin)\b|\b(crypto|bitcoin)\b.*\b(ban|crackdown)\b/i, sev: 'MEDIUM', assets: { BTC: 'down', CRYPTO_TOTAL: 'down' }, reason: 'Crypto ban / crackdown' },
  { re: /\b(ceasefire|truce|peace deal)\b/i, sev: 'MEDIUM', assets: { CRUDE: 'down', GOLD: 'down', SPX: 'up' }, reason: 'Ceasefire / peace headline' },
  { re: /\b(oil|crude)\b.*\b(surges?|plunges?|jumps?|tumbles?|spikes?)\b/i, sev: 'MEDIUM', assets: { CRUDE: 'mixed' }, reason: 'Sharp oil move' },
  { re: /\btrading (halted|suspended)\b/i, sev: 'MEDIUM', assets: { SPX: 'down' }, reason: 'Trading halt' },
  { re: /\b(rbi|sebi)\b.*\b(bans?|restricts?|caps?|surprise|repo rate)\b/i, sev: 'MEDIUM', assets: { NIFTY: 'mixed', BANKNIFTY: 'mixed', USDINR: 'mixed' }, reason: 'RBI/SEBI action' },
  { re: /\b(credit rating|sovereign rating)\b.*\bdowngrade[sd]?\b|\bdowngrade[sd]?\b.*\b(credit rating|sovereign rating)\b/i, sev: 'MEDIUM', assets: { SPX: 'down', USDINR: 'up' }, reason: 'Sovereign rating downgrade' },

];

const NEGATION = /\b(no plans?|not|rules? out|denies|denied|averted|avoid(s|ed)?|unlikely|fears? of|could|may|might|if)\b/i;
const DOWNGRADE: Record<Severity, Severity> = { WORLD_ENDING: 'HIGH', HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'LOW' };

export function scoreByKeywords(title: string, summary = ''): ScoredHeadline {
  const text = `${title} ${summary}`.slice(0, 500);
  let best: Rule | null = null;
  for (const r of RULES) if (r.re.test(text) && (!best || rank(r.sev) > rank(best.sev))) best = r;
  if (!best) return { is_market_moving: false, severity: 'NONE', affected_assets: [], likely_direction: {}, one_line_reason: 'No market-moving keyword match' };
  let sev = best.sev;
  if (NEGATION.test(title)) sev = DOWNGRADE[sev];
  return {
    is_market_moving: sev !== 'LOW',
    severity: sev,
    affected_assets: Object.keys(best.assets),
    likely_direction: { ...best.assets } as Record<string, 'up' | 'down' | 'mixed'>,
    one_line_reason: `${best.reason} (keyword match, no LLM)`,
  };
}

/** Cheap relevance pre-filter for general feeds so the LLM only sees plausible market news. */
const RELEVANT = /\b(war|attack|strike|missile|invasion|troops|sanction|tariff|embargo|oil|crude|opec|gas|gold|bank|banks|fed|ecb|rbi|boj|boe|central bank|rate|rates|inflation|cpi|gdp|jobs|payrolls|recession|default|debt|bond|yield|stock|stocks|shares|market|markets|crash|plunge|surge|rout|halt|halted|circuit|bitcoin|crypto|ether|ethereum|solana|stablecoin|exchange|etf|sec|regulator|ban|hack|collapse|bankrupt\w*|bailout|rupee|sensex|nifty|dollar|yuan|treasury|shutdown|election|coup|nuclear|ceasefire|earthquake|pandemic|outbreak|ai|chip|chips|nvidia)\b/i;
const IRRELEVANT = /\b(celebrity|royal|oscars?|grammys?|football|cricket|premier league|nba|nfl|tennis|golf|recipe|horoscope|movie|film review|fashion|wedding|podcast|obituary)\b/i;

export function looksRelevant(title: string): boolean {
  if (IRRELEVANT.test(title) && !/\b(war|market|stocks?|oil|bank)\b/i.test(title)) return false;
  return RELEVANT.test(title);
}
