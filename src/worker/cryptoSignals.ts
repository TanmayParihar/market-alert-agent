import type { AlertCandidate, LastAlert, Severity } from '../types';
import { decideCooldown } from '../core/cooldown';
import { fetchBybitOiDrops, fetchOkxLiquidations, tierFor } from '../providers/crypto';
import { errMsg } from '../util/http';
import { emit, emitSuppressed, setKv, type Ctx } from './ctx';
import { trackSource } from './health';

const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(0)}M`);

function gate(ctx: Ctx, key: 'liq' | 'oi', sev: Severity, cand: AlertCandidate): void {
  const cd: Record<string, LastAlert> = { ...(ctx.kv.cd ?? {}) };
  const d = decideCooldown({
    severity: sev, window: 'level', pct: 0, nowMs: ctx.now, last: cd[key] ?? null, cooldownMin: ctx.cfg.cooldownMin, sigmaDaily: 1, extensionSigma: 1,
  });
  if (!d.allow) { emitSuppressed(ctx, cand, d.reason); return; }
  cd[key] = { severity: sev, at: ctx.now, pct: 0, window: 'level' };
  setKv(ctx, 'cd', cd);
  emit(ctx, cand, 'pending');
}

/** Large crypto liquidation events: OKX liquidation feed (USD) and Bybit open-interest collapse (cascade proxy). */
export async function runCryptoSignals(ctx: Ctx): Promise<void> {
  const c = ctx.cfg.crypto;
  const bucket = Math.floor(ctx.now / (15 * 60_000));

  if (c.liquidations.enabled && ctx.minute % c.liquidations.everyMin === 0) {
    try {
      const r = await fetchOkxLiquidations(c.liquidations.windowMin, ctx.now, ctx.o);
      trackSource(ctx, 'okx-liq', 'OKX liquidation feed', true, undefined, ctx.cfg.health.sourceFailAfter);
      const sev = tierFor(r.usd, c.liquidations.usdThresholds);
      if (sev) {
        const longShare = r.usd ? (r.longUsd / r.usd) * 100 : 0;
        gate(ctx, 'liq', sev, {
          dedupeKey: `crypto:liq:${sev}:${bucket}`, kind: 'crypto', severity: sev,
          headline: `${fmtUsd(r.usd)} crypto liquidated in ${c.liquidations.windowMin} minutes`,
          what: `OKX perpetuals (BTC/ETH/SOL): ${fmtUsd(r.usd)} liquidated in ${c.liquidations.windowMin} min, ${longShare.toFixed(0)}% longs. A cascade is usually accompanied by sharp BTC/ETH moves.`,
          impact: longShare >= 50 ? 'BTC, ETH, SOL, CRYPTO_TOTAL ↓ (long liquidations; likely direction, not a forecast)' : 'BTC, ETH, SOL, CRYPTO_TOTAL ↑ (short squeeze; likely direction, not a forecast)',
          source: `OKX (${r.host})`, sourceTime: ctx.now, assetIds: ['BTC', 'ETH', 'SOL', 'CRYPTO_TOTAL'], payload: { usd: r.usd, n: r.n },
        });
      }
    } catch (e) {
      trackSource(ctx, 'okx-liq', 'OKX liquidation feed', false, errMsg(e), ctx.cfg.health.sourceFailAfter);
    }
  }

  if (c.openInterest.enabled && ctx.minute % c.openInterest.everyMin === 1) {
    try {
      const drops = await fetchBybitOiDrops(['BTCUSDT', 'ETHUSDT'], ctx.o);
      trackSource(ctx, 'bybit-oi', 'Bybit open-interest feed', true, undefined, ctx.cfg.health.sourceFailAfter);
      const worst = drops.sort((a, b) => b.dropPct - a.dropPct)[0];
      const sev = worst ? tierFor(worst.dropPct, c.openInterest.dropPctThresholds) : null;
      if (worst && sev) {
        gate(ctx, 'oi', sev, {
          dedupeKey: `crypto:oi:${sev}:${bucket}`, kind: 'crypto', severity: sev,
          headline: `${worst.symbol.replace('USDT', '')} open interest down ${worst.dropPct.toFixed(1)}% in 15 min`,
          what: `Bybit ${worst.symbol} open interest fell ${worst.dropPct.toFixed(1)}% from its 15-minute peak: positions are being force-closed (liquidation cascade proxy).`,
          impact: 'BTC, ETH, SOL, CRYPTO_TOTAL volatile; downside more likely if price is falling (likely direction, not a forecast)',
          source: 'Bybit', sourceTime: ctx.now, assetIds: ['BTC', 'ETH', 'SOL', 'CRYPTO_TOTAL'], payload: { drops },
        });
      }
    } catch (e) {
      trackSource(ctx, 'bybit-oi', 'Bybit open-interest feed', false, errMsg(e), ctx.cfg.health.sourceFailAfter);
    }
  }
}
