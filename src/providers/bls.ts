import type { BlsPoint } from '../core/macro';
import { request, type ReqOpts } from '../util/http';

/**
 * BLS Public Data API v1: keyless, 25 queries/day, up to 25 series per query. One query covers every BLS event due.
 * The Worker polls it only for the first ~30 minutes after a scheduled release (<= 9 queries per release day).
 */
export async function fetchBlsSeries(seriesIds: string[], years: [number, number], o: ReqOpts): Promise<Record<string, BlsPoint[]>> {
  const { text } = await request('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
    ...o,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ seriesid: seriesIds, startyear: String(years[0]), endyear: String(years[1]) }),
  });
  const j = JSON.parse(text);
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS: ${j.status} ${(j.message ?? []).join(' ').slice(0, 120)}`);
  const out: Record<string, BlsPoint[]> = {};
  for (const s of j.Results?.series ?? []) out[s.seriesID] = (s.data ?? []).map((d: any) => ({ year: d.year, period: d.period, value: d.value }));
  return out;
}
