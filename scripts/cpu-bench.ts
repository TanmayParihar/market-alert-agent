// npm run bench
// Estimates the CPU cost of one Worker minute against the Workers Free limit (10 ms CPU per invocation).
// Real network bodies are downloaded first (network time is NOT CPU), then runTick runs on those cached bodies with
// a high-resolution clock around it (fetch is stubbed and resolves instantly, so wall time ~ CPU time and is an upper
// bound; process.cpuUsage() is useless on Windows: 15.6 ms resolution). First run = cold JIT, then warm runs.
// Node/V8 is the same engine family as Workers, but treat the result as an estimate: confirm in
// Cloudflare dashboard -> Workers -> market-alert-agent -> Metrics -> CPU time.
import { config } from '../agent.config';
import { MemoryStore } from '../src/db/memory';
import { runTick } from '../src/worker/tick';
import { loadEnv } from './_env';

const env = { ...loadEnv(), DRY_RUN: '1' };
const UA = { 'user-agent': 'Mozilla/5.0' };
const cache = new Map<string, { status: number; body: string }>();
const real = globalThis.fetch;

async function prefetch(url: string) {
  try {
    const r = await real(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    cache.set(url, { status: r.status, body: await r.text() });
  } catch { cache.set(url, { status: 599, body: '' }); }
}
const urls = new Set<string>();
const spy = async (url: string) => { urls.add(url); return new Response('', { status: 599 }); };

// 1) discover which URLs a minute touches (sync stub), 2) download them once, 3) measure with cached bodies
const probeStore = new MemoryStore();
for (let m = 0; m < 6; m++) await runTick({ env, cfg: config, store: probeStore, nowMs: Date.UTC(2026, 10, 13, 9, m), fetch: spy as any, io: { dryRun: true, sleepFn: async () => {} } });
await Promise.all([...urls].map(prefetch));

const serve = (async (url: string) => {
  const c = cache.get(url) ?? { status: 404, body: '' };
  return new Response(c.body, { status: c.status });
}) as any;

const store = new MemoryStore();
const base = Math.floor(Date.now() / 60000) * 60000;
const rows: Array<{ minute: number; cpuMs: number; subrequests: number }> = [];
for (let m = 0; m < 40; m++) {
  const t0 = process.hrtime.bigint();
  const s = await runTick({ env, cfg: config, store, nowMs: base + m * 60_000, fetch: serve, io: { dryRun: true, sleepFn: async () => {} } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ minute: m, cpuMs: Math.round(ms * 10) / 10, subrequests: s.subrequests });
}
console.table(rows.slice(0, 8));
const warm = rows.slice(3).map((r) => r.cpuMs).sort((a, b) => a - b);
const q = (p: number) => warm[Math.min(warm.length - 1, Math.floor(p * warm.length))];
console.log(`cold first minute: ${rows[0].cpuMs} ms | warm p50: ${q(0.5)} ms | p95: ${q(0.95)} ms | max: ${warm[warm.length - 1]} ms | limit: 10 ms (Workers Free)`);
// Averaged over many warm minutes, process CPU time is accurate even with a coarse timer.
console.log = () => {}; // silence dry-run output so printing is not measured
const N = 300;
const c0 = process.cpuUsage();
const w0 = process.hrtime.bigint();
for (let m = 40; m < 40 + N; m++) {
  await runTick({ env, cfg: config, store, nowMs: base + m * 60_000, fetch: serve, io: { dryRun: true, sleepFn: async () => {} } });
}
const c = process.cpuUsage(c0);
const wall = Number(process.hrtime.bigint() - w0) / 1e6;
console.error(`warm average over ${N} minutes: CPU ${((c.user + c.system) / 1000 / N).toFixed(2)} ms/minute (wall ${(wall / N).toFixed(2)} ms/minute)`);
console.error(`max subrequests in any minute: ${Math.max(...rows.map((r) => r.subrequests))} (limit 50)`);
