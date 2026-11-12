import type { AgentConfig, DeliveryAttempt, Env } from '../types';
import { splitText } from '../core/format';
import { sleep } from '../util/http';
import { sendTelegram, sendWhatsApp, waConfigured, type ChannelIO } from './channels';

export interface PlainResult { ok: boolean; channels: string[]; attempts: DeliveryAttempt[] }

/**
 * Send a free-form text (digest, weekly review, heartbeat alert) with the same channel rules as alerts:
 *   default : WhatsApp (chunked) -> Telegram with a failure note if WhatsApp fails
 *   both    : WhatsApp AND Telegram (used for "the agent itself is broken" messages)
 */
export async function sendPlain(env: Env, cfg: AgentConfig, text: string, io: ChannelIO, opts: { both?: boolean } = {}): Promise<PlainResult> {
  const sl = io.sleepFn ?? sleep;
  const attempts: DeliveryAttempt[] = [];
  const waChunks = splitText(text, cfg.channels.whatsappMaxChars);
  const tgChunks = splitText(text, cfg.channels.telegramMaxChars);

  const sendAll = async (chunks: string[], fn: (t: string) => ReturnType<typeof sendWhatsApp>) => {
    let ok = true;
    for (let i = 0; i < chunks.length; i++) {
      if (i) await sl(1500);
      const r = await fn(chunks[i]);
      attempts.push(...r.attempts);
      if (!r.ok) ok = false;
    }
    return ok;
  };

  if (!waConfigured(env, io)) {
    const ok = await sendAll(tgChunks, (x) => sendTelegram(env, x, cfg, io));
    return { ok, channels: ok ? ['telegram'] : [], attempts };
  }
  if (opts.both) {
    const [w, t] = await Promise.all([sendAll(waChunks, (x) => sendWhatsApp(env, x, cfg, io)), sendAll(tgChunks, (x) => sendTelegram(env, x, cfg, io))]);
    return { ok: w || t, channels: [...(w ? ['whatsapp'] : []), ...(t ? ['telegram'] : [])], attempts };
  }
  if (await sendAll(waChunks, (x) => sendWhatsApp(env, x, cfg, io))) return { ok: true, channels: ['whatsapp'], attempts };
  const prefixed = '⚠️ WhatsApp delivery failed - sent via Telegram\n\n' + text;
  const t = await sendAll(splitText(prefixed, cfg.channels.telegramMaxChars), (x) => sendTelegram(env, x, cfg, io));
  return { ok: t, channels: t ? ['telegram'] : [], attempts };
}
