import { describe, expect, it } from 'vitest';
import { config } from '../agent.config';
import { findCluster, itemId, jaccard, normalizeTitle, sameStory, tokens } from '../src/core/dedupe';
import { looksRelevant, scoreByKeywords } from '../src/core/keywords';
import { routeNews } from '../src/core/newsRoute';
import { parseFeed } from '../src/providers/rss';

describe('deduplication of the same story across sources', () => {
  it('normalises source suffixes and punctuation', () => {
    expect(normalizeTitle('Oil jumps 5% as Iran closes Hormuz - Reuters')).toBe('oil jumps 5% as iran closes hormuz');
    expect(normalizeTitle('Oil jumps 5% as Iran closes Hormuz | BBC News')).toBe('oil jumps 5% as iran closes hormuz');
  });

  it('matches the same headline from different outlets', () => {
    const a = normalizeTitle('Iran closes Strait of Hormuz, oil jumps 5% - Reuters');
    const b = normalizeTitle('Oil jumps 5% as Iran closes Strait of Hormuz - BBC');
    expect(sameStory(a, b, config.news.similarity)).toBe(true);
  });

  it('does not merge different stories that share a few words', () => {
    const a = normalizeTitle('Fed holds rates steady');
    const b = normalizeTitle('Bank of England holds rates steady');
    expect(sameStory(a, b, config.news.similarity)).toBe(false);
    expect(sameStory(normalizeTitle('Bitcoin falls 5% as ETF outflows rise'), normalizeTitle('Gold hits record as dollar slides'), 0.6)).toBe(false);
  });

  it('a short wire headline contained in a longer one is a duplicate', () => {
    expect(sameStory(normalizeTitle('Russia declares war on Poland'), normalizeTitle('Breaking: Russia declares war on Poland, says Kremlin statement'), 0.6)).toBe(true);
  });

  it('finds the existing cluster among recent items', () => {
    const recent = [
      { id: 'a', cluster_id: 'c1', title_norm: normalizeTitle('Fed cuts rates by 50bp in emergency move'), source: 'Reuters' },
      { id: 'b', cluster_id: 'c2', title_norm: normalizeTitle('Gold hits record high'), source: 'CNBC' },
    ];
    expect(findCluster(normalizeTitle('Fed cuts rates by 50bp in emergency move - Bloomberg'), recent, 0.6)?.cluster_id).toBe('c1');
    expect(findCluster(normalizeTitle('Tesla recalls cars'), recent, 0.6)).toBeNull();
  });

  it('item ids are stable and feed-scoped when there is no guid', () => {
    expect(itemId('f', 'https://x.com/a-long-guid', 't')).toBe(itemId('f', 'https://x.com/a-long-guid', 'other'));
    expect(itemId('f1', undefined, 'same title')).not.toBe(itemId('f2', undefined, 'same title'));
    expect(jaccard(tokens('a b c'), tokens('a b c'))).toBeLessThanOrEqual(1);
  });
});

describe('keyword fallback scorer', () => {
  it('flags unambiguous catastrophic headlines as WORLD-ENDING', () => {
    expect(scoreByKeywords('Russia declares war on NATO member Poland').severity).toBe('WORLD_ENDING');
    expect(scoreByKeywords('Binance halts all withdrawals as insolvency fears mount').severity).toBe('WORLD_ENDING');
  });
  it('downgrades negated / speculative headlines', () => {
    expect(scoreByKeywords('China denies it declares war on Taiwan').severity).toBe('HIGH');
    expect(scoreByKeywords('Fed could announce emergency rate cut, analysts say').severity).toBe('MEDIUM');
  });
  it('classifies typical policy and crypto news', () => {
    expect(scoreByKeywords('Fed announces emergency rate cut').severity).toBe('HIGH');
    expect(scoreByKeywords('US imposes new tariffs on Chinese steel').severity).toBe('MEDIUM');
    expect(scoreByKeywords('SEC sues crypto exchange over unregistered securities').severity).toBe('MEDIUM');
    expect(scoreByKeywords('RBI cuts repo rate by 25 bps').severity).toBe('MEDIUM');
  });
  it('ignores ordinary headlines', () => {
    expect(scoreByKeywords('Gold prices edge higher in quiet trade').severity).toBe('NONE');
    expect(scoreByKeywords('Company X reports quarterly earnings').is_market_moving).toBe(false);
  });
  it('relevance pre-filter drops lifestyle/sports noise but keeps market news', () => {
    expect(looksRelevant('Celebrity wedding photos released')).toBe(false);
    expect(looksRelevant('Premier League table after Sunday fixtures')).toBe(false);
    expect(looksRelevant('Oil prices surge on supply fears')).toBe(true);
  });
});

describe('news routing rules', () => {
  const r = (o: Partial<Parameters<typeof routeNews>[0]>) =>
    routeNews({ severity: 'MEDIUM', trust: 'media', distinctSources: 1, ageMin: 5, mediumThisHour: 0, ...o }, config);

  it('NONE is ignored, LOW goes to the digest, MEDIUM+ is instant', () => {
    expect(r({ severity: 'NONE' }).status).toBe('ignore');
    expect(r({ severity: 'LOW' }).status).toBe('digest_pending');
    expect(r({ severity: 'MEDIUM' }).status).toBe('pending');
    expect(r({ severity: 'HIGH' }).status).toBe('pending');
  });
  it('stale stories never alert instantly', () => {
    expect(r({ severity: 'HIGH', ageMin: 300 })).toMatchObject({ status: 'digest_pending' });
  });
  it('single-source WORLD-ENDING is capped to HIGH until corroborated', () => {
    expect(r({ severity: 'WORLD_ENDING' })).toMatchObject({ status: 'pending', severity: 'HIGH', awaitingCorroboration: true });
    expect(r({ severity: 'WORLD_ENDING', distinctSources: 2 })).toMatchObject({ severity: 'WORLD_ENDING', awaitingCorroboration: false });
    expect(r({ severity: 'WORLD_ENDING', trust: 'official' })).toMatchObject({ severity: 'WORLD_ENDING' });
  });
  it('MEDIUM burst cap demotes to digest but never HIGH', () => {
    expect(r({ severity: 'MEDIUM', mediumThisHour: config.news.maxMediumPerHour }).status).toBe('digest_pending');
    expect(r({ severity: 'HIGH', mediumThisHour: 99 }).status).toBe('pending');
  });
});

describe('RSS parsing', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Fed &amp; markets: rate cut?]]></title><link>https://a.example/1</link><guid isPermaLink="false">g1</guid><pubDate>Fri, 13 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>
    <item><title>Oil jumps - Reuters</title><link>https://a.example/2</link><source url="https://reuters.com">Reuters</source></item>
    <item><title>Third</title></item></channel></rss>`;
  it('extracts title/link/guid/date/summary and strips markup', () => {
    const items = parseFeed(xml);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: 'Fed & markets: rate cut?', guid: 'g1', summary: 'Hello world' });
    expect(items[0].published).toBe(Date.parse('2026-11-13T09:00:00Z'));
    expect(items[1].publisher).toBe('Reuters');
  });
  it('only touches the first N items (CPU cap)', () => expect(parseFeed(xml, 2)).toHaveLength(2));
  it('parses Atom entries and tolerates garbage', () => {
    const atom = '<feed><entry><title>Atom one</title><link href="https://x/1"/><id>id1</id><updated>2026-11-13T09:00:00Z</updated></entry></feed>';
    expect(parseFeed(atom)[0]).toMatchObject({ title: 'Atom one', link: 'https://x/1', guid: 'id1' });
    expect(parseFeed('<html>not a feed</html>')).toEqual([]);
  });
});
