import type { AgentConfig, MacroEventRow, Snapshot } from '../types';
import { fmtNum } from '../core/priceTriggers';
import { formatIST, IST } from '../util/time';
import { sanitize } from '../util/text';

export interface DigestLow { created_at: string; headline: string; kind: string; asset_ids: string[] }

export interface DigestInput {
  kind: 'india' | 'us';
  nowMs: number;
  cfg: AgentConfig;
  snaps: Map<string, Snapshot>;
  low: DigestLow[];
  events: MacroEventRow[];
  /** worker heartbeat (kv.heartbeat) */
  heartbeat: { at: number } | null;
  waDown: boolean;
  llmPct: number | null;
  missing: string[];
}

const GROUPS: Record<'india' | 'us', Array<{ label: string; ids: string[] }>> = {
  india: [
    { label: 'US close', ids: ['SPX', 'NDX', 'DJI'] },
    { label: 'Volatility', ids: ['VIX', 'INDIAVIX'] },
    { label: 'Commodities', ids: ['GOLD', 'SILVER', 'CRUDE', 'NATGAS'] },
    { label: 'FX', ids: ['USDINR', 'DXY'] },
    { label: 'Crypto (24h)', ids: ['BTC', 'ETH', 'SOL', 'CRYPTO_TOTAL'] },
    { label: 'India (last close)', ids: ['NIFTY', 'SENSEX', 'BANKNIFTY'] },
  ],
  us: [
    { label: 'India close', ids: ['NIFTY', 'SENSEX', 'BANKNIFTY'] },
    { label: 'Volatility', ids: ['VIX', 'INDIAVIX'] },
    { label: 'Commodities', ids: ['GOLD', 'SILVER', 'CRUDE', 'NATGAS'] },
    { label: 'FX', ids: ['DXY', 'USDINR'] },
    { label: 'Crypto (24h)', ids: ['BTC', 'ETH', 'SOL', 'CRYPTO_TOTAL'] },
    { label: 'US (last close / futures pre-open)', ids: ['SPX', 'NDX', 'DJI'] },
  ],
};

const short: Record<string, string> = { SPX: 'S&P', NDX: 'Nasdaq', DJI: 'Dow', NIFTY: 'Nifty', SENSEX: 'Sensex', BANKNIFTY: 'BankNifty', VIX: 'VIX', INDIAVIX: 'IndiaVIX', GOLD: 'Gold', SILVER: 'Silver', CRUDE: 'Crude', NATGAS: 'NatGas', USDINR: 'USD/INR', DXY: 'DXY', BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', CRYPTO_TOTAL: 'Total' };

function move(s: Snapshot | undefined): string | null {
  if (!s) return null;
  if (!s.prevClose) return fmtNum(s.price);
  const p = ((s.price - s.prevClose) / s.prevClose) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(Math.abs(p) >= 10 ? 1 : 2)}%`;
}

/** Plain-text digest, readable on a phone. Pure: all inputs injected, so it is unit-tested. */
export function buildDigest(i: DigestInput): string {
  const { nowMs } = i;
  const title = i.kind === 'india' ? '🌅 India pre-open digest' : '🌆 US pre-open digest';
  const dateStr = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: '2-digit', month: 'short' }).format(nowMs);
  const lines: string[] = [`${title} · ${dateStr} ${formatIST(nowMs, nowMs).replace(' IST', '')} IST`];

  if (i.kind === 'india') {
    const ageMin = i.heartbeat ? Math.round((nowMs - i.heartbeat.at) / 60000) : null;
    const alive = ageMin !== null && ageMin <= i.cfg.health.workerStaleMinutes;
    lines.push(
      alive
        ? `✅ Agent alive · Worker last ran ${ageMin} min ago${i.waDown ? ' · ⚠️ WhatsApp flagged down' : ''}${i.llmPct !== null ? ` · LLM ${i.llmPct.toFixed(0)}% of daily cap` : ''}`
        : `⚠️ Worker last ran ${ageMin === null ? 'never' : ageMin + ' min ago'} - check Cloudflare`,
    );
  }

  lines.push('', 'Moves vs previous close:');
  for (const g of GROUPS[i.kind]) {
    const parts = g.ids.map((id) => {
      const m = move(i.snaps.get(id));
      return m ? `${short[id] ?? id} ${m}` : null;
    }).filter(Boolean);
    if (parts.length) lines.push(`${g.label}: ${parts.join(' · ')}`);
  }
  const lv = (id: string) => i.snaps.get(id)?.price;
  if (lv('VIX') || lv('INDIAVIX')) lines.push(`Levels: VIX ${lv('VIX') ? fmtNum(lv('VIX')!) : 'n/a'} · India VIX ${lv('INDIAVIX') ? fmtNum(lv('INDIAVIX')!) : 'n/a'} · USD/INR ${lv('USDINR') ? fmtNum(lv('USDINR')!) : 'n/a'}`);
  if (i.missing.length) lines.push(`(no data: ${i.missing.join(', ')})`);

  lines.push('', `⚪ LOW items since last digest (${i.low.length}):`);
  if (!i.low.length) lines.push('• none');
  for (const l of i.low.slice(0, i.cfg.digest.maxLowItems)) lines.push(`• ${formatIST(Date.parse(l.created_at), nowMs).replace(' IST', '')} ${sanitize(l.headline, 90)}`);
  if (i.low.length > i.cfg.digest.maxLowItems) lines.push(`• +${i.low.length - i.cfg.digest.maxLowItems} more (see history)`);

  lines.push('', 'Macro in next 24h (IST):');
  const ev = i.events.filter((e) => e.impact === 'High' || e.watch);
  if (!ev.length) lines.push('• none flagged');
  for (const e of ev.slice(0, 10)) {
    const facts = [e.forecast ? `fcst ${e.forecast}` : '', e.previous ? `prev ${e.previous}` : ''].filter(Boolean).join(', ');
    lines.push(`• ${formatIST(Date.parse(e.event_time), nowMs).replace(' IST', '')} ${e.country} ${sanitize(e.title, 50)}${facts ? ` (${facts})` : ''}${e.approx ? ' ~date approx' : ''}`);
  }
  lines.push('', 'Informational only, not advice.');
  return lines.join('\n');
}
