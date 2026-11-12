import type { AgentConfig, AlertCandidate, AlertRow, AlertStatus, Env, Store, TickState } from '../types';
import type { Budget, Fetcher, ReqOpts } from '../util/http';
import { uuid } from '../util/text';

/** Everything one tick shares. `kv` is the working copy; `kvOut` collects what must be written back. */
export interface Ctx {
  env: Env;
  cfg: AgentConfig;
  store: Store;
  now: number;
  minute: number;
  o: ReqOpts;
  budget: Budget;
  fetch?: Fetcher;
  state: TickState;
  kv: Record<string, any>;
  kvOut: Record<string, any>;
  rows: AlertRow[];
  errors: string[];
  notes: string[];
}

export function setKv(ctx: Ctx, key: string, value: unknown): void {
  ctx.kv[key] = value;
  ctx.kvOut[key] = value;
}

export function toRow(c: AlertCandidate, status: AlertStatus, reason: string | null): AlertRow {
  return {
    id: uuid(),
    dedupe_key: c.dedupeKey,
    kind: c.kind,
    severity: c.severity,
    status,
    reason,
    headline: c.headline,
    what: c.what,
    impact: c.impact,
    source: c.source,
    source_time: new Date(c.sourceTime).toISOString(),
    asset_ids: c.assetIds,
    payload: { ...(c.payload ?? {}), ...(c.forceBoth ? { forceBoth: true } : {}), ...(c.marker ? { marker: c.marker } : {}) },
  };
}

export function emit(ctx: Ctx, c: AlertCandidate, status: AlertStatus, reason: string | null = null): void {
  ctx.rows.push(toRow(c, status, reason));
}

/** Suppressed rows get a coarse (30 min) key so a long cooldown does not write a row every minute. */
export function emitSuppressed(ctx: Ctx, c: AlertCandidate, reason: string): void {
  const base = c.dedupeKey.replace(/:\d+$/, '');
  emit(ctx, { ...c, dedupeKey: `${base}:sup:${reason}:${Math.floor(ctx.now / 1_800_000)}` }, 'suppressed', reason);
}

/** A system/health alert: forced to both channels, marker instead of a severity label. */
export function systemAlert(ctx: Ctx, key: string, headline: string, what: string, opts: { bucketMin?: number } = {}): void {
  const bucket = Math.floor(ctx.now / ((opts.bucketMin ?? 60) * 60_000));
  emit(ctx, {
    dedupeKey: `sys:${key}:${bucket}`, kind: 'system', severity: 'MEDIUM', headline, what, impact: '', source: 'Agent health', sourceTime: ctx.now,
    assetIds: [], forceBoth: true, marker: '⚙️ SYSTEM',
  }, 'pending', null);
}
