// Weekly "tune my thresholds" summary (GitHub Actions, Sunday 09:00 IST): counts from the alert history + hints.
import { config } from '../agent.config';
import { SupabaseStore } from '../src/db/supabase';
import { sendPlain } from '../src/notify/plain';
import { hasFlag, loadEnv, requireEnv } from './_env';

const env = loadEnv();
const dry = hasFlag('--dry');
requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
if (!dry) requireEnv(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const store = new SupabaseStore(env);
const since = new Date(Date.now() - 7 * 86400_000).toISOString();
const rows = await store.query<any>(`alerts?select=severity,status,kind,asset_ids,reason,channels&created_at=gte.${since}&kind=neq.test&kind=neq.digest&limit=5000`);

const count = (f: (r: any) => boolean) => rows.filter(f).length;
const sent = rows.filter((r) => r.status === 'sent' && r.kind !== 'system');
const bySev = (s: string) => count((r) => r.severity === s && r.status === 'sent' && r.kind !== 'system');
const perAsset = new Map<string, number>();
for (const r of sent) for (const a of r.asset_ids ?? []) perAsset.set(a, (perAsset.get(a) ?? 0) + 1);
const noisy = [...perAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
const reasons = new Map<string, number>();
for (const r of rows) if (r.status === 'suppressed') reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
const failover = count((r) => (r.channels ?? []).includes('telegram') && !(r.channels ?? []).includes('whatsapp'));

const lines = [
  '📊 Weekly agent review (last 7 days)',
  `Instant alerts sent: ${sent.length} (🚨 ${bySev('WORLD_ENDING')} · 🔴 ${bySev('HIGH')} · 🟡 ${bySev('MEDIUM')})`,
  `Digest-only (LOW): ${count((r) => r.status === 'digested' || r.status === 'digest_pending')} · Suppressed: ${count((r) => r.status === 'suppressed')}`,
  `Needed Telegram failover: ${failover} · Failed outright: ${count((r) => r.status === 'failed')}`,
];
if (noisy.length) lines.push(`Noisiest: ${noisy.map(([a, n]) => `${a} ${n}`).join(', ')}`);
if (reasons.size) lines.push(`Suppression reasons: ${[...reasons.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
const tips: string[] = [];
if (noisy[0] && noisy[0][1] >= 8) tips.push(`${noisy[0][0]} fired ${noisy[0][1]}x: consider raising its dailyVolPct or floorPct in agent.config.ts.`);
if (sent.length === 0) tips.push('No instant alerts at all: quiet week, or thresholds are too high.');
if (failover > 3) tips.push('Several alerts needed Telegram: check CallMeBot activation (query 5/6 in sql/review-queries.sql).');
lines.push(...tips.map((t) => `Tip: ${t}`), 'Full queries: sql/review-queries.sql');
const text = lines.join('\n');
console.log(text);
if (!dry) {
  const r = await sendPlain(env, config, text, {});
  if (!r.ok) process.exit(1);
}
