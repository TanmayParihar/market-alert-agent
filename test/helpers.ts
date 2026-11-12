import type { Env } from '../src/types';

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | object | string | null;

/** Fake fetch: first matching [regex, handler] wins; unknown URLs -> 404. Records every URL called. */
export function mkFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    for (const [re, h] of routes) {
      if (!re.test(url)) continue;
      const r = await h(url, init);
      if (r instanceof Response) return r;
      if (r === null) return new Response('not found', { status: 404 });
      if (typeof r === 'string') return new Response(r, { status: 200 });
      return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  const count = (re: RegExp) => calls.filter((c) => re.test(c.url)).length;
  return { fetch: fetchFn, calls, count };
}

export const ENV: Env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_KEY: 'sb_secret_test',
  CALLMEBOT_PHONE: '+919999999999',
  CALLMEBOT_APIKEY: '123456',
  TELEGRAM_BOT_TOKEN: '111:AAA',
  TELEGRAM_CHAT_ID: '42',
};

export const noSleep = async () => {};

export const WA = /api\.callmebot\.com/;
export const TG = /api\.telegram\.org/;
export const tgOk = () => ({ ok: true, result: { message_id: 7 } });
export const waOk = () => 'Message queued. You will receive it in a few seconds.';
export const textOf = (call: { url: string; body?: string }) => (WA.test(call.url) ? new URL(call.url).searchParams.get('text') ?? '' : JSON.parse(call.body ?? '{}').text ?? '');
