import type { AgentConfig, AlertStatus, DeliveryAttempt, Env, Severity } from '../types';
import { atLeast } from '../core/severity';
import { mergeAlerts, type Msgable } from '../core/format';
import { sleep } from '../util/http';
import { sendTelegram, sendWhatsApp, type ChannelIO, type SendResult } from './channels';

export interface DeliverItem {
  id: string;
  msg: Msgable;
  severity: Severity;
  /** force both channels (system failure alerts) */
  forceBoth?: boolean;
  priorAttempts?: number;
}

export interface Outcome {
  id: string;
  status: AlertStatus; // 'sent' | 'pending' | 'failed'
  channels: string[];
  attempts: DeliveryAttempt[];
  reason?: string;
}

export interface WaState {
  fails: number;
  down: boolean;
}

export interface DeliverResult {
  outcomes: Outcome[];
  wa: WaState;
  waChanged: boolean;
}

const WA_FAILOVER_PREFIX = '⚠️ WhatsApp delivery failed - sent via Telegram\n\n';
const MAX_ATTEMPT_ROUNDS = 12; // roughly 12 minutes of retrying before an alert is marked failed

/**
 * Delivery policy
 *  - MEDIUM: WhatsApp first. If WhatsApp fails after retries+backoff, the SAME text goes to Telegram with a failure note.
 *  - HIGH / WORLD-ENDING (and forced system alerts): BOTH channels every time, in parallel, no waiting for a failure.
 *  - Same-run alerts are merged into one message per channel; what does not fit stays 'pending' for the next minute.
 *  - Nothing is dropped: an alert that no channel accepted stays 'pending' and is retried each minute.
 *  - Consecutive WhatsApp failures -> ONE "WhatsApp looks down" Telegram note, and ONE note when it recovers.
 */
export async function deliver(items: DeliverItem[], env: Env, cfg: AgentConfig, wa: WaState, io: ChannelIO): Promise<DeliverResult> {
  const outcomes: Outcome[] = [];
  const now = (io.now ?? Date.now)();
  const sl = io.sleepFn ?? sleep;
  let state: WaState = { ...wa };
  let waChanged = false;

  const both = items.filter((i) => i.forceBoth || atLeast(i.severity, cfg.channels.bothChannelsFrom));
  const normal = items.filter((i) => !both.includes(i));
  const maxMsgs = cfg.channels.maxMessagesPerRun;

  const noteWa = async (ok: boolean) => {
    const before = state;
    if (ok) {
      state = { fails: 0, down: false };
      if (before.down) {
        waChanged = true;
        await sendTelegram(env, '✅ WhatsApp delivery has recovered. Alerts are flowing to WhatsApp again.', cfg, io);
      } else if (before.fails) waChanged = true;
    } else {
      const fails = before.fails + 1;
      state = { fails, down: before.down };
      waChanged = true;
      if (fails >= cfg.channels.whatsappDownAfter && !before.down) {
        state.down = true;
        await sendTelegram(env, `⚠️ WhatsApp looks down: ${fails} sends in a row failed (CallMeBot). HIGH/WORLD-ENDING alerts keep going to Telegram; I will tell you when WhatsApp recovers.`, cfg, io);
      }
    }
  };

  const record = (list: DeliverItem[], ok: boolean, channels: string[], attempts: DeliveryAttempt[]) => {
    for (const it of list) {
      const rounds = (it.priorAttempts ?? 0) + 1;
      outcomes.push({
        id: it.id,
        status: ok ? 'sent' : rounds >= MAX_ATTEMPT_ROUNDS ? 'failed' : 'pending',
        channels: ok ? channels : [],
        attempts,
        reason: ok ? undefined : rounds >= MAX_ATTEMPT_ROUNDS ? 'all channels failed repeatedly' : 'delivery failed, will retry',
      });
    }
  };

  // ---- BOTH group: WhatsApp and Telegram in parallel, always (same messages on both channels)
  if (both.length) {
    const merged = mergeAlerts(both.map((b) => b.msg), cfg.channels.whatsappMaxChars, maxMsgs, now);
    if (merged.messages.length) {
      const [w, t] = await Promise.all([
        sendSeq(merged.messages, (x) => sendWhatsApp(env, x, cfg, io), sl),
        sendSeq(merged.messages, (x) => sendTelegram(env, x, cfg, io), sl),
      ]);
      await noteWa(w.ok);
      const channels = [...(w.ok ? ['whatsapp'] : []), ...(t.ok ? ['telegram'] : [])];
      record(both.filter((_, i) => merged.included.includes(i)), channels.length > 0, channels, [...w.attempts, ...t.attempts]);
    }
    for (const i of merged.overflowed) outcomes.push({ id: both[i].id, status: 'pending', channels: [], attempts: [], reason: 'queued: message limit this minute' });
  }

  // ---- NORMAL group: WhatsApp first, Telegram only on failure
  if (normal.length) {
    const used = both.length ? Math.max(1, Math.min(maxMsgs - 1, Math.ceil(both.length / 4))) : 0;
    const allowed = Math.max(1, maxMsgs - used);
    const m = mergeAlerts(normal.map((n) => n.msg), cfg.channels.whatsappMaxChars, allowed, now);
    if (m.messages.length) {
      const w = await sendSeq(m.messages, (x) => sendWhatsApp(env, x, cfg, io), sl);
      await noteWa(w.ok);
      let ok = w.ok;
      let channels = w.ok ? ['whatsapp'] : [];
      let attempts = w.attempts;
      if (!w.ok) {
        const msgs = m.messages.map((x, i) => (i === 0 ? WA_FAILOVER_PREFIX + x : x));
        const t = await sendSeq(msgs, (x) => sendTelegram(env, x, cfg, io), sl);
        ok = t.ok;
        channels = t.ok ? ['telegram'] : [];
        attempts = [...w.attempts, ...t.attempts];
      }
      record(normal.filter((_, i) => m.included.includes(i)), ok, channels, attempts);
    }
    for (const i of m.overflowed) outcomes.push({ id: normal[i].id, status: 'pending', channels: [], attempts: [], reason: 'queued: message limit this minute' });
  }

  return { outcomes, wa: state, waChanged };
}

/** Send messages one after another with a >1 s gap (Telegram allows ~1 msg/s per chat). */
async function sendSeq(msgs: string[], send: (t: string) => Promise<SendResult>, sl: (ms: number) => Promise<void>): Promise<SendResult> {
  const attempts: DeliveryAttempt[] = [];
  let ok = msgs.length > 0;
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0) await sl(1100);
    const r = await send(msgs[i]);
    attempts.push(...r.attempts);
    if (!r.ok) ok = false;
  }
  return { ok, attempts };
}
