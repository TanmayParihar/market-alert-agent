import { hash } from '../util/text';

const STOP = new Set(
  ('the a an of to in on at for and or but is are was were be been as by with from that this it its into over after before ' +
    'amid says said say new us u s will would could may might more than up down out about against off per via').split(' '),
);

/** Lowercase, strip " - Reuters" style source suffix, punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase();
  t = t.replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, ''); // trailing "- Source"
  t = t.replace(/[’']/g, '').replace(/[^a-z0-9%$.\s]/g, ' ').replace(/\.(?!\d)/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function tokens(norm: string): Set<string> {
  const out = new Set<string>();
  for (const raw of norm.split(' ')) {
    if (!raw || STOP.has(raw)) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length < 3 && !/\d/.test(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Same story? Jaccard over content tokens, or one headline is (almost) contained in the other. */
export function sameStory(aNorm: string, bNorm: string, threshold = 0.5): boolean {
  if (aNorm === bNorm) return true;
  const a = tokens(aNorm);
  const b = tokens(bNorm);
  if (jaccard(a, b) >= threshold) return true;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size >= 4) {
    let inter = 0;
    for (const x of small) if (big.has(x)) inter++;
    if (inter / small.size >= 0.85) return true;
  }
  return false;
}

export interface ClusterRef { id: string; cluster_id: string; title_norm: string; source: string }

/** Find an existing cluster for a normalised title among recent items. */
export function findCluster(norm: string, recent: ClusterRef[], threshold = 0.5): ClusterRef | null {
  for (const r of recent) if (sameStory(norm, r.title_norm, threshold)) return r;
  return null;
}

/** Stable id for an item: prefers guid/link, falls back to the title. */
export function itemId(feedId: string, guidOrLink: string | undefined, title: string): string {
  return hash(`${guidOrLink && guidOrLink.length > 8 ? guidOrLink : feedId + '|' + title}`);
}
