// Watchdog for the Worker (GitHub Actions, every 10 min). If the Worker has not completed a run recently, message me on
// BOTH channels (once), remind hourly, and say when it recovers. Silence must never mean "crashed".
import { config } from '../agent.config';
import { SupabaseStore } from '../src/db/supabase';
import { sendPlain } from '../src/notify/plain';
import { formatIST } from '../src/util/time';
import { errMsg } from '../src/util/http';
import { hasFlag, loadEnv, requireEnv } from './_env';

const env = loadEnv();
const dry = hasFlag('--dry');
requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
if (!dry) requireEnv(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const now = Date.now();
const store = new SupabaseStore(env);
const alertBoth = (t: string) => sendPlain(env, config, t, { dryRun: dry }, { both: true });

let rows: Array<{ key: string; value: any }>;
try {
  rows = await store.query('kv?select=key,value&key=in.(heartbeat,heartbeat_alert)');
} catch (e) {
  console.error('Supabase unreachable:', errMsg(e));
  // cannot persist state while the DB is down: remind at most once an hour (first run of each hour)
  if (new Date(now).getUTCMinutes() < 10) {
    await alertBoth(`⚙️ SYSTEM: Supabase unreachable\nThe watchdog could not read the agent database (${errMsg(e).slice(0, 100)}). The Worker cannot save state either, so alerts may be affected.\nSrc: GitHub heartbeat · ${formatIST(now, now)}`);
  }
  process.exit(1);
}
const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
const hb = kv.heartbeat as { at: number } | undefined;
const ageMin = hb ? (now - hb.at) / 60000 : Infinity;
const st = (kv.heartbeat_alert ?? { active: false, at: 0 }) as { active: boolean; at: number; lastReminder?: number };
const stale = ageMin > config.health.workerStaleMinutes;
console.log(`worker heartbeat age: ${Number.isFinite(ageMin) ? ageMin.toFixed(1) + ' min' : 'never'} (limit ${config.health.workerStaleMinutes}) active_alert=${st.active}`);

if (stale && !st.active) {
  const r = await alertBoth(`⚙️ SYSTEM: Worker NOT running\nNo successful Worker run for ${Number.isFinite(ageMin) ? Math.round(ageMin) + ' minutes' : 'ever recorded'} (last: ${hb ? formatIST(hb.at, now) : 'never'}). You are NOT receiving instant alerts. Check Cloudflare dashboard -> Workers -> market-alert-agent -> Logs.\nSrc: GitHub heartbeat · ${formatIST(now, now)}`);
  if (r.ok && !dry) await store.apply({ kv: { heartbeat_alert: { active: true, at: now, lastReminder: now } } });
} else if (stale && st.active && now - (st.lastReminder ?? st.at) > 60 * 60_000) {
  const r = await alertBoth(`⚙️ SYSTEM: Worker STILL down (${Math.round(ageMin)} min). Instant alerts are not running.\nSrc: GitHub heartbeat · ${formatIST(now, now)}`);
  if (r.ok && !dry) await store.apply({ kv: { heartbeat_alert: { ...st, lastReminder: now } } });
} else if (!stale && st.active) {
  const r = await alertBoth(`✅ SYSTEM: Worker is running again (last run ${Math.round(ageMin * 60)}s ago). Instant alerts resumed.\nSrc: GitHub heartbeat · ${formatIST(now, now)}`);
  if (r.ok && !dry) await store.apply({ kv: { heartbeat_alert: { active: false, at: now } } });
}
