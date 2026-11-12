// Small text/hash helpers (no Node APIs: must run in Workers).

/** FNV-1a 64-bit-ish (two 32-bit lanes) -> 16 hex chars. Fast, sync, no crypto needed for dedupe ids. */
export function hash(str: string): string {
  let h1 = 0x811c9dc5 ^ str.length;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function uuid(): string {
  return (globalThis as any).crypto.randomUUID();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** First `n` words, with an ellipsis if cut. */
export function truncateWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ').replace(/[,;:\-–—]+$/, '') + '…';
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Sanitise any text that came from an untrusted source (headline or LLM output) before it is placed in a message:
 * strip control chars/markup/URLs, collapse whitespace, cap length.
 */
const NEEDS_CLEANING = /[<&]|https?:|[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

export function sanitize(s: unknown, max = 200): string {
  if (typeof s !== 'string') return '';
  if (!NEEDS_CLEANING.test(s)) return truncate(s.replace(/\s+/g, ' ').trim(), max); // fast path (CPU budget)
  let t = decodeEntities(stripTags(s));
  t = t.replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return truncate(t, max);
}
