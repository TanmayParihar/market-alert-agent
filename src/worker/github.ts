import type { AgentConfig } from '../types';
import { inLocalWindow, localDate, zonedTimeToUtc } from '../util/time';
import { errMsg, request } from '../util/http';
import { setKv, systemAlert, type Ctx } from './ctx';

/**
 * Safeguards for the GitHub Actions slow path (scheduled workflows can lag, get dropped under load, and are
 * auto-disabled on public repos after 60 days without repository activity):
 *   1. DIGEST LAG: if a digest has not been logged 20 min after its target time, the Worker dispatches the workflow itself;
 *      if it is still missing 50 min after, it tells you.
 *   2. CALENDAR: if the database has no macro events for the next 48 h, the Worker dispatches the calendar refresh.
 *   3. DISABLED WORKFLOWS: every 6 h the Worker lists the workflows and re-enables any that GitHub disabled.
 */
export type GhAction =
  | { type: 'dispatch'; workflow: string; inputs?: Record<string, string>; key: string }
  | { type: 'alert'; key: string; headline: string; what: string }
  | { type: 'check-workflows'; key: string };

export const WORKFLOW_FILES = ['digest.yml', 'calendar.yml', 'heartbeat.yml', 'weekly-review.yml', 'keepalive.yml'];

export function planGithub(i: { now: number; kv: Record<string, any>; eventCount48h: number; cfg: AgentConfig }): GhAction[] {
  const { now, kv, cfg } = i;
  const actions: GhAction[] = [];
  const dispatched: Record<string, number> = kv.dispatch ?? {};
  const last = kv.digest_last ?? {};

  const kinds: Array<{ kind: 'india' | 'us'; tz: string; time: string; windowMin: number }> = [
    { kind: 'india', tz: 'Asia/Kolkata', time: cfg.digest.india.istTime, windowMin: cfg.digest.india.windowMin },
    { kind: 'us', tz: 'America/New_York', time: cfg.digest.us.etTime, windowMin: cfg.digest.us.windowMin },
  ];
  for (const k of kinds) {
    const date = localDate(now, k.tz);
    const start = zonedTimeToUtc(date, k.time, k.tz);
    const w = inLocalWindow(now, k.tz, k.time, k.windowMin, cfg.digest.weekdaysOnly);
    if (!w.open && w.reason !== 'after window') continue; // weekend / before window
    if (last[k.kind] === date) continue;
    if (now >= start + 20 * 60_000 && now <= start + 120 * 60_000) {
      const dk = `digest:${k.kind}:${date}`;
      if (w.open && !dispatched[dk]) actions.push({ type: 'dispatch', workflow: 'digest.yml', inputs: { kind: k.kind }, key: dk });
      if (now >= start + 50 * 60_000 && !dispatched[`${dk}:alert`]) {
        actions.push({ type: 'alert', key: `${dk}:alert`, headline: `${k.kind.toUpperCase()} digest missing`, what: `The ${k.kind} digest was due at ${k.time} (${k.tz}) and has not been delivered, even after the Worker asked GitHub to run it. Check the Actions tab.` });
      }
    }
  }

  if (i.eventCount48h === 0 && now - (dispatched.calendar ?? 0) > 6 * 3600_000) {
    actions.push({ type: 'dispatch', workflow: 'calendar.yml', key: 'calendar' });
  }
  if (now - (kv.gh_check?.workflowsAt ?? 0) > 6 * 3600_000) actions.push({ type: 'check-workflows', key: 'workflowsAt' });
  return actions;
}

const ghHeaders = (token: string) => ({
  authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-api-version': '2022-11-28', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json',
});

export async function runGithub(ctx: Ctx): Promise<void> {
  const { env } = ctx;
  if (ctx.minute % 10 !== 3) return; // every 10 minutes is plenty
  const actions = planGithub({ now: ctx.now, kv: ctx.kv, eventCount48h: ctx.state.eventCount48h, cfg: ctx.cfg });
  if (!actions.length) return;
  const dispatched: Record<string, number> = { ...(ctx.kv.dispatch ?? {}) };
  const ghCheck: Record<string, number> = { ...(ctx.kv.gh_check ?? {}) };
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  for (const a of actions) {
    if (a.type === 'alert') {
      dispatched[a.key] = ctx.now;
      systemAlert(ctx, a.key, a.headline, a.what, { bucketMin: 720 });
      continue;
    }
    if (!repo || !token) { ctx.notes.push('github: GITHUB_REPO/GITHUB_TOKEN not set, safeguards skipped'); break; }
    const base = `https://api.github.com/repos/${repo}`;
    try {
      if (a.type === 'dispatch') {
        let ref: string = ctx.kv.gh_ref ?? '';
        if (!ref) {
          const { text } = await request(base, { ...ctx.o, headers: ghHeaders(token) });
          ref = JSON.parse(text).default_branch ?? 'main';
          setKv(ctx, 'gh_ref', ref);
        }
        dispatched[a.key] = ctx.now;
        await request(`${base}/actions/workflows/${a.workflow}/dispatches`, {
          ...ctx.o, method: 'POST', headers: ghHeaders(token), body: JSON.stringify({ ref, inputs: a.inputs ?? {} }),
        });
        ctx.notes.push(`github: dispatched ${a.workflow} (${a.key})`);
      } else {
        ghCheck.workflowsAt = ctx.now;
        const { text } = await request(`${base}/actions/workflows`, { ...ctx.o, headers: ghHeaders(token) });
        const wfs: Array<{ id: number; path: string; state: string; name: string }> = JSON.parse(text).workflows ?? [];
        for (const w of wfs) {
          const file = w.path.split('/').pop() ?? '';
          if (!WORKFLOW_FILES.includes(file) || w.state === 'active') continue;
          await request(`${base}/actions/workflows/${w.id}/enable`, { ...ctx.o, method: 'PUT', headers: ghHeaders(token) });
          systemAlert(ctx, `gh-enable:${file}`, `GitHub workflow ${file} was ${w.state}`, `GitHub had disabled ${file} (state: ${w.state}, usually 60 days without repo activity). The Worker re-enabled it.`, { bucketMin: 720 });
        }
      }
    } catch (e) {
      ctx.errors.push(`github ${a.key}: ${errMsg(e)}`);
      if (a.type === 'dispatch') dispatched[a.key] = ctx.now - 15 * 60_000; // retry in ~15 min rather than every 10
    }
  }
  setKv(ctx, 'dispatch', dispatched);
  setKv(ctx, 'gh_check', ghCheck);
}
