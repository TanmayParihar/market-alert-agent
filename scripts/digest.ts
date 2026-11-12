// Daily digests (GitHub Actions slow path).
//   npm run digest -- --kind auto|india|us [--force] [--dry]
// `auto` sends whichever digest is inside its local-time window and has not been sent today. The workflow cron fires at
// both the EDT and EST UTC times; the window check (America/New_York) makes only the right one send => DST-proof.
import { config } from '../agent.config';
import { SupabaseStore } from '../src/db/supabase';
import { buildDigest } from '../src/digest/build';
import { sendPlain } from '../src/notify/plain';
import { fetchPrices } from '../src/providers/prices';
import { llmUsagePct, type LlmUsage } from '../src/llm/score';
import { Budget } from '../src/util/http';
import { inLocalWindow } from '../src/util/time';
import { uuid } from '../src/util/text';
import type { MacroEventRow } from '../src/types';
import { argValue, hasFlag, loadEnv, requireEnv } from './_env';

const env = loadEnv();
const dry = hasFlag('--dry');
const force = hasFlag('--force');
requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
if (!dry) requireEnv(env, ['CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

const kindArg = (argValue('--kind') ?? process.env.DIGEST_KIND ?? 'auto').toLowerCase();
const kinds = (kindArg === 'auto' || kindArg === '' ? ['india', 'us'] : [kindArg]) as Array<'india' | 'us'>;
const now = Date.now();
const store = new SupabaseStore(env);

const kvRows = await store.query<{ key: string; value: any }>('kv?select=key,value&key=in.(heartbeat,wa_state,digest_last,llm)');
const kv: Record<string, any> = Object.fromEntries(kvRows.map((r) => [r.key, r.value]));
let digestLast: Record<string, string> = { ...(kv.digest_last ?? {}) };
let exit = 0;

for (const kind of kinds) {
  const tz = kind === 'india' ? 'Asia/Kolkata' : 'America/New_York';
  const cfgW = kind === 'india' ? { t: config.digest.india.istTime, m: config.digest.india.windowMin } : { t: config.digest.us.etTime, m: config.digest.us.windowMin };
  const w = inLocalWindow(now, tz, cfgW.t, cfgW.m, config.digest.weekdaysOnly);
  if (!force && !w.open) { console.log(`[${kind}] skipped: ${w.reason} (${tz})`); continue; }
  if (!force && digestLast[kind] === w.localDate) { console.log(`[${kind}] already sent for ${w.localDate}`); continue; }

  const pr = await fetchPrices(config, now, { budget: new Budget(60, 0), timeoutMs: 10_000 }, { totalDue: true });
  console.log(`[${kind}] prices: ${pr.snaps.size} assets, missing: ${pr.missing.join(',') || 'none'}, sources:`, JSON.stringify(pr.status));
  const low = await store.query<any>('alerts?select=id,created_at,headline,kind,asset_ids&status=eq.digest_pending&order=created_at.desc&limit=100');
  const until = new Date(now + 24 * 3600_000).toISOString();
  const events = (await store.query<MacroEventRow>(`macro_events?select=*&event_time=gte.${new Date(now).toISOString()}&event_time=lte.${until}&order=event_time.asc&limit=50`));

  const text = buildDigest({
    kind, nowMs: now, cfg: config, snaps: pr.snaps, low, events,
    heartbeat: kv.heartbeat ?? null, waDown: !!kv.wa_state?.down,
    llmPct: kv.llm ? llmUsagePct(kv.llm as LlmUsage, config, env) : null, missing: pr.missing,
  });
  console.log(`\n${text}\n`);
  if (dry) continue;

  const res = await sendPlain(env, config, text, {});
  if (!res.ok) { console.error(`[${kind}] delivery failed on all channels; LOW items stay queued`); exit = 1; continue; }
  digestLast = { ...digestLast, [kind]: w.localDate };
  const id = uuid();
  const nowIso = new Date().toISOString();
  await store.apply({
    alerts_insert: [{
      id, dedupe_key: `digest:${kind}:${w.localDate}${force ? ':' + now : ''}`, kind: 'digest', severity: 'LOW', status: 'sent', reason: null,
      headline: `${kind} digest (${low.length} LOW items)`, what: text.slice(0, 600), impact: null, source: 'GitHub Actions', source_time: nowIso, asset_ids: [], payload: {},
    }],
    alerts_update: [
      { id, status: 'sent', channels: res.channels, delivery: res.attempts, sent_at: nowIso },
      ...low.map((l: any) => ({ id: l.id, status: 'digested' as const, reason: `included in ${kind} digest`, digested_at: nowIso })),
    ],
    kv: { digest_last: digestLast },
  });
  console.log(`[${kind}] sent via ${res.channels.join('+')}; ${low.length} LOW items marked digested`);
}
process.exit(exit);
