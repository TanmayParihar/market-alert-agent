// Macro-calendar refresh (GitHub Actions, daily + on demand from the Worker).
// Sources:
//   1) ForexFactory's published export feed (nfs.faireconomy.media): this week + next week. Forecast/previous only (NO actuals).
//      It rate-limits aggressively, so it is fetched here twice a day at most - never per minute.
//   2) agent.config.ts fixedEvents: FOMC, RBI MPC and India data schedules the feed does not cover (second source).
import { config } from '../agent.config';
import { SupabaseStore } from '../src/db/supabase';
import { matchRule } from '../src/core/macro';
import { HttpError, request, sleep, errMsg } from '../src/util/http';
import { hash } from '../src/util/text';
import { zonedTimeToUtc } from '../src/util/time';
import type { MacroEventRow } from '../src/types';
import { hasFlag, loadEnv, requireEnv } from './_env';

const env = loadEnv();
const dry = hasFlag('--dry');
if (!dry) requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
const now = Date.now();
const rows: MacroEventRow[] = [];
let ffFailures = 0;

/** `required`: this week's file must exist. Next week's file is only published late in the week: 404 there is normal. */
async function ff(path: string, required: boolean): Promise<any[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { text } = await request(`https://nfs.faireconomy.media/${path}`, { timeoutMs: 15000 });
      const j = JSON.parse(text);
      if (!Array.isArray(j)) throw new Error('not an array');
      return j;
    } catch (e) {
      const notPublished = e instanceof HttpError && e.status === 404;
      if (!required && notPublished) { console.log(`${path}: not published yet (normal early in the week)`); return []; }
      console.warn(`faireconomy ${path} attempt ${attempt}: ${errMsg(e)}`);
      if (attempt < 3) await sleep(attempt * 20_000);
    }
  }
  if (required) ffFailures++;
  return [];
}

const ffEvents = [...(await ff('ff_calendar_thisweek.json', true)), ...(await ff('ff_calendar_nextweek.json', false))];
for (const e of ffEvents) {
  if (!config.macro.ffImpacts.includes(e.impact) || !config.macro.ffCountries.includes(e.country)) continue;
  const t = Date.parse(e.date);
  if (!Number.isFinite(t)) continue;
  const rule = matchRule(config, e.title, e.country);
  rows.push({
    id: `ff:${hash(`${e.title}|${e.country}|${e.date}`)}`, source: 'faireconomy', title: e.title, country: e.country, impact: e.impact,
    event_time: new Date(t).toISOString(), forecast: e.forecast || null, previous: e.previous || null, actual: null, status: 'scheduled',
    watch: !!rule, approx: false, resolver: rule?.resolver ?? null, attempts: 0, meta: {},
  });
}

for (const f of config.macro.fixedEvents) {
  const t = zonedTimeToUtc(f.date, f.time, f.tz);
  if (t < now - 86400_000 || t > now + 90 * 86400_000) continue;
  // skip if the feed already carries the same decision that day (avoid duplicate heads-ups)
  if (f.country === 'USD' && /fomc|fed/i.test(f.title) && rows.some((r) => r.country === 'USD' && /^Federal Funds Rate$/i.test(r.title) && Math.abs(Date.parse(r.event_time) - t) < 6 * 3600_000)) continue;
  rows.push({
    id: `cfg:${hash(`${f.title}|${f.date}`)}`, source: 'config', title: f.title, country: f.country, impact: f.impact,
    event_time: new Date(t).toISOString(), forecast: f.forecast ?? null, previous: null, actual: null, status: 'scheduled',
    watch: true, approx: !!f.approx, resolver: f.resolver ?? null, attempts: 0, meta: { hintHigher: f.hintHigher, hintLower: f.hintLower },
  });
}

const upcoming = rows.filter((r) => Date.parse(r.event_time) > now);
console.log(`calendar: ${rows.length} events (${ffEvents.length} from feed, ${rows.filter((r) => r.source === 'config').length} fixed), ${upcoming.length} upcoming, ${rows.filter((r) => r.watch).length} watched`);
for (const r of upcoming.slice(0, 12)) console.log(`  ${r.event_time} ${r.country} ${r.title}${r.watch ? ' *' : ''}`);
if (dry) process.exit(0);

const store = new SupabaseStore(env);
if (rows.length) await store.apply({ events_upsert: rows });
console.log('pruned:', JSON.stringify(await store.rpc('agent_prune', {})));
if (ffFailures > 0) {
  console.error("This week's faireconomy feed failed (fixed events were still stored). Failing the run so GitHub emails you.");
  process.exit(1);
}
