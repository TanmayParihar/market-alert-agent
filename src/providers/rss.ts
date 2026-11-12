import { decodeEntities, stripTags } from '../util/text';

export interface RssItem {
  title: string;
  link: string;
  guid: string;
  /** epoch ms or null */
  published: number | null;
  summary: string;
  /** publisher name when the feed gives it (Google News <source>) */
  publisher: string | null;
}

const TAG_RE = new Map<string, RegExp>();
function tag(block: string, name: string): string {
  // compiled once per tag name: building RegExps per item was the top CPU cost on the 10 ms Workers Free budget
  if (block.indexOf(`<${name}`) < 0) return ''; // cheap negative check before any regex work
  let re = TAG_RE.get(name);
  if (!re) {
    re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    TAG_RE.set(name, re);
  }
  const m = re.exec(block);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cdata) v = cdata[1];
  return v;
}

/** Plain text from a feed field. Fast path: most titles/guids contain no markup or entities. */
function clean(s: string, max = 0): string {
  if (!s) return '';
  let t = max ? s.slice(0, max * 3) : s;
  if (t.indexOf('<') >= 0) t = stripTags(t).replace(/<[^>]*$/, '');
  if (t.indexOf('&') >= 0) t = decodeEntities(t);
  t = t.trim();
  return max ? t.slice(0, max) : t;
}

/**
 * Minimal, CPU-cheap RSS/Atom parser. Only the first `maxItems` items are touched (Workers Free = 10 ms CPU),
 * so a 150 KB feed costs the same as a 15 KB one. Output is plain text: tags and entities removed.
 */
export function parseFeed(xml: string, maxItems = 15): RssItem[] {
  const items: RssItem[] = [];
  const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const open = isAtom ? /<entry[\s>]/gi : /<item[\s>]/gi;
  const close = isAtom ? '</entry>' : '</item>';
  let m: RegExpExecArray | null;
  while (items.length < maxItems && (m = open.exec(xml))) {
    const start = m.index;
    const end = xml.indexOf(close, start);
    if (end < 0) break;
    const block = xml.slice(start, end);
    open.lastIndex = end;
    const title = clean(tag(block, 'title'));
    if (!title) continue;
    let link = tag(block, 'link');
    if (isAtom || !link) {
      const h = /<link[^>]*href="([^"]+)"/i.exec(block);
      if (h) link = h[1];
    }
    const guid = tag(block, 'guid') || tag(block, 'id') || link;
    const dateStr = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const t = dateStr ? Date.parse(dateStr) : NaN;
    const summary = clean(tag(block, 'description') || tag(block, 'summary'), 300);
    const publisher = clean(tag(block, 'source')) || null;
    items.push({ title, link: clean(link), guid: clean(guid), published: Number.isFinite(t) ? t : null, summary, publisher });
  }
  return items;
}
