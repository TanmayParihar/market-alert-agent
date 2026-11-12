// HTTP with timeout, subrequest budget and uniform errors. Every external call goes through here.

export class BudgetExceeded extends Error {
  constructor() { super('subrequest budget exhausted'); this.name = 'BudgetExceeded'; }
}

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body: string, public headers?: Headers) {
    super(`HTTP ${status} from ${redact(url)}`);
    this.name = 'HttpError';
  }
}

/** Never leak query-string secrets (API keys, tokens) into logs/errors. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/bot[^/]+/, '/bot***')}${u.search ? '?…' : ''}`;
  } catch {
    return 'url';
  }
}

/**
 * Cloudflare Workers Free allows 50 subrequests per invocation. The budget makes that limit explicit:
 * normal work may use `max - reserve`; delivery and state writes may dip into the reserve.
 */
export class Budget {
  used = 0;
  constructor(public max = 48, public reserve = 10) {}
  take(priority = false): void {
    const limit = priority ? this.max : this.max - this.reserve;
    if (this.used >= limit) throw new BudgetExceeded();
    this.used++;
  }
  get left(): number { return this.max - this.used; }
}

export interface Fetcher { (url: string, init?: RequestInit): Promise<Response> }

export interface ReqOpts {
  fetch?: Fetcher;
  budget?: Budget;
  priority?: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** cap bytes read from the body (protects CPU on huge feeds) */
  maxBytes?: number;
}

export async function request(url: string, o: ReqOpts = {}): Promise<{ res: Response; text: string }> {
  o.budget?.take(o.priority);
  const f: Fetcher = o.fetch ?? ((u, i) => fetch(u, i));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000);
  try {
    const res = await f(url, {
      method: o.method ?? 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; market-alert-agent/1.0)', accept: '*/*', ...(o.headers ?? {}) },
      body: o.body,
      signal: ctrl.signal,
    });
    let text = await res.text();
    if (o.maxBytes && text.length > o.maxBytes) text = text.slice(0, o.maxBytes);
    if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 300), res.headers);
    return { res, text };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`timeout after ${o.timeoutMs ?? 8000}ms: ${redact(url)}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = any>(url: string, o: ReqOpts = {}): Promise<T> {
  const { text } = await request(url, { ...o, headers: { accept: 'application/json', ...(o.headers ?? {}) } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON from ${redact(url)}: ${text.slice(0, 80)}`);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
