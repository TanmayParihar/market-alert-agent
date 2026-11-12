import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { inLocalWindow, zonedTimeToUtc, isWeekday, localDate } from '../src/util/time';
import { buildHeadsUp, buildResult, computeBls, expectedRefMonth, matchRule, parseNumber, resultSeverity, surprise } from '../src/core/macro';
import { planGithub } from '../src/worker/github';
import type { MacroEventRow } from '../src/types';

const iso = (s: string) => Date.parse(s);

describe('timezones and DST', () => {
  it('converts wall-clock times to UTC correctly across US daylight saving', () => {
    expect(new Date(zonedTimeToUtc('2026-12-09', '14:00', 'America/New_York')).toISOString()).toBe('2026-12-09T19:00:00.000Z'); // EST
    expect(new Date(zonedTimeToUtc('2027-06-09', '14:00', 'America/New_York')).toISOString()).toBe('2027-06-09T18:00:00.000Z'); // EDT
    expect(new Date(zonedTimeToUtc('2026-12-04', '10:00', 'Asia/Kolkata')).toISOString()).toBe('2026-12-04T04:30:00.000Z');
  });

  it('US digest window follows New York time: only the matching UTC cron fires', () => {
    const us = config.digest.us;
    // Winter (EST = UTC-5): 13:35Z is 08:35 ET => open; 12:35Z is 07:35 ET => before window
    expect(inLocalWindow(iso('2026-12-08T13:35:00Z'), 'America/New_York', us.etTime, us.windowMin, true).open).toBe(true);
    expect(inLocalWindow(iso('2026-12-08T12:35:00Z'), 'America/New_York', us.etTime, us.windowMin, true)).toMatchObject({ open: false, reason: 'before window' });
    // Summer (EDT = UTC-4): 12:35Z is 08:35 ET => open; 13:35Z is 09:35 ET => after window
    expect(inLocalWindow(iso('2027-06-08T12:35:00Z'), 'America/New_York', us.etTime, us.windowMin, true).open).toBe(true);
    expect(inLocalWindow(iso('2027-06-08T13:35:00Z'), 'America/New_York', us.etTime, us.windowMin, true)).toMatchObject({ open: false, reason: 'after window' });
  });

  it('DST switch weeks: the first day after the US clocks change still picks the right cron', () => {
    // US fell back on 2026-11-01: Mon 2026-11-02 08:35 ET = 13:35Z
    expect(inLocalWindow(iso('2026-11-02T13:35:00Z'), 'America/New_York', '08:30', 55, true).open).toBe(true);
    expect(inLocalWindow(iso('2026-11-02T12:35:00Z'), 'America/New_York', '08:30', 55, true).open).toBe(false);
  });

  it('India digest: 03:00 UTC = 08:30 IST on weekdays only', () => {
    const i = config.digest.india;
    expect(inLocalWindow(iso('2026-11-13T03:00:00Z'), 'Asia/Kolkata', i.istTime, i.windowMin, true).open).toBe(true);
    expect(inLocalWindow(iso('2026-11-14T03:00:00Z'), 'Asia/Kolkata', i.istTime, i.windowMin, true)).toMatchObject({ open: false, reason: 'weekend' });
    expect(isWeekday(iso('2026-11-13T03:00:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(localDate(iso('2026-11-13T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-14'); // IST is already tomorrow
  });
});

describe('macro numbers and surprise', () => {
  it('parses forecast strings', () => {
    expect(parseNumber('0.3%')).toBe(0.3);
    expect(parseNumber('150K')).toBe(150);
    expect(parseNumber('1.2M')).toBe(1200);
    expect(parseNumber('-12.3B')).toBe(-12300000);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
  it('computes surprise in sigma units', () => {
    expect(surprise('0.5%', '0.3%', 0.1)).toMatchObject({ z: 2, direction: 'higher' });
    expect(surprise('0.3%', '0.3%', 0.1)).toMatchObject({ direction: 'inline' });
    expect(surprise('0.1%', '0.3%', 0.1).direction).toBe('lower');
    expect(surprise('x', '0.3%', 0.1).direction).toBe('unknown');
  });
  it('maps surprise to severity (macro alone never exceeds HIGH)', () => {
    expect(resultSeverity(surprise('0.3', '0.3', 0.1), false)).toBe('MEDIUM');
    expect(resultSeverity(surprise('0.4', '0.3', 0.1), false)).toBe('MEDIUM');
    expect(resultSeverity(surprise('0.5', '0.3', 0.1), false)).toBe('HIGH');
    expect(resultSeverity(surprise('3.50', '3.75', 0.25), true)).toBe('HIGH'); // rate decision differs from consensus
    expect(resultSeverity(surprise('3.75', '3.75', 0.25), true)).toBe('MEDIUM');
    expect(resultSeverity(surprise('9', '0.3', 0.1), false)).toBe('HIGH');
  });
  it('matches calendar titles to rules by country', () => {
    expect(matchRule(config, 'CPI m/m', 'USD')?.label).toBe('US CPI (m/m)');
    expect(matchRule(config, 'Core CPI m/m', 'USD')?.label).toBe('US Core CPI (m/m)');
    expect(matchRule(config, 'CPI m/m', 'EUR')).toBeNull();
    expect(matchRule(config, 'Federal Funds Rate', 'USD')?.label).toBe('Fed rate decision');
    expect(matchRule(config, 'Unemployment Claims', 'USD')).toBeNull();
  });
});

describe('BLS actuals', () => {
  const pts = (rows: Array<[string, string, string]>) => rows.map(([year, period, value]) => ({ year, period, value }));
  it('derives CPI m/m from index levels and requires the expected reference month', () => {
    const data = pts([['2026', 'M10', '337.476'], ['2026', 'M09', '336.298'], ['2025', 'M10', '326.0']]);
    expect(computeBls(data, 'mom', { year: 2026, month: 10 })).toEqual({ value: 0.4, text: '0.4%' });
    expect(computeBls(data, 'yoy', { year: 2026, month: 10 })?.text).toBe('3.5%');
    expect(computeBls(data, 'mom', { year: 2026, month: 11 })).toBeNull(); // not published yet
  });
  it('payroll change in thousands and unemployment level', () => {
    expect(computeBls(pts([['2026', 'M10', '160250'], ['2026', 'M09', '160100']]), 'change', { year: 2026, month: 10 })).toEqual({ value: 150, text: '150K' });
    expect(computeBls(pts([['2026', 'M10', '4.4']]), 'level', { year: 2026, month: 10 })?.text).toBe('4.4%');
  });
  it('reference month is the month before the release month (handles January)', () => {
    expect(expectedRefMonth(iso('2026-11-10T13:30:00Z'))).toEqual({ year: 2026, month: 10 });
    expect(expectedRefMonth(iso('2027-01-13T13:30:00Z'))).toEqual({ year: 2026, month: 12 });
  });
});

describe('macro alert messages', () => {
  const ev: MacroEventRow = { id: 'e1', source: 'faireconomy', title: 'CPI m/m', country: 'USD', impact: 'High', event_time: '2026-12-10T13:30:00.000Z', forecast: '0.3%', previous: '0.6%', actual: null, status: 'scheduled', watch: true, approx: false, resolver: null, attempts: 0, meta: {} };
  const rule = matchRule(config, 'CPI m/m', 'USD');
  it('heads-up says what is due, when (IST), forecast and previous', () => {
    const c = buildHeadsUp(ev, rule, null, iso('2026-12-10T13:00:00Z'));
    expect(c.headline).toBe('US CPI (m/m) due in 30 min');
    expect(c.what).toContain('19:00 IST'); expect(c.what).toContain('forecast 0.3%'); expect(c.what).toContain('previous 0.6%');
    expect(c.severity).toBe('MEDIUM');
  });
  it('result compares actual vs expected and adds the directional hint', () => {
    const c = buildResult(ev, rule, '0.5%', null, iso('2026-12-10T13:31:00Z'));
    expect(c.headline).toContain('0.5%'); expect(c.headline).toContain('above forecast');
    expect(c.severity).toBe('HIGH');
    expect(c.what).toContain('forecast 0.3%');
    expect(c.impact).toMatch(/hot inflation/);
  });
});

describe('GitHub slow-path safeguards', () => {
  const plan = (nowIso: string, kv: any = {}, eventCount48h = 5) => planGithub({ now: iso(nowIso), kv, eventCount48h, cfg: config });
  it('re-dispatches a late India digest 20+ min after its time, once', () => {
    const a = plan('2026-11-13T03:25:00Z', { gh_check: { workflowsAt: iso('2026-11-13T03:00:00Z') } });
    expect(a).toEqual([{ type: 'dispatch', workflow: 'digest.yml', inputs: { kind: 'india' }, key: 'digest:india:2026-11-13' }]);
    expect(plan('2026-11-13T03:25:00Z', { gh_check: { workflowsAt: iso('2026-11-13T03:00:00Z') }, dispatch: { 'digest:india:2026-11-13': 1 } })).toEqual([]);
  });
  it('does nothing when the digest was delivered, early, on weekends', () => {
    const fresh = { gh_check: { workflowsAt: iso('2026-11-13T03:00:00Z') } };
    expect(plan('2026-11-13T03:25:00Z', { ...fresh, digest_last: { india: '2026-11-13' } })).toEqual([]);
    expect(plan('2026-11-13T03:10:00Z', fresh)).toEqual([]);
    expect(plan('2026-11-14T03:25:00Z', { gh_check: { workflowsAt: iso('2026-11-14T03:00:00Z') } })).toEqual([]);
  });
  it('tells you if the digest is STILL missing 50 min after its time', () => {
    const a = plan('2026-11-13T03:25:00Z', { gh_check: { workflowsAt: iso('2026-11-13T03:00:00Z') }, dispatch: { 'digest:india:2026-11-13': 1 } });
    expect(a).toEqual([]);
    const b = plan('2026-11-13T03:55:00Z', { gh_check: { workflowsAt: iso('2026-11-13T03:00:00Z') }, dispatch: { 'digest:india:2026-11-13': 1 } });
    expect(b.some((x) => x.type === 'alert')).toBe(true);
  });
  it('refreshes the calendar when no events are stored, and checks for disabled workflows every 6 h', () => {
    expect(plan('2026-11-13T10:00:00Z', {}, 0).map((x) => x.type)).toEqual(['dispatch', 'check-workflows']);
    expect(plan('2026-11-13T10:00:00Z', { gh_check: { workflowsAt: iso('2026-11-13T09:00:00Z') }, dispatch: { calendar: iso('2026-11-13T08:00:00Z') } }, 0)).toEqual([]);
  });
});
