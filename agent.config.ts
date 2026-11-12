/**
 * THE ONE FILE YOU EDIT.
 * Watchlist, thresholds, feeds, routing, digest times and health limits all live here.
 * Nothing in src/ needs to change for normal tuning. No secrets in this file (repo may be public).
 *
 * How price thresholds work (see README "Severity rubric"):
 *   sigma_window = dailyVolPct * sqrt(window_minutes / tradingMinutes)      (m15, h1)
 *   sigma_window = dailyVolPct                                              (session = since previous close)
 *   alert level  = |move| >= k[level] * sigma_window  (and >= the asset's floorPct)
 * So a volatile asset (BTC) needs a bigger move than a calm one (USD/INR) for the same severity.
 * Run `npm run thresholds` to print the resulting % table for every asset.
 */
import type { AgentConfig } from './src/types';

export const config: AgentConfig = {
  timezone: 'Asia/Kolkata',

  // ---------------------------------------------------------------------------------------------
  // WATCHLIST
  // ---------------------------------------------------------------------------------------------
  assets: [
    // ----- Indices -----
    {
      id: 'SPX', name: 'S&P 500', cls: 'index', region: 'US', yahoo: '^GSPC', cnbc: '.SPX',
      dailyVolPct: 1.0, tradingMinutes: 390, maxStaleMin: 25,
      circuit: [
        { pct: 7, severity: 'WORLD_ENDING', label: 'US market-wide circuit breaker level 1 (-7%)', direction: 'down' },
        { pct: 13, severity: 'WORLD_ENDING', label: 'US market-wide circuit breaker level 2 (-13%)', direction: 'down' },
      ],
      hintDown: 'risk-off: Nasdaq/Dow/Nifty/BTC lower, Gold/VIX/USD higher',
      hintUp: 'risk-on: Nasdaq/Dow/Nifty/BTC higher, VIX lower',
    },
    {
      id: 'NDX', name: 'Nasdaq', cls: 'index', region: 'US', yahoo: '^IXIC', cnbc: '.IXIC',
      dailyVolPct: 1.3, tradingMinutes: 390, maxStaleMin: 25,
      hintDown: 'tech-led risk-off: S&P/BTC lower, VIX higher',
      hintUp: 'tech-led risk-on: S&P/BTC higher',
    },
    {
      id: 'DJI', name: 'Dow', cls: 'index', region: 'US', yahoo: '^DJI', cnbc: '.DJI',
      dailyVolPct: 0.9, tradingMinutes: 390, maxStaleMin: 25,
      hintDown: 'broad US risk-off: S&P/Nasdaq lower, Gold/USD higher',
      hintUp: 'broad US risk-on: S&P/Nasdaq higher',
    },
    {
      id: 'NIFTY', name: 'Nifty 50', cls: 'index', region: 'IN', yahoo: '^NSEI', cnbc: '.NSEI', nse: 'NIFTY 50',
      dailyVolPct: 0.9, tradingMinutes: 375, maxStaleMin: 30,
      circuit: [
        { pct: 10, severity: 'WORLD_ENDING', label: 'NSE index circuit breaker level 1 (10%)', direction: 'both' },
      ],
      hintDown: 'Sensex/Bank Nifty lower, India VIX higher, USD/INR higher',
      hintUp: 'Sensex/Bank Nifty higher, India VIX lower, rupee firmer',
    },
    {
      id: 'SENSEX', name: 'Sensex', cls: 'index', region: 'IN', yahoo: '^BSESN',
      dailyVolPct: 0.9, tradingMinutes: 375, maxStaleMin: 30,
      circuit: [{ pct: 10, severity: 'WORLD_ENDING', label: 'BSE index circuit breaker level 1 (10%)', direction: 'both' }],
      hintDown: 'Nifty/Bank Nifty lower, India VIX higher',
      hintUp: 'Nifty/Bank Nifty higher, India VIX lower',
    },
    {
      id: 'BANKNIFTY', name: 'Bank Nifty', cls: 'index', region: 'IN', yahoo: '^NSEBANK', cnbc: '.NSEBANK', nse: 'NIFTY BANK',
      dailyVolPct: 1.2, tradingMinutes: 375, maxStaleMin: 30,
      hintDown: 'Nifty lower, PSU/private bank stocks weak, India VIX higher',
      hintUp: 'Nifty higher, bank stocks firm, India VIX lower',
    },

    // ----- Volatility -----
    {
      id: 'VIX', name: 'VIX', cls: 'vol', region: 'US', yahoo: '^VIX', cnbc: '.VIX',
      dailyVolPct: 6.0, tradingMinutes: 390, maxStaleMin: 25,
      floorPct: { m15: 4, h1: 6, session: 10 },
      levels: [
        { gte: 25, severity: 'MEDIUM', label: 'VIX above 25' },
        { gte: 35, severity: 'HIGH', label: 'VIX above 35' },
        { gte: 50, severity: 'WORLD_ENDING', label: 'VIX above 50 (2008/2020-type panic)' },
      ],
      hintDown: 'volatility falling: US equities usually firmer',
      hintUp: 'volatility spike: S&P/Nasdaq/BTC usually lower, Gold/USD higher',
    },
    {
      id: 'INDIAVIX', name: 'India VIX', cls: 'vol', region: 'IN', yahoo: '^INDIAVIX', nse: 'INDIA VIX',
      dailyVolPct: 4.0, tradingMinutes: 375, maxStaleMin: 30,
      floorPct: { m15: 3, h1: 5, session: 8 },
      levels: [
        { gte: 20, severity: 'MEDIUM', label: 'India VIX above 20' },
        { gte: 28, severity: 'HIGH', label: 'India VIX above 28' },
        { gte: 40, severity: 'WORLD_ENDING', label: 'India VIX above 40' },
      ],
      hintDown: 'India volatility easing: Nifty/Bank Nifty usually firmer',
      hintUp: 'India volatility spike: Nifty/Sensex/Bank Nifty usually lower',
    },

    // ----- Commodities -----
    {
      id: 'GOLD', name: 'Gold', cls: 'commodity', region: 'GLOBAL', yahoo: 'GC=F', cnbc: '@GC.1',
      dailyVolPct: 1.1, tradingMinutes: 1380, maxStaleMin: 30,
      hintDown: 'Silver lower, USD/DXY and real yields firmer, risk-on',
      hintUp: 'Silver higher, USD softer or safe-haven bid',
    },
    {
      id: 'SILVER', name: 'Silver', cls: 'commodity', region: 'GLOBAL', yahoo: 'SI=F', cnbc: '@SI.1',
      dailyVolPct: 2.0, tradingMinutes: 1380, maxStaleMin: 30,
      hintDown: 'Gold lower, industrial-demand worry or firmer USD',
      hintUp: 'Gold higher, safe-haven or industrial demand',
    },
    {
      id: 'CRUDE', name: 'Crude oil (WTI)', cls: 'commodity', region: 'GLOBAL', yahoo: 'CL=F', cnbc: '@CL.1',
      dailyVolPct: 2.2, tradingMinutes: 1380, maxStaleMin: 30,
      hintDown: 'lower inflation pressure: India equities/rupee supported, energy stocks weak',
      hintUp: 'inflation pressure: rupee and India equities pressured, energy stocks firm',
    },
    {
      id: 'NATGAS', name: 'Natural gas', cls: 'commodity', region: 'GLOBAL', yahoo: 'NG=F', cnbc: '@NG.1',
      dailyVolPct: 3.5, tradingMinutes: 1380, maxStaleMin: 30,
      hintDown: 'energy-cost relief, gas producers weak',
      hintUp: 'energy-cost pressure, gas producers firm',
    },

    // ----- FX -----
    {
      id: 'USDINR', name: 'USD/INR', cls: 'fx', region: 'IN', yahoo: 'INR=X', cnbc: 'INR=',
      dailyVolPct: 0.25, tradingMinutes: 1440, maxStaleMin: 30,
      floorPct: { m15: 0.12, h1: 0.2, session: 0.4 },
      hintDown: 'rupee stronger: supportive for Nifty/importers, pressure on exporters (IT)',
      hintUp: 'rupee weaker: pressure on Nifty (FPI outflow risk), oil importers; IT exporters gain',
    },
    {
      id: 'DXY', name: 'Dollar index (DXY)', cls: 'fx', region: 'GLOBAL', yahoo: 'DX-Y.NYB', cnbc: '.DXY',
      dailyVolPct: 0.4, tradingMinutes: 1440, maxStaleMin: 30,
      floorPct: { m15: 0.15, h1: 0.25, session: 0.5 },
      hintDown: 'weaker USD: Gold/BTC/EM (incl. INR) usually firmer',
      hintUp: 'stronger USD: Gold/BTC/EM (incl. INR) usually softer',
    },

    // ----- Crypto -----
    {
      id: 'BTC', name: 'Bitcoin', cls: 'crypto', region: 'GLOBAL', yahoo: 'BTC-USD', cnbc: 'BTC=',
      kraken: { pair: 'XBTUSD', key: 'XXBTZUSD' }, coinbase: 'BTC-USD',
      dailyVolPct: 2.8, tradingMinutes: 1440, maxStaleMin: 10,
      hintDown: 'ETH/SOL typically fall harder; Nasdaq/risk assets may follow',
      hintUp: 'ETH/SOL typically rise more; risk-on',
    },
    {
      id: 'ETH', name: 'Ethereum', cls: 'crypto', region: 'GLOBAL', yahoo: 'ETH-USD', cnbc: 'ETH=',
      kraken: { pair: 'ETHUSD', key: 'XETHZUSD' }, coinbase: 'ETH-USD',
      dailyVolPct: 3.6, tradingMinutes: 1440, maxStaleMin: 10,
      hintDown: 'BTC/SOL likely lower; DeFi/alts weaker',
      hintUp: 'BTC/SOL likely higher; alts firm',
    },
    {
      id: 'SOL', name: 'Solana', cls: 'crypto', region: 'GLOBAL', yahoo: 'SOL-USD',
      kraken: { pair: 'SOLUSD', key: 'SOLUSD' }, coinbase: 'SOL-USD',
      dailyVolPct: 4.8, tradingMinutes: 1440, maxStaleMin: 10,
      hintDown: 'BTC/ETH likely lower; high-beta alts weaker',
      hintUp: 'BTC/ETH likely higher; high-beta alts firm',
    },
    {
      id: 'CRYPTO_TOTAL', name: 'Crypto total market cap', cls: 'crypto_total', region: 'GLOBAL',
      dailyVolPct: 2.8, tradingMinutes: 1440, maxStaleMin: 15,
      hintDown: 'broad crypto sell-off: BTC/ETH/SOL lower',
      hintUp: 'broad crypto rally: BTC/ETH/SOL higher',
    },
  ],

  // ---------------------------------------------------------------------------------------------
  // PRICE-MOVE WINDOWS. k = multiples of the window's normal volatility.
  // LOW is never sent instantly (goes to the next digest).
  // ---------------------------------------------------------------------------------------------
  windows: [
    { id: 'm15', minutes: 15, k: { LOW: 2.5, MEDIUM: 3.5, HIGH: 6, WORLD_ENDING: 10 } },
    { id: 'h1', minutes: 60, k: { LOW: 2.5, MEDIUM: 3.2, HIGH: 5.5, WORLD_ENDING: 9 } },
    { id: 'session', k: { LOW: 1.8, MEDIUM: 2.5, HIGH: 4, WORLD_ENDING: 7 } },
  ],

  // After an alert at severity S for an asset, stay quiet for this many minutes unless severity escalates.
  cooldownMin: { LOW: 240, MEDIUM: 60, HIGH: 45, WORLD_ENDING: 30 },
  // A same-severity session move re-alerts after the cooldown only if it extended by this many daily sigmas.
  sessionExtensionSigma: 0.75,
  // HIGH / WORLD-ENDING price alerts are cross-checked against a 2nd data source before sending.
  confirmFrom: 'HIGH',

  // ---------------------------------------------------------------------------------------------
  // DELIVERY
  // ---------------------------------------------------------------------------------------------
  channels: {
    whatsappMaxChars: 900,   // CallMeBot is a GET URL; keep messages short. Longer text is split.
    telegramMaxChars: 3800,  // Telegram hard limit is 4096
    maxMessagesPerRun: 3,    // per channel per minute; the rest stays queued for the next minute
    retries: 3,              // WhatsApp attempts before failing over
    backoffMs: [700, 1800],
    timeoutMs: 8000,
    whatsappDownAfter: 3,    // consecutive failed sends before "WhatsApp looks down" is sent to Telegram
    bothChannelsFrom: 'HIGH', // HIGH and WORLD-ENDING go to both channels every time
  },

  // ---------------------------------------------------------------------------------------------
  // NEWS
  // Poll cost: each feed is one subrequest. everyMin staggers polling to protect the free plan.
  // ---------------------------------------------------------------------------------------------
  news: {
    maxScoredPerRun: 24,
    batchSize: 12,
    maxAgeMinutesForInstant: 120,
    similarity: 0.6,         // lower = merges more paraphrases (risk: different stories merged); higher = more duplicate alerts
    maxMediumPerHour: 8,
    // Google News RSS is NOT used: it answered every query with HTTP 503 from Cloudflare's network (throttled IPs),
    // while all the publisher feeds below work from there (verified with the Worker's /feeds endpoint).
    feeds: [
      // --- every minute: fastest breaking-news sources
      { id: 'skynews-world', name: 'Sky News World', kind: 'general', trust: 'media', everyMin: 1, url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
      { id: 'cbs-world', name: 'CBS News World', kind: 'general', trust: 'media', everyMin: 1, url: 'https://www.cbsnews.com/latest/rss/world' },
      { id: 'cnbc-top', name: 'CNBC Top News', kind: 'general', trust: 'media', everyMin: 1, url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { id: 'mw-rt', name: 'MarketWatch Real-time', kind: 'general', trust: 'media', everyMin: 1, url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
      // --- every 2 minutes
      { id: 'wsj-markets', name: 'WSJ Markets', kind: 'general', trust: 'media', everyMin: 2, url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
      { id: 'abc-intl', name: 'ABC News International', kind: 'general', trust: 'media', everyMin: 2, url: 'https://abcnews.go.com/abcnews/internationalheadlines' },
      { id: 'france24', name: 'France 24', kind: 'general', trust: 'media', everyMin: 2, url: 'https://www.france24.com/en/rss' },
      { id: 'bbc-world', name: 'BBC World', kind: 'general', trust: 'media', everyMin: 2, url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { id: 'bbc-biz', name: 'BBC Business', kind: 'general', trust: 'media', everyMin: 2, url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
      { id: 'aljazeera', name: 'Al Jazeera', kind: 'general', trust: 'media', everyMin: 2, url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { id: 'fed-press', name: 'Federal Reserve press releases', kind: 'official', trust: 'official', everyMin: 2, url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
      { id: 'rbi-press', name: 'RBI press releases', kind: 'official', trust: 'official', everyMin: 2, url: 'https://www.rbi.org.in/pressreleases_rss.xml' },
      // --- every 3 minutes
      { id: 'sec-press', name: 'SEC press releases', kind: 'official', trust: 'official', everyMin: 3, url: 'https://www.sec.gov/news/pressreleases.rss' },
      { id: 'et-markets', name: 'Economic Times Markets', kind: 'general', trust: 'media', everyMin: 3, url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
      { id: 'mint-markets', name: 'Mint Markets', kind: 'general', trust: 'media', everyMin: 3, url: 'https://www.livemint.com/rss/markets' },
      { id: 'hindu-bl', name: 'The Hindu BusinessLine Markets', kind: 'general', trust: 'media', everyMin: 3, url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss' },
      { id: 'cointelegraph', name: 'Cointelegraph', kind: 'crypto', trust: 'media', everyMin: 3, url: 'https://cointelegraph.com/rss' },
      { id: 'coindesk', name: 'CoinDesk', kind: 'crypto', trust: 'media', everyMin: 3, url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    ],
  },

  // Free-tier LLM chain, tried in order. dailyCap is OUR self-imposed ceiling (stays under the provider limit).
  // If your Groq key lists other models (curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models), edit the ids here.
  llm: {
    timeoutMs: 12000,
    chain: [
      // Models your Groq key can actually use (checked 2026-11-13 via GET /openai/v1/models; Llama models were NOT enabled).
      // Real free limits from Groq's response headers for these: 1,000 requests/day, 8,000 tokens/minute.
      { provider: 'groq', model: 'openai/gpt-oss-120b', dailyCap: 400 },
      { provider: 'groq', model: 'openai/gpt-oss-20b', dailyCap: 400 },
      { provider: 'workersai', model: '@cf/meta/llama-3.1-8b-instruct-fp8', dailyCap: 120 },
      { provider: 'gemini', model: 'gemini-2.5-flash-lite', dailyCap: 150 },
    ],
  },

  // ---------------------------------------------------------------------------------------------
  // CRYPTO EXTRAS
  // ---------------------------------------------------------------------------------------------
  crypto: {
    liquidations: {
      enabled: true, everyMin: 2, windowMin: 5,
      // USD liquidated on OKX perpetuals (BTC+ETH+SOL) inside the window. OKX is one venue of many.
      usdThresholds: { MEDIUM: 40_000_000, HIGH: 150_000_000, WORLD_ENDING: 600_000_000 },
    },
    openInterest: {
      // Bybit open-interest drop over ~15 min: a keyless proxy for a liquidation cascade.
      enabled: true, everyMin: 5,
      dropPctThresholds: { MEDIUM: 2.5, HIGH: 5, WORLD_ENDING: 10 },
    },
    totalMarketEveryMin: 3,
  },

  // ---------------------------------------------------------------------------------------------
  // MACRO CALENDAR
  // ---------------------------------------------------------------------------------------------
  macro: {
    headsUpMinutes: 30,
    // minutes after the scheduled time at which the Worker tries to read the actual figure
    resultPollOffsetsMin: [0, 1, 2, 3, 5, 8, 12, 20, 30],
    ffImpacts: ['High'],
    ffCountries: ['USD', 'EUR', 'GBP', 'JPY', 'CNY'],
    rules: [
      { match: '^CPI m/m$', country: 'USD', label: 'US CPI (m/m)', sigma: 0.1, watch: true,
        resolver: { type: 'bls', series: 'CUSR0000SA0', transform: 'mom' },
        hintHigher: 'hot inflation: USD/DXY and USD/INR up; Gold, Nasdaq/S&P, BTC, Nifty down',
        hintLower: 'cool inflation: USD/DXY down; Gold, Nasdaq/S&P, BTC, Nifty up' },
      { match: '^Core CPI m/m$', country: 'USD', label: 'US Core CPI (m/m)', sigma: 0.1, watch: true,
        resolver: { type: 'bls', series: 'CUSR0000SA0L1E', transform: 'mom' },
        hintHigher: 'hot core inflation: USD up; Gold, equities, BTC down',
        hintLower: 'soft core inflation: USD down; Gold, equities, BTC up' },
      { match: '^CPI y/y$', country: 'USD', label: 'US CPI (y/y)', sigma: 0.1, watch: true,
        resolver: { type: 'bls', series: 'CUUR0000SA0', transform: 'yoy' },
        hintHigher: 'hot inflation: USD up; Gold, equities, BTC down',
        hintLower: 'cool inflation: USD down; Gold, equities, BTC up' },
      { match: '^Non-Farm Employment Change$', country: 'USD', label: 'US Non-Farm Payrolls', sigma: 75, watch: true,
        resolver: { type: 'bls', series: 'CES0000000001', transform: 'change' },
        hintHigher: 'strong jobs: USD and yields up; Gold down; equities mixed (fewer cuts priced)',
        hintLower: 'weak jobs: USD down; Gold up; equities mixed (growth fear vs more cuts)' },
      { match: '^Unemployment Rate$', country: 'USD', label: 'US unemployment rate', sigma: 0.1, watch: true,
        resolver: { type: 'bls', series: 'LNS14000000', transform: 'level' },
        hintHigher: 'weaker labour market: USD down, Gold up, equities mixed',
        hintLower: 'tighter labour market: USD up, Gold down' },
      { match: '^Average Hourly Earnings m/m$', country: 'USD', label: 'US avg hourly earnings (m/m)', sigma: 0.1, watch: true,
        resolver: { type: 'bls', series: 'CES0500000003', transform: 'mom' },
        hintHigher: 'wage pressure: USD up, Gold/equities down', hintLower: 'wage cooling: USD down, Gold/equities up' },
      { match: 'PPI m/m$', country: 'USD', label: 'US PPI (m/m)', sigma: 0.2, watch: true,
        resolver: { type: 'llm', query: 'US producer price index PPI month' },
        hintHigher: 'hot producer prices: USD up, Gold/equities down', hintLower: 'cool producer prices: USD down, Gold/equities up' },
      { match: 'GDP q/q$', country: 'USD', label: 'US GDP (q/q)', sigma: 0.4, watch: true,
        resolver: { type: 'llm', query: 'US GDP growth quarter annualized Commerce Department' },
        hintHigher: 'stronger growth: USD up, yields up', hintLower: 'weaker growth: USD down, Gold up, equities mixed' },
      { match: '^Retail Sales m/m$', country: 'USD', label: 'US retail sales (m/m)', sigma: 0.4, watch: true,
        resolver: { type: 'llm', query: 'US retail sales month Commerce Department' },
        hintHigher: 'strong consumer: USD up, Gold down', hintLower: 'weak consumer: USD down, Gold up' },
      { match: '^Federal Funds Rate$', country: 'USD', label: 'Fed rate decision', sigma: 0.25, watch: true,
        resolver: { type: 'llm', query: 'Federal Reserve FOMC decision federal funds rate target range' },
        hintHigher: 'more hawkish than expected: USD up; Gold, equities, BTC, Nifty down',
        hintLower: 'more dovish than expected: USD down; Gold, equities, BTC, Nifty up' },
      { match: '^Main Refinancing Rate$', country: 'EUR', label: 'ECB rate decision', sigma: 0.25, watch: true,
        resolver: { type: 'llm', query: 'ECB interest rate decision main refinancing' },
        hintHigher: 'hawkish ECB: EUR up, DXY down, equities mixed', hintLower: 'dovish ECB: EUR down, DXY up' },
      { match: '^Official Bank Rate$', country: 'GBP', label: 'BoE rate decision', sigma: 0.25, watch: true,
        resolver: { type: 'llm', query: 'Bank of England interest rate decision' },
        hintHigher: 'hawkish BoE: GBP up, DXY down', hintLower: 'dovish BoE: GBP down, DXY up' },
      { match: '^BOJ Policy Rate$', country: 'JPY', label: 'BoJ rate decision', sigma: 0.25, watch: true,
        resolver: { type: 'llm', query: 'Bank of Japan policy rate decision' },
        hintHigher: 'hawkish BoJ: JPY up, global carry trades unwind (risk-off)', hintLower: 'dovish BoJ: JPY down, carry trades supported' },
    ],

    // Fixed schedules the free calendar feeds do not cover (India) or that we want as a 2nd source.
    // VERIFY dates against official sources; `approx: true` events say so in the alert.
    // FOMC: federalreserve.gov/monetarypolicy/fomccalendars.htm (decision day = 2nd day, 14:00 ET)
    // RBI MPC: rbi.org.in/scripts/annualpolicy.aspx (decision = last day, ~10:00 IST)
    fixedEvents: [
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2026-12-09', time: '14:00', tz: 'America/New_York', impact: 'High',
        resolver: { type: 'llm', query: 'Federal Reserve FOMC decision federal funds rate target range' },
        hintHigher: 'more hawkish than expected: USD up; Gold, equities, BTC, Nifty down',
        hintLower: 'more dovish than expected: USD down; Gold, equities, BTC, Nifty up' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-01-27', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-03-17', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-04-28', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-06-09', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-07-28', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-09-15', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-10-27', time: '14:00', tz: 'America/New_York', impact: 'High' },
      { title: 'Fed rate decision (FOMC)', country: 'USD', date: '2027-11-17', time: '14:00', tz: 'America/New_York', impact: 'High' },

      { title: 'RBI MPC policy decision', country: 'INR', date: '2026-12-04', time: '10:00', tz: 'Asia/Kolkata', impact: 'High',
        resolver: { type: 'llm', query: 'RBI monetary policy repo rate decision Governor' },
        hintHigher: 'hawkish RBI: rupee firmer, bank stocks mixed, Nifty softer',
        hintLower: 'dovish RBI: rupee softer, rate-sensitives (banks, realty, autos) firmer' },
      { title: 'RBI MPC policy decision', country: 'INR', date: '2027-02-05', time: '10:00', tz: 'Asia/Kolkata', impact: 'High' },

      // India data: dates are approximate (CPI ~12th at 16:00 IST rolled to next working day; GDP end of quarter+2 months).
      { title: 'India GDP (Jul-Sep quarter)', country: 'INR', date: '2026-11-30', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true,
        resolver: { type: 'llm', query: 'India GDP growth quarter NSO' } },
      { title: 'India CPI inflation', country: 'INR', date: '2026-12-14', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true,
        resolver: { type: 'llm', query: 'India CPI retail inflation MoSPI' } },
      { title: 'India CPI inflation', country: 'INR', date: '2027-01-12', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true },
      { title: 'India CPI inflation', country: 'INR', date: '2027-02-12', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true },
      { title: 'India GDP (Oct-Dec quarter)', country: 'INR', date: '2027-02-26', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true },
      { title: 'India CPI inflation', country: 'INR', date: '2027-03-12', time: '16:00', tz: 'Asia/Kolkata', impact: 'High', approx: true },
    ],
  },

  // ---------------------------------------------------------------------------------------------
  // DIGESTS (GitHub Actions). India digest 08:30 IST; US digest 08:30 ET (handles daylight saving).
  // ---------------------------------------------------------------------------------------------
  digest: {
    weekdaysOnly: true,
    india: { istTime: '08:30', windowMin: 75 },
    us: { etTime: '08:30', windowMin: 55 },
    maxLowItems: 12,
  },

  // ---------------------------------------------------------------------------------------------
  // HEALTH
  // ---------------------------------------------------------------------------------------------
  health: {
    workerStaleMinutes: 6,   // heartbeat older than this -> "Worker not running" alert
    sourceFailAfter: 10,     // consecutive failed polls before a source-failure alert
    llmWarnAtPct: 85,        // warn when the LLM chain has used this % of its daily caps
  },
};

