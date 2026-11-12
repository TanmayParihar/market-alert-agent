// Shared types. Platform-neutral: runs in Cloudflare Workers and in Node (GitHub Actions / tests).

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'WORLD_ENDING';
export type AssetClass = 'index' | 'vol' | 'commodity' | 'fx' | 'crypto' | 'crypto_total';
export type WindowId = 'm15' | 'h1' | 'session';
export type AlertKind = 'price' | 'vol' | 'news' | 'macro' | 'crypto' | 'system' | 'digest' | 'test';
export type AlertStatus = 'pending' | 'sent' | 'failed' | 'digest_pending' | 'digested' | 'suppressed';

/** [epoch seconds, price] */
export type Sample = [number, number];

export interface CircuitRule {
  /** absolute % move from previous close */
  pct: number;
  severity: Severity;
  label: string;
  /** 'down' = only declines trigger it (US market-wide breakers); 'both' = either direction */
  direction: 'down' | 'both';
}

export interface LevelRule {
  /** fires once when the level is crossed upward */
  gte: number;
  severity: Severity;
  label: string;
}

export interface AssetDef {
  id: string;
  name: string;
  cls: AssetClass;
  region: 'US' | 'IN' | 'GLOBAL';
  yahoo?: string;
  cnbc?: string;
  nse?: string;
  kraken?: { pair: string; key: string };
  coinbase?: string;
  /** typical one-day standard deviation of the move, in % (drives every default threshold) */
  dailyVolPct: number;
  /** minutes the asset trades per day (scales daily vol to 15m / 1h windows) */
  tradingMinutes: number;
  /** data older than this is treated as "market closed" and never triggers */
  maxStaleMin: number;
  /** minimum absolute % for any MEDIUM+ alert, per window (noise floor) */
  floorPct?: Partial<Record<WindowId, number>>;
  /** explicit % thresholds that replace the volatility-scaled ones for a window */
  thresholds?: Partial<Record<WindowId, Partial<Record<Severity, number>>>>;
  circuit?: CircuitRule[];
  levels?: LevelRule[];
  /** informational hints used in the "trade-impact" line */
  hintDown: string;
  hintUp: string;
}

export interface WindowCfg {
  id: WindowId;
  /** minutes for m15/h1; session uses previous close */
  minutes?: number;
  /** threshold = k x sigma_window */
  k: Record<Severity, number>;
}

export interface FeedDef {
  id: string;
  name: string;
  url: string;
  /** poll every N minutes (staggered by feed index) */
  everyMin: number;
  kind: 'targeted' | 'general' | 'official' | 'crypto';
  trust: 'official' | 'wire' | 'media' | 'aggregator';
  maxItems?: number;
}

export interface MacroResolver {
  type: 'bls' | 'llm';
  /** bls: BLS series id; transform describes how FF's number is derived */
  series?: string;
  transform?: 'mom' | 'yoy' | 'level' | 'change';
  /** llm: Google-News query used to find coverage of the result */
  query?: string;
}

export interface MacroEventRule {
  /** matched against FF title (case-insensitive) */
  match: string;
  country: string;
  label: string;
  /** typical surprise size in the event's own units, for severity */
  sigma: number;
  resolver: MacroResolver;
  hintHigher: string;
  hintLower: string;
  /** always heads-up, even if FF marks it Medium impact */
  watch?: boolean;
}

export interface FixedEvent {
  title: string;
  country: string;
  /** local date YYYY-MM-DD in `tz` */
  date: string;
  time: string;
  tz: string;
  impact: 'High' | 'Medium';
  approx?: boolean;
  forecast?: string;
  resolver?: MacroResolver;
  hintHigher?: string;
  hintLower?: string;
}

export interface AgentConfig {
  timezone: string;
  assets: AssetDef[];
  windows: WindowCfg[];
  cooldownMin: Record<Severity, number>;
  /** a same-severity session-window move re-alerts only after extending by this many daily sigmas */
  sessionExtensionSigma: number;
  /** price alert must be confirmed by a 2nd source from this severity upward */
  confirmFrom: Severity;
  channels: {
    whatsappMaxChars: number;
    telegramMaxChars: number;
    maxMessagesPerRun: number;
    retries: number;
    backoffMs: number[];
    timeoutMs: number;
    /** WhatsApp declared "down" after this many consecutive failed sends */
    whatsappDownAfter: number;
    bothChannelsFrom: Severity;
  };
  news: {
    feeds: FeedDef[];
    maxScoredPerRun: number;
    batchSize: number;
    maxAgeMinutesForInstant: number;
    similarity: number;
    /** MEDIUM news beyond this many per hour is demoted to the digest (HIGH+ never demoted) */
    maxMediumPerHour: number;
  };
  llm: {
    chain: Array<{ provider: 'groq' | 'gemini' | 'workersai'; model: string; dailyCap: number }>;
    timeoutMs: number;
  };
  crypto: {
    liquidations: { enabled: boolean; everyMin: number; windowMin: number; usdThresholds: Record<'MEDIUM' | 'HIGH' | 'WORLD_ENDING', number> };
    openInterest: { enabled: boolean; everyMin: number; dropPctThresholds: Record<'MEDIUM' | 'HIGH' | 'WORLD_ENDING', number> };
    totalMarketEveryMin: number;
  };
  macro: {
    headsUpMinutes: number;
    resultPollOffsetsMin: number[];
    rules: MacroEventRule[];
    fixedEvents: FixedEvent[];
    ffImpacts: string[];
    ffCountries: string[];
  };
  digest: {
    weekdaysOnly: boolean;
    india: { istTime: string; windowMin: number };
    us: { etTime: string; windowMin: number };
    maxLowItems: number;
  };
  health: {
    workerStaleMinutes: number;
    sourceFailAfter: number;
    llmWarnAtPct: number;
  };
}

export interface Snapshot {
  id: string;
  price: number;
  prevClose: number | null;
  /** epoch seconds of the source's own last-trade/bar time */
  ts: number;
  source: string;
  series?: Sample[];
  halted?: boolean;
}

export interface LastAlert {
  severity: Severity;
  at: number; // epoch ms
  pct: number;
  window: WindowId | 'level' | 'circuit';
}

export interface AssetState {
  asset_id: string;
  last_price: number | null;
  prev_close: number | null;
  last_ts: number | null;
  source: string | null;
  ring: Sample[];
  last_alert: LastAlert | null;
}

export interface FeedState {
  feed_id: string;
  seen: string[];
  last_ok: string | null;
  last_err: string | null;
  fails: number;
}

export interface AlertCandidate {
  dedupeKey: string;
  kind: AlertKind;
  severity: Severity;
  headline: string;
  what: string;
  impact: string;
  source: string;
  sourceTime: number; // epoch ms
  assetIds: string[];
  payload?: Record<string, unknown>;
  /** system alerts: force both channels */
  forceBoth?: boolean;
  /** shown instead of the severity marker (e.g. SYSTEM) */
  marker?: string;
}

export interface AlertRow {
  id: string;
  dedupe_key: string;
  kind: AlertKind;
  severity: Severity;
  status: AlertStatus;
  reason: string | null;
  headline: string;
  what: string | null;
  impact: string | null;
  source: string | null;
  source_time: string | null;
  asset_ids: string[];
  payload: Record<string, unknown>;
  attempts?: number;
  delivery?: DeliveryAttempt[];
  created_at?: string;
}

export interface DeliveryAttempt {
  channel: 'whatsapp' | 'telegram';
  ok: boolean;
  at: string;
  attempt: number;
  detail?: string;
}

export interface AlertUpdate {
  id: string;
  status: AlertStatus;
  reason?: string | null;
  channels?: string[];
  delivery?: DeliveryAttempt[];
  attempts_inc?: number;
  sent_at?: string | null;
  digested_at?: string | null;
}

export interface NewsRow {
  id: string;
  published_at: string | null;
  source: string;
  feed_id: string;
  title: string;
  title_norm: string;
  url: string | null;
  cluster_id: string;
  is_market_moving: boolean;
  severity: Severity | 'NONE';
  scorer: string;
  score: Record<string, unknown>;
}

export interface MacroEventRow {
  id: string;
  source: string;
  title: string;
  country: string;
  impact: string;
  event_time: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  status: 'scheduled' | 'headsup_sent' | 'result_sent' | 'result_missed' | 'cancelled';
  watch: boolean;
  approx: boolean;
  resolver: MacroResolver | null;
  attempts: number;
  meta: Record<string, unknown>;
}

export interface TickState {
  assets: Record<string, AssetState>;
  feeds: Record<string, FeedState>;
  kv: Record<string, any>;
  pending: AlertRow[];
  events: MacroEventRow[];
  eventCount48h: number;
}

export interface ApplyPayload {
  assets?: AssetState[];
  feeds?: FeedState[];
  news_items?: NewsRow[];
  alerts_insert?: AlertRow[];
  alerts_update?: AlertUpdate[];
  events?: Array<Partial<MacroEventRow> & { id: string }>;
  events_upsert?: MacroEventRow[];
  kv?: Record<string, unknown>;
}

export interface Store {
  loadTickState(nowMs: number): Promise<TickState>;
  apply(p: ApplyPayload): Promise<{ inserted: string[] }>;
  recentNews(sinceMs: number): Promise<Array<Pick<NewsRow, 'id' | 'cluster_id' | 'title_norm' | 'source' | 'severity'>>>;
}

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  CALLMEBOT_PHONE: string;
  CALLMEBOT_APIKEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  ADMIN_TOKEN?: string;
  DRY_RUN?: string;
  AI?: { run(model: string, input: unknown): Promise<any> };
}
