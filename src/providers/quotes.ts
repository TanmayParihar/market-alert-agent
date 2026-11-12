// Price providers. Each returns Snapshots keyed by asset id. All are keyless.
//   Yahoo spark  : ONE call for every symbol, 5-minute series included (unofficial API)
//   CNBC quotes  : ONE call, real-time US/commodity/FX quotes, no series (unofficial API)
//   NSE          : ONE call, real-time Nifty/Bank Nifty/India VIX straight from NSE (unofficial; often blocks cloud IPs)
//   Kraken/Coinbase: crypto spot (official public APIs)
//   CoinGecko/CoinPaprika: total crypto market cap (public APIs)
import type { AssetDef, Sample, Snapshot } from '../types';
import { getJson, type ReqOpts } from '../util/http';

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// ---------------------------------------------------------------- Yahoo
export function parseYahooSpark(json: any, assets: AssetDef[], nowSec: number): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  for (const a of assets) {
    if (!a.yahoo) continue;
    const e = json?.[a.yahoo];
    if (!e || !Array.isArray(e.timestamp) || !Array.isArray(e.close)) continue;
    const series: Sample[] = [];
    const ts: number[] = e.timestamp;
    for (let i = 0; i < ts.length; i++) {
      const c = num(e.close[i]);
      if (c === null || c <= 0) continue;
      // 5-minute bars are stamped with their START; the close belongs to the bar's end (except the live last point)
      const isLast = i === ts.length - 1;
      const t = !isLast && ts[i] % 300 === 0 ? ts[i] + 300 : ts[i];
      if (nowSec - t < 80 * 60) series.push([t, c]);
    }
    const lastIdx = (() => { for (let i = ts.length - 1; i >= 0; i--) if (num(e.close[i]) !== null) return i; return -1; })();
    if (lastIdx < 0) continue;
    const price = num(e.close[lastIdx])!;
    const prev = num(e.previousClose) ?? num(e.chartPreviousClose);
    out.set(a.id, { id: a.id, price, prevClose: prev && prev > 0 ? prev : null, ts: ts[lastIdx], source: 'Yahoo Finance', series });
  }
  return out;
}

export async function fetchYahoo(assets: AssetDef[], nowSec: number, o: ReqOpts): Promise<Map<string, Snapshot>> {
  const syms = assets.filter((a) => a.yahoo).map((a) => encodeURIComponent(a.yahoo!));
  if (!syms.length) return new Map();
  const qs = `symbols=${syms.join(',')}&range=1d&interval=5m`;
  let lastErr: unknown;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const json = await getJson(`https://${host}/v8/finance/spark?${qs}`, o);
      const m = parseYahooSpark(json, assets, nowSec);
      if (m.size) return m;
      lastErr = new Error('Yahoo returned no usable symbols');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- CNBC
export function parseCnbc(json: any, assets: AssetDef[]): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  const quotes: any[] = json?.FormattedQuoteResult?.FormattedQuote ?? [];
  for (const a of assets) {
    if (!a.cnbc) continue;
    const q = quotes.find((x) => x.symbol === a.cnbc);
    if (!q || q.code !== 0) continue;
    const price = num(q.last);
    if (price === null) continue;
    const t = Date.parse(q.last_time);
    out.set(a.id, {
      id: a.id, price, prevClose: num(q.previous_day_closing), ts: Number.isFinite(t) ? Math.floor(t / 1000) : 0,
      source: 'CNBC', halted: q?.EventData?.is_halted === 'Y',
    });
  }
  return out;
}

export async function fetchCnbc(assets: AssetDef[], o: ReqOpts): Promise<Map<string, Snapshot>> {
  const syms = assets.filter((a) => a.cnbc).map((a) => a.cnbc!);
  if (!syms.length) return new Map();
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' +
    syms.map(encodeURIComponent).join('%7C') + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  const m = parseCnbc(await getJson(url, o), assets);
  if (!m.size) throw new Error('CNBC returned no usable symbols');
  return m;
}

// ---------------------------------------------------------------- NSE
export function parseNse(json: any, assets: AssetDef[], nowSec: number): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  const rows: any[] = json?.data ?? [];
  let ts = nowSec;
  const stamp = typeof json?.timestamp === 'string' ? json.timestamp : '';
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
    if (mon >= 0) ts = Math.floor((Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]) - 5.5 * 3600_000) / 1000);
  }
  for (const a of assets) {
    if (!a.nse) continue;
    const r = rows.find((x) => x.index === a.nse);
    const price = num(r?.last);
    if (!r || price === null) continue;
    out.set(a.id, { id: a.id, price, prevClose: num(r.previousClose), ts, source: 'NSE India' });
  }
  return out;
}

export async function fetchNse(assets: AssetDef[], nowSec: number, o: ReqOpts): Promise<Map<string, Snapshot>> {
  const json = await getJson('https://www.nseindia.com/api/allIndices', {
    ...o, headers: { referer: 'https://www.nseindia.com/market-data/live-market-indices', 'accept-language': 'en-US,en;q=0.9', ...(o.headers ?? {}) },
  });
  const m = parseNse(json, assets, nowSec);
  if (!m.size) throw new Error('NSE returned no usable indices');
  return m;
}

// ---------------------------------------------------------------- Crypto spot
export async function fetchKraken(assets: AssetDef[], nowSec: number, o: ReqOpts): Promise<Map<string, Snapshot>> {
  const list = assets.filter((a) => a.kraken);
  if (!list.length) return new Map();
  const json = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${list.map((a) => a.kraken!.pair).join(',')}`, o);
  if (json?.error?.length) throw new Error(`Kraken: ${json.error.join(',')}`);
  const out = new Map<string, Snapshot>();
  for (const a of list) {
    const r = json.result?.[a.kraken!.key] ?? json.result?.[a.kraken!.pair];
    const price = num(r?.c?.[0]);
    if (price === null) continue;
    out.set(a.id, { id: a.id, price, prevClose: num(r?.o), ts: nowSec, source: 'Kraken' });
  }
  if (!out.size) throw new Error('Kraken returned no usable pairs');
  return out;
}

export async function fetchCoinbase(assets: AssetDef[], nowSec: number, o: ReqOpts): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  let lastErr: unknown;
  await Promise.all(
    assets.filter((a) => a.coinbase).map(async (a) => {
      try {
        const j = await getJson(`https://api.exchange.coinbase.com/products/${a.coinbase}/ticker`, o);
        const price = num(j?.price);
        if (price !== null) out.set(a.id, { id: a.id, price, prevClose: null, ts: nowSec, source: 'Coinbase' });
      } catch (e) {
        lastErr = e;
      }
    }),
  );
  if (!out.size && lastErr) throw lastErr;
  return out;
}

// ---------------------------------------------------------------- Total crypto market cap
export async function fetchTotalCap(asset: AssetDef, nowSec: number, o: ReqOpts): Promise<Snapshot> {
  try {
    const j = await getJson('https://api.coingecko.com/api/v3/global', o);
    const cap = num(j?.data?.total_market_cap?.usd);
    const chg = num(j?.data?.market_cap_change_percentage_24h_usd);
    if (cap === null) throw new Error('CoinGecko: no market cap');
    return { id: asset.id, price: cap, prevClose: chg !== null ? cap / (1 + chg / 100) : null, ts: nowSec, source: 'CoinGecko' };
  } catch (first) {
    const j = await getJson('https://api.coinpaprika.com/v1/global', o).catch(() => { throw first; });
    const cap = num(j?.market_cap_usd);
    const chg = num(j?.market_cap_change_24h);
    if (cap === null) throw first;
    return { id: asset.id, price: cap, prevClose: chg !== null ? cap / (1 + chg / 100) : null, ts: nowSec, source: 'CoinPaprika' };
  }
}
