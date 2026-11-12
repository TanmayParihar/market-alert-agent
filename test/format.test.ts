import { describe, expect, it } from 'vitest';
import { formatAlert, mergeAlerts, splitText, type Msgable } from '../src/core/format';
import { truncateWords, sanitize } from '../src/util/text';
import { formatIST } from '../src/util/time';
import { SEVERITIES } from '../src/core/severity';

const NOW = Date.parse('2026-11-13T09:02:00Z'); // 14:32 IST
const alert = (severity: Msgable['severity'], headline = 'Test headline', extra: Partial<Msgable> = {}): Msgable => ({
  severity, headline, what: 'Something happened: key number 3.2%.', impact: 'GOLD ↑ (likely direction)', source: 'Reuters', sourceTime: NOW, ...extra,
});

describe('message format', () => {
  it('has the four required parts and shows IST time', () => {
    const t = formatAlert(alert('HIGH', 'Fed cuts rates 50bp in surprise move'), NOW);
    const lines = t.split('\n');
    expect(lines[0]).toBe('🔴 HIGH: Fed cuts rates 50bp in surprise move');
    expect(lines[1]).toMatch(/^What: /);
    expect(lines[2]).toMatch(/^Impact \(info only, not advice\): /);
    expect(lines[3]).toBe('Src: Reuters · 14:32 IST');
  });

  it('headline is at most 12 words', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    expect(truncateWords(long, 12).replace('…', '').trim().split(/\s+/)).toHaveLength(12);
    expect(formatAlert(alert('MEDIUM', long), NOW).split('\n')[0].split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it('each severity has its own marker; system alerts use their own', () => {
    const marks = SEVERITIES.map((s) => formatAlert(alert(s), NOW).split(' ')[0]);
    expect(new Set(marks).size).toBe(4);
    expect(formatAlert(alert('MEDIUM', 'x', { marker: '⚙️ SYSTEM' }), NOW).startsWith('⚙️ SYSTEM: x')).toBe(true);
  });

  it('shows the date when the source time is not today (IST)', () => {
    expect(formatIST(Date.parse('2026-11-12T09:02:00Z'), NOW)).toBe('12 Nov 14:32 IST');
    expect(formatIST(NOW, NOW)).toBe('14:32 IST');
  });

  it('sanitises untrusted text (urls, markup, control chars)', () => {
    expect(sanitize('Hello <b>world</b> http://evil.example/x \u0007 &amp; more')).toBe('Hello world & more');
  });
});

describe('merging alerts that fire in the same minute', () => {
  it('puts everything into one message when it fits, highest severity first', () => {
    const m = mergeAlerts([alert('MEDIUM', 'medium one'), alert('WORLD_ENDING', 'world one'), alert('HIGH', 'high one')], 2000, 3, NOW);
    expect(m.messages).toHaveLength(1);
    expect(m.messages[0].startsWith('📬 3 alerts')).toBe(true);
    const text = m.messages[0];
    expect(text.indexOf('world one')).toBeLessThan(text.indexOf('high one'));
    expect(text.indexOf('high one')).toBeLessThan(text.indexOf('medium one'));
  });

  it('never drops an alert: overflow is reported, not lost', () => {
    const items = Array.from({ length: 12 }, (_, i) => alert('MEDIUM', `headline ${i}`));
    const m = mergeAlerts(items, 400, 2, NOW);
    expect(m.messages.length).toBeLessThanOrEqual(2);
    expect(m.messages.every((x) => x.length <= 400)).toBe(true);
    expect([...m.included, ...m.overflowed].sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
    expect(m.overflowed.length).toBeGreaterThan(0);
  });

  it('a single oversize alert is compacted to fit', () => {
    const big = alert('HIGH', 'big', { what: 'x'.repeat(1500) });
    const m = mergeAlerts([big], 600, 1, NOW);
    expect(m.messages[0].length).toBeLessThanOrEqual(600);
    expect(m.overflowed).toEqual([]);
  });

  it('splits long digests on line boundaries', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line number ${i} with some padding text`).join('\n');
    const parts = splitText(text, 300);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });
});
