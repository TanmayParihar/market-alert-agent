// Crypto liquidation signals (keyless).
//   1) OKX public liquidation-orders REST feed (perpetual swaps, BTC/ETH/SOL): USD liquidated in the last N minutes.
//   2) Bybit open-interest history: a sharp OI drop is a keyless proxy for a liquidation cascade.
// Neither covers the whole market (OKX and Bybit are two venues among many): thresholds are therefore conservative.
import type { Severity } from '../types';
import { getJson, type ReqOpts } from '../util/http';

const CT_VAL: Record<string, number> = { BTC: 0.01, ETH: 0.1, SOL: 1 }; // contract size in coins, USDT-margined swaps
const OKX_HOSTS = ['www.okx.com', 'us.okx.com', 'eea.okx.com'];

export interface LiqSummary { usd: number; longUsd: number; shortUsd: number; n: number; host: string }

export function summariseOkx(rows: any[], windowMin: number, nowMs: number): { usd: number; longUsd: number; shortUsd: number; n: number } {
  let longUsd = 0, shortUsd = 0, n = 0;
  for (const r of rows) {
    const base = String(r?.uly ?? r?.instFamily ?? '').split('-')[0];
    const ct = CT_VAL[base];
    if (!ct) continue;
    for (const d of r?.details ?? []) {
      const ts = Number(d.ts);
      if (!Number.isFinite(ts) || nowMs - ts > windowMin * 60_000) continue;
      const usd = Number(d.sz) * ct * Number(d.bkPx);
      if (!Number.isFinite(usd)) continue;
      n++;
      if (d.posSide === 'short') shortUsd += usd; else longUsd += usd;
    }
  }
  return { usd: longUsd + shortUsd, longUsd, shortUsd, n };
}

export async function fetchOkxLiquidations(windowMin: number, nowMs: number, o: ReqOpts): Promise<LiqSummary> {
  let lastErr: unknown;
  for (const host of OKX_HOSTS) {
    try {
      const rows: any[] = [];
      for (const uly of ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']) {
        const j = await getJson(`https://${host}/api/v5/public/liquidation-orders?instType=SWAP&uly=${uly}&state=filled`, o);
        if (j?.code !== '0') throw new Error(`OKX code ${j?.code}`);
        rows.push(...(j.data ?? []));
      }
      return { ...summariseOkx(rows, windowMin, nowMs), host };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function tierFor(value: number, th: Record<'MEDIUM' | 'HIGH' | 'WORLD_ENDING', number>): Severity | null {
  if (value >= th.WORLD_ENDING) return 'WORLD_ENDING';
  if (value >= th.HIGH) return 'HIGH';
  if (value >= th.MEDIUM) return 'MEDIUM';
  return null;
}

/** list is newest-first (Bybit order). Drop = peak over the list vs latest, in %. */
export function oiDropPct(list: Array<{ openInterest: string }>): number {
  const vals = list.map((x) => Number(x.openInterest)).filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < 2) return 0;
  const peak = Math.max(...vals);
  return ((peak - vals[0]) / peak) * 100;
}

export async function fetchBybitOiDrops(symbols: string[], o: ReqOpts): Promise<Array<{ symbol: string; dropPct: number }>> {
  const out: Array<{ symbol: string; dropPct: number }> = [];
  let firstErr: unknown;
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const j = await getJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=5min&limit=4`, o);
        if (j?.retCode !== 0) throw new Error(`Bybit retCode ${j?.retCode}`);
        out.push({ symbol: s, dropPct: oiDropPct(j.result?.list ?? []) });
      } catch (e) {
        firstErr ??= e;
      }
    }),
  );
  if (!out.length && firstErr) throw firstErr;
  return out;
}
