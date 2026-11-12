import type { Severity } from '../types';
import { EMOJI, LABEL, rank } from './severity';
import { formatIST } from '../util/time';
import { truncate, truncateWords } from '../util/text';

export interface Msgable {
  severity: Severity;
  headline: string;
  what: string | null;
  impact: string | null;
  source: string | null;
  sourceTime: number | null; // epoch ms
  marker?: string;
}

/**
 * Phone-lock-screen layout:
 *   🔴 HIGH: <headline, max 12 words>
 *   What: <what happened + key number>
 *   Impact (info only, not advice): <assets likely affected>
 *   Src: <source> · <time IST>
 */
export function formatAlert(a: Msgable, nowMs: number = Date.now(), compact = false): string {
  const head = a.marker ? `${a.marker}: ` : `${EMOJI[a.severity]} ${LABEL[a.severity]}: `;
  const lines = [head + truncateWords(a.headline, 12)];
  if (a.what) lines.push(`What: ${compact ? truncate(a.what, 160) : a.what}`);
  if (a.impact && !compact) lines.push(`Impact (info only, not advice): ${a.impact}`);
  const src = [a.source, a.sourceTime ? formatIST(a.sourceTime, nowMs) : formatIST(nowMs, nowMs)].filter(Boolean).join(' · ');
  lines.push(`Src: ${src}`);
  return lines.join('\n');
}

/**
 * Merge every alert that fires in the same run into as few messages as possible (highest severity first).
 * Never drops an alert: whatever does not fit `maxChars` moves to the next message.
 * `overflowed` lists indices of alerts that did not fit into `maxMessages` (they stay queued for the next minute).
 */
export function mergeAlerts(
  items: Msgable[],
  maxChars: number,
  maxMessages: number,
  nowMs: number = Date.now(),
): { messages: string[]; included: number[]; overflowed: number[] } {
  const budget = maxChars - 40; // room for the merge header
  const order = items.map((_, i) => i).sort((a, b) => rank(items[b].severity) - rank(items[a].severity) || a - b);
  const texts = new Map<number, string>();
  for (const i of order) {
    let t = formatAlert(items[i], nowMs);
    if (t.length > budget) t = formatAlert(items[i], nowMs, true);
    if (t.length > budget) t = truncate(t, budget);
    texts.set(i, t);
  }
  const groups: number[][] = [];
  let len = 0;
  for (const i of order) {
    const l = texts.get(i)!.length + 2;
    if (groups.length && len + l <= budget) {
      groups[groups.length - 1].push(i);
      len += l;
    } else {
      groups.push([i]);
      len = l;
    }
  }
  const used = groups.slice(0, maxMessages);
  const messages = used.map(
    (g) => (g.length > 1 ? `📬 ${g.length} alerts · ${formatIST(nowMs, nowMs)}\n\n` : '') + g.map((i) => texts.get(i)!).join('\n\n'),
  );
  return { messages, included: used.flat(), overflowed: groups.slice(maxMessages).flat() };
}

/** Split a long plain text (digest) on line boundaries into chunks <= max chars. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const l = line.length > max ? truncate(line, max) : line;
    if (cur.length + l.length + 1 > max && cur) {
      out.push(cur.trimEnd());
      cur = '';
    }
    cur += l + '\n';
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}
