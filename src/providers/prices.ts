import type { AgentConfig, AssetDef, Snapshot } from '../types';
import { errMsg, type ReqOpts } from '../util/http';
import { IST, isWeekday, localMinutes } from '../util/time';
import { fetchCnbc, fetchCoinbase, fetchKraken, fetchNse, fetchTotalCap, fetchYahoo } from './quotes';

export interface SourceStatus { ok: boolean; err?: string }
export interface PriceResult {
  snaps: Map<string, Snapshot>;
  status: Record<string, SourceStatus>;
  /** assets for which NO source delivered */
  missing: string[];
}

/**
 * Fetch every asset from TWO independent providers at once and keep the FRESHEST quote per asset:
 *   Yahoo (all symbols, 1 call, has 5-minute history) + CNBC (1 call, real-time VIX/DXY/US indices; futures ~10 min delayed).
 * Measured while building this: Yahoo VIX/DXY/futures timestamps lagged CNBC's by 10-15 min, so "freshest wins" matters.
 * Gaps are then filled by NSE (India) -> Kraken -> Coinbase (crypto); total market cap: CoinGecko -> CoinPaprika.
 * Because both main sources are polled every minute, a broken secondary source is noticed (health tracking), not silent.
 * A source that throws is recorded and skipped; it can never stop the others.
 * `probeAll` (used by /probe) additionally calls every provider even when not needed.
 */
export async function fetchPrices(
  cfg: AgentConfig, nowMs: number, o: ReqOpts, opts: { totalDue: boolean; probeAll?: boolean },
): Promise<PriceResult> {
  const nowSec = Math.floor(nowMs / 1000);
  const snaps = new Map<string, Snapshot>();
  const status: Record<string, SourceStatus> = {};
  const spot = cfg.assets.filter((a) => a.cls !== 'crypto_total');
  const total = cfg.assets.find((a) => a.cls === 'crypto_total');

  const run = async (name: string, fn: () => Promise<Map<string, Snapshot>>, want: AssetDef[]): Promise<Map<string, Snapshot>> => {
    if (!want.length) return new Map();
    try {
      const m = await fn();
      status[name] = { ok: true };
      return m;
    } catch (e) {
      status[name] = { ok: false, err: errMsg(e).slice(0, 160) };
      return new Map();
    }
  };
  const gaps = (pred: (a: AssetDef) => boolean) => spot.filter((a) => (opts.probeAll || !snaps.has(a.id)) && pred(a));
  const take = (m: Map<string, Snapshot>) => { for (const [id, s] of m) if (!snaps.has(id)) snaps.set(id, s); };

  const cnbcWant = spot.filter((a) => !!a.cnbc);
  // NSE (verified reachable from Cloudflare) is the exchange's own live feed: during Indian market hours it competes too
  const m = localMinutes(nowMs, IST);
  const indiaOpen = isWeekday(nowMs, IST) && m >= 9 * 60 && m <= 15 * 60 + 45;
  const nseWant = indiaOpen || opts.probeAll ? spot.filter((a) => !!a.nse) : [];
  const [y, c, n] = await Promise.all([
    run('yahoo', () => fetchYahoo(spot, nowSec, o), spot),
    run('cnbc', () => fetchCnbc(cnbcWant, o), cnbcWant),
    run('nse', () => fetchNse(nseWant, nowSec, o), nseWant),
  ]);
  for (const a of spot) snaps.set(a.id, pickFreshest(y.get(a.id), c.get(a.id), n.get(a.id))!);
  for (const a of spot) if (!snaps.get(a.id)) snaps.delete(a.id);

  take(await run('kraken', () => fetchKraken(gaps((a) => !!a.kraken), nowSec, o), gaps((a) => !!a.kraken)));
  take(await run('coinbase', () => fetchCoinbase(gaps((a) => !!a.coinbase), nowSec, o), gaps((a) => !!a.coinbase)));

  if (total && (opts.totalDue || opts.probeAll)) {
    try {
      const s = await fetchTotalCap(total, nowSec, o);
      status[s.source.toLowerCase()] = { ok: true };
      snaps.set(total.id, s);
    } catch (e) {
      status['coingecko'] = { ok: false, err: errMsg(e).slice(0, 160) };
    }
  }

  const missing = cfg.assets.filter((a) => (a.cls === 'crypto_total' ? opts.totalDue : true) && !snaps.has(a.id)).map((a) => a.id);
  return { snaps, status, missing };
}

/** Freshest timestamp wins; ties go to the first (Yahoo, which carries the 5-minute history). History and previous close are kept from any. */
export function pickFreshest(yahoo?: Snapshot, cnbc?: Snapshot, nse?: Snapshot): Snapshot | undefined {
  const cands = [yahoo, cnbc, nse].filter(Boolean) as Snapshot[];
  if (!cands.length) return undefined;
  let best = cands[0];
  for (const c of cands.slice(1)) if (c.ts > best.ts) best = c;
  return { ...best, series: best.series ?? yahoo?.series, prevClose: best.prevClose ?? cands.find((c) => c.prevClose)?.prevClose ?? null };
}

/**
 * Independent cross-check of a HIGH / WORLD-ENDING price move using a second provider.
 * Returns the secondary snapshot, or null when no second source is reachable (caller then flags "single source").
 */
export async function fetchSecondary(asset: AssetDef, primarySource: string, nowSec: number, o: ReqOpts): Promise<Snapshot | null> {
  const attempts: Array<() => Promise<Map<string, Snapshot>>> = [];
  if (primarySource !== 'CNBC' && asset.cnbc) attempts.push(() => fetchCnbc([asset], o));
  if (primarySource !== 'NSE India' && asset.nse) attempts.push(() => fetchNse([asset], nowSec, o));
  if (primarySource !== 'Kraken' && asset.kraken) attempts.push(() => fetchKraken([asset], nowSec, o));
  if (primarySource !== 'Yahoo Finance' && asset.yahoo) attempts.push(() => fetchYahoo([asset], nowSec, o));
  if (asset.cls === 'crypto_total') attempts.push(async () => new Map([[asset.id, await fetchTotalCap(asset, nowSec, o)]]));
  for (const a of attempts) {
    try {
      const s = (await a()).get(asset.id);
      if (s) return s;
    } catch { /* try next */ }
  }
  return null;
}

/** Do two independent sources agree that a big session move happened? */
export function confirms(primaryPct: number, secondary: Snapshot): boolean {
  if (!secondary.prevClose) return true; // cannot judge: do not block
  const sec = ((secondary.price - secondary.prevClose) / secondary.prevClose) * 100;
  return Math.sign(sec) === Math.sign(primaryPct) && Math.abs(sec) >= Math.abs(primaryPct) * 0.5;
}
