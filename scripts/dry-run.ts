// npm run dry-run
// Runs the REAL fast path against LIVE public data sources with an in-memory database and prints alerts instead of
// sending them. No secrets needed (without a GROQ_API_KEY, headlines are scored by the keyword fallback).
//   --ticks N       number of simulated minutes (default 3)
//   --replay-news   after tick 1, forget the newest 3 items of every feed so the news pipeline has "new" headlines
import { config } from '../agent.config';
import { MemoryStore } from '../src/db/memory';
import { runTick } from '../src/worker/tick';
import { argValue, hasFlag, loadEnv } from './_env';

const env = { ...loadEnv(), DRY_RUN: '1' };
const store = new MemoryStore();
const ticks = Number(argValue('--ticks') ?? 3);
let now = Math.floor(Date.now() / 60000) * 60000;

for (let i = 1; i <= ticks; i++) {
  console.log(`\n=== tick ${i} @ ${new Date(now).toISOString()} ===`);
  const s = await runTick({ env, cfg: config, store, nowMs: now, io: { dryRun: true, sleepFn: async () => {} } });
  console.log(`ok=${s.ok} ${s.ms}ms subrequests=${s.subrequests} created=${s.created} sent=${s.sent} pending=${s.pendingLeft}`);
  if (s.errors.length) console.log('errors:', s.errors);
  if (s.notes.length) console.log('notes:', s.notes.slice(0, 6));
  for (const r of s.rows) console.log(`  [${r.status}] ${r.severity} ${r.kind}: ${r.headline}${r.reason ? `  (${r.reason})` : ''}`);
  if (i === 1 && hasFlag('--replay-news')) {
    for (const f of Object.values(store.feeds)) f.seen = f.seen.slice(3);
    store.news.length = 0;
  }
  now += 60_000;
}
console.log(`\nstate: ${Object.keys(store.assets).length} assets tracked, ${Object.keys(store.feeds).length} feeds, ${store.alerts.length} alert rows, ${store.news.length} news rows`);
