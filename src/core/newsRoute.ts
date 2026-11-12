import type { AgentConfig, FeedDef, Severity } from '../types';
import { rank } from './severity';

export interface NewsRouteIn {
  severity: Severity | 'NONE';
  trust: FeedDef['trust'];
  /** distinct publishers that carried this story so far (including this one) */
  distinctSources: number;
  /** minutes between publication and now (null if unknown) */
  ageMin: number | null;
  mediumThisHour: number;
}

export interface NewsRouteOut {
  status: 'pending' | 'digest_pending' | 'ignore';
  severity: Severity;
  reason: string | null;
  awaitingCorroboration: boolean;
}

/**
 * Routing rules for a scored headline:
 *  - NONE: ignored (kept in news_items only).
 *  - LOW: digest.
 *  - Stale (older than maxAgeMinutesForInstant): digest, never instant.
 *  - WORLD-ENDING from a single non-official source is capped to HIGH until a second publisher carries it
 *    (guards against fake headlines and prompt-injected scores). The second source triggers the escalation.
 *  - MEDIUM beyond the hourly burst cap is demoted to the digest (HIGH and above are never demoted).
 */
export function routeNews(i: NewsRouteIn, cfg: Pick<AgentConfig, 'news'>): NewsRouteOut {
  if (i.severity === 'NONE') return { status: 'ignore', severity: 'LOW', reason: null, awaitingCorroboration: false };
  let sev: Severity = i.severity;
  if (sev === 'LOW') return { status: 'digest_pending', severity: 'LOW', reason: 'LOW: collected for the next digest', awaitingCorroboration: false };
  if (i.ageMin !== null && i.ageMin > cfg.news.maxAgeMinutesForInstant) {
    return { status: 'digest_pending', severity: sev, reason: `stale: published ${Math.round(i.ageMin)} min ago`, awaitingCorroboration: false };
  }
  let awaiting = false;
  let reason: string | null = null;
  if (sev === 'WORLD_ENDING' && i.trust !== 'official' && i.distinctSources < 2) {
    sev = 'HIGH';
    awaiting = true;
    reason = 'WORLD-ENDING claim from a single source capped to HIGH until a second publisher corroborates';
  }
  if (sev === 'MEDIUM' && i.mediumThisHour >= cfg.news.maxMediumPerHour) {
    return { status: 'digest_pending', severity: sev, reason: 'burst cap: too many MEDIUM news alerts this hour', awaitingCorroboration: false };
  }
  return { status: 'pending', severity: sev, reason, awaitingCorroboration: awaiting };
}

export const higher = (a: Severity, b: Severity) => rank(a) > rank(b);
