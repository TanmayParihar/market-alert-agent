import type { AgentConfig, Env, Severity } from '../types';
import { EMOJI, LABEL, SEVERITIES } from '../core/severity';
import { formatAlert } from '../core/format';
import { sendTelegram, sendWhatsApp, waConfigured, type ChannelIO } from './channels';

const SAMPLE: Record<Severity, { headline: string; what: string; impact: string }> = {
  LOW: { headline: 'Sample: gold up 0.6% in an hour', what: 'Gold at 3,912.40 (+0.62% in 1h). Routine move: this kind of alert only appears in the digest.', impact: 'GOLD ↑, SILVER ↑ (likely direction)' },
  MEDIUM: { headline: 'Sample: Nasdaq down 2.6% on the day', what: 'Nasdaq at 24,810 (-2.61% vs prev close 25,466). 15m -0.4%, 1h -1.1%.', impact: 'NDX weakness → S&P/BTC lower, VIX higher' },
  HIGH: { headline: 'Sample: Fed delivers surprise emergency cut', what: 'Fed cut rates 50 bp between meetings; S&P futures +2.1%, USD falling.', impact: 'GOLD ↑, BTC ↑, USDINR ↓, SPX ↑ (likely direction)' },
  WORLD_ENDING: { headline: 'Sample: Major exchange halts all withdrawals', what: 'Top-tier exchange suspended withdrawals; BTC -9% in 15 min, liquidations accelerating.', impact: 'BTC, ETH, SOL ↓ sharply; Gold, VIX ↑ (likely direction)' },
};

/**
 * Sends one sample alert of each severity through the REAL delivery rules (WhatsApp, Telegram failover, both-channel
 * rule for HIGH/WORLD-ENDING). Samples are spaced out so channel rate limits are respected.
 */
export async function sendSamples(env: Env, cfg: AgentConfig, opts: { dryRun?: boolean; log?: (s: string) => void; only?: Severity[]; gapMs?: number } = {}) {
  const io: ChannelIO = { dryRun: opts.dryRun, log: opts.log };
  const gap = opts.gapMs ?? 2500;
  const results: Array<{ severity: string; whatsapp?: boolean; telegram?: boolean }> = [];
  const now = Date.now();
  for (const sev of opts.only ?? SEVERITIES) {
    if (results.length) await new Promise((r) => setTimeout(r, gap));
    const s = SAMPLE[sev];
    const text = formatAlert({ severity: sev, headline: s.headline, what: s.what, impact: s.impact, source: 'TEST (not a real event)', sourceTime: now }, now);
    const both = sev === 'HIGH' || sev === 'WORLD_ENDING';
    if (!waConfigured(env, io)) {
      const tgOnly = (await sendTelegram(env, text, cfg, io)).ok;
      results.push({ severity: `${EMOJI[sev]} ${LABEL[sev]}`, whatsapp: undefined, telegram: tgOnly });
      continue;
    }
    const wa = await sendWhatsApp(env, text, cfg, io);
    let tg: boolean | undefined;
    if (both) tg = (await sendTelegram(env, text, cfg, io)).ok;
    else if (!wa.ok) tg = (await sendTelegram(env, '⚠️ WhatsApp delivery failed - sent via Telegram\n\n' + text, cfg, io)).ok;
    results.push({ severity: `${EMOJI[sev]} ${LABEL[sev]}`, whatsapp: wa.ok, telegram: tg });
  }
  return results;
}
