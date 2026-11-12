// Time helpers. All user-facing times are IST (Asia/Kolkata).

export const IST = 'Asia/Kolkata';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** "14:32 IST" (same IST day as `nowMs`) or "13 Nov 14:32 IST". */
export function formatIST(ms: number, nowMs: number = Date.now()): string {
  const time = dtf(IST, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
  if (istDate(ms) === istDate(nowMs)) return `${time} IST`;
  const day = dtf(IST, { day: '2-digit', month: 'short' }).format(ms);
  return `${day} ${time} IST`;
}

/** "2026-11-13" in IST. */
export function istDate(ms: number): string {
  return localDate(ms, IST);
}

export function localDate(ms: number, tz: string): string {
  const p = partsOf(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export interface Parts { year: string; month: string; day: string; hour: string; minute: string; weekday: string }

export function partsOf(ms: number, tz: string): Parts {
  const parts = dtf(tz, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), weekday: get('weekday') };
}

/** minutes since local midnight in tz */
export function localMinutes(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

export function isWeekday(ms: number, tz: string): boolean {
  const w = partsOf(ms, tz).weekday;
  return w !== 'Sat' && w !== 'Sun';
}

/** Offset (ms) of tz from UTC at the given instant. */
function tzOffsetMs(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return asUtc - Math.floor(ms / 60000) * 60000;
}

/** Convert a local wall-clock time ("2026-12-09", "14:00") in `tz` to epoch ms (DST-correct). */
export function zonedTimeToUtc(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  // second pass handles the case where the offset differs at the corrected instant (DST edge)
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

export interface DigestWindow { open: boolean; reason: string; localDate: string }

/**
 * Is `nowMs` inside [target, target+windowMin] local time in `tz` on a (week)day?
 * Used so a GitHub cron that fires at both the EDT and EST UTC times only sends once, at the right one.
 */
export function inLocalWindow(nowMs: number, tz: string, hhmm: string, windowMin: number, weekdaysOnly: boolean): DigestWindow {
  const date = localDate(nowMs, tz);
  if (weekdaysOnly && !isWeekday(nowMs, tz)) return { open: false, reason: 'weekend', localDate: date };
  const [h, m] = hhmm.split(':').map(Number);
  const start = h * 60 + m;
  const cur = localMinutes(nowMs, tz);
  if (cur < start) return { open: false, reason: 'before window', localDate: date };
  if (cur > start + windowMin) return { open: false, reason: 'after window', localDate: date };
  return { open: true, reason: 'in window', localDate: date };
}
