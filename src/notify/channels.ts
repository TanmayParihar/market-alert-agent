import type { AgentConfig, DeliveryAttempt, Env } from '../types';
import { HttpError, request, sleep, type Budget, type Fetcher } from '../util/http';

export interface ChannelIO {
  fetch?: Fetcher;
  budget?: Budget;
  /** print instead of sending */
  dryRun?: boolean;
  log?: (s: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SendResult { ok: boolean; attempts: DeliveryAttempt[] }

const CALLMEBOT_FAIL = /error|not (valid|activated|registered)|invalid|blocked|wrong|unauthori[sz]ed|forbidden/i;

async function withRetry(
  channel: 'whatsapp' | 'telegram', cfg: AgentConfig, io: ChannelIO, fn: (attempt: number) => Promise<string>, retries: number,
): Promise<SendResult> {
  const attempts: DeliveryAttempt[] = [];
  const sl = io.sleepFn ?? sleep;
  for (let i = 1; i <= retries; i++) {
    try {
      const detail = await fn(i);
      attempts.push({ channel, ok: true, at: new Date((io.now ?? Date.now)()).toISOString(), attempt: i, detail: detail.slice(0, 120) });
      return { ok: true, attempts };
    } catch (e) {
      const msg = e instanceof HttpError ? `HTTP ${e.status}: ${e.body.slice(0, 100)}` : (e as Error).message.slice(0, 120);
      attempts.push({ channel, ok: false, at: new Date((io.now ?? Date.now)()).toISOString(), attempt: i, detail: msg });
      if ((e as Error).name === 'BudgetExceeded') break;
      if (i < retries) {
        let wait = cfg.channels.backoffMs[Math.min(i - 1, cfg.channels.backoffMs.length - 1)] ?? 1500;
        if (e instanceof HttpError && e.status === 429) {
          const ra = Number(/"retry_after":\s*(\d+)/.exec(e.body)?.[1] ?? e.headers?.get('retry-after'));
          if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000 + 200, 4000);
        }
        await sl(wait);
      }
    }
  }
  return { ok: false, attempts };
}

/** CallMeBot WhatsApp (free, personal use, sends only to your own activated number). */
export async function sendWhatsApp(env: Env, text: string, cfg: AgentConfig, io: ChannelIO): Promise<SendResult> {
  if (io.dryRun) {
    (io.log ?? console.log)(`\n[DRY-RUN whatsapp]\n${text}\n`);
    return { ok: true, attempts: [{ channel: 'whatsapp', ok: true, at: new Date().toISOString(), attempt: 1, detail: 'dry-run' }] };
  }
  return withRetry('whatsapp', cfg, io, async () => {
    if (!env.CALLMEBOT_PHONE || !env.CALLMEBOT_APIKEY) throw new Error('CallMeBot secrets missing');
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(env.CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.CALLMEBOT_APIKEY)}`;
    const { text: body } = await request(url, { fetch: io.fetch, budget: io.budget, priority: true, timeoutMs: cfg.channels.timeoutMs });
    // CallMeBot answers HTTP 200 with a human-readable body; "queued" is the only acknowledgement it gives
    if (CALLMEBOT_FAIL.test(body)) throw new Error(`CallMeBot: ${body.replace(/<[^>]+>/g, ' ').slice(0, 100)}`);
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }, cfg.channels.retries);
}

/** Telegram Bot API (official, free). */
export async function sendTelegram(env: Env, text: string, cfg: AgentConfig, io: ChannelIO): Promise<SendResult> {
  if (io.dryRun) {
    (io.log ?? console.log)(`\n[DRY-RUN telegram]\n${text}\n`);
    return { ok: true, attempts: [{ channel: 'telegram', ok: true, at: new Date().toISOString(), attempt: 1, detail: 'dry-run' }] };
  }
  return withRetry('telegram', cfg, io, async () => {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram secrets missing');
    const { text: body } = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      fetch: io.fetch, budget: io.budget, priority: true, timeoutMs: cfg.channels.timeoutMs, method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    const j = JSON.parse(body);
    if (!j.ok) throw new Error(`Telegram: ${j.description ?? 'not ok'}`);
    return `message_id ${j.result?.message_id}`;
  }, 2);
}
