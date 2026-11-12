# Market-alert agent

A personal agent that watches indices, commodities, FX, crypto, news and the macro calendar, and messages **your own WhatsApp** (CallMeBot) when something significant happens, with a **Telegram** fallback. It runs 24/7 in the cloud on free tiers only (no card anywhere), and all times are shown in **IST**.

```
                 every minute                                 free tier: Cloudflare Workers (cron, TypeScript)
  Yahoo + CNBC (prices) ─┐                                    ┌───────────────────────────────────────────────┐
  Kraken/Coinbase/NSE ───┤                                    │ FAST PATH  src/worker/tick.ts                  │
  OKX/Bybit (liquidation)┼──▶ detect ─▶ score ─▶ dedupe ─▶ ──▶│ prices · news · macro · crypto · health        │──▶ WhatsApp (CallMeBot)
  16 RSS / Google News ──┤    triggers  severity  cooldown    │ 2 Supabase round-trips + ≤ ~20 fetches/minute  │──▶ Telegram (failover / HIGH+)
  Free LLM (Groq → …) ───┤                                    └───────────────┬───────────────────────────────┘
  BLS (macro actuals) ───┘                                                    │ state, alert history, heartbeat
                                                                      Supabase Postgres (free)
                                                                              ▲
  GitHub Actions (free)  SLOW PATH: 2 digests/day · calendar refresh · Worker heartbeat watchdog · weekly review · keepalive
  The Worker also re-dispatches late digests, refreshes an empty calendar and re-enables disabled workflows (safeguards).
```

**Deployment status (2026-11-13).** Already done for you: Supabase project `market-alert-agent` (Mumbai, free) with the schema applied and RLS verified; public GitHub repo `TanmayParihar/market-alert-agent` with CI green; Worker deployed at `https://market-alert-agent.market-alert-agent.workers.dev` on a `* * * * *` cron; `/probe` confirmed that Yahoo, CNBC, NSE, Kraken, Coinbase and CoinPaprika are all reachable **from Cloudflare's network**. What only you can supply is your own credentials: run **`npm run setup`** once (see "Quick finish" below). Until then the Worker runs every minute but cannot reach Supabase or send messages, so `/health` reports not-ok.

### Quick finish (the only manual part)
```bash
npm run setup     # asks for 2 required values (Supabase secret key, Telegram bot token) + optional WhatsApp (CallMeBot) and Groq/GitHub keys,
                  # finds your Telegram chat id itself, stores every secret in Cloudflare + GitHub + .dev.vars,
                  # then sends one test alert of each severity to your phone
```
Then in GitHub → Actions run **calendar** once. Steps 1–8 below are already done; they stay as the from-scratch reference.

**Status of the code:** complete and tested (136 unit/integration tests, the real SQL schema run in an in-process Postgres and on the live Supabase project, a live-data dry run, a Worker bundle build). Not yet exercised with *your* CallMeBot, Telegram or Groq accounts: the test alerts in `npm run setup` are the first real run.

---

## 1. Verified free-tier limits and how much headroom the design leaves

Checked on **2026-11-13**. "Docs" = read from the vendor's page today; "Measured" = I called the endpoint today; "Third-party" = vendor page did not state it, so treat as approximate; the agent enforces its own caps and reads 429s regardless.

| Service | Verified free limit | How verified | Design's expected use | Headroom |
|---|---|---|---|---|
| **Cloudflare Workers** (fast path) | 100,000 requests/day · **10 ms CPU per invocation** (HTTP and Cron) · **50 subrequests per invocation** · 5 cron triggers/account · 128 MB memory | Docs | 1,440 cron runs/day (1.4 %) · 1 cron trigger of 5 · typically 10–20 subrequests/minute, hard budget of 48 | Requests 98 %; subrequests ≥ 60 %; **CPU is the tight one, see below** |
| **Workers AI** (last-resort LLM) | 10,000 neurons/day, no paid plan needed | Docs | Only when both Groq models are limited; capped at 120 calls/day by us | large |
| **Supabase** (state + history) | 500 MB DB · 5 GB egress · 2 free projects · **paused after 1 week of inactivity** · "unlimited API requests" | Docs (pricing page) | DB: well under 50 MB/year (3-day news retention, ~100 alerts/day). Egress: ~13–16 KB state read per minute ≈ **~0.7–0.9 GB/month**. Per-minute writes keep the project active, so the 1-week pause cannot trigger while the Worker runs | DB > 95 %, egress ≈ 80 % |
| **GitHub Actions** (slow path) | Public repo: standard runners free. Private repo: $12 compute credit/month (≈ 2,000 Linux min, my calculation, not stated as minutes). Scheduled workflows: **minimum interval 5 min, can be delayed or dropped under load, auto-disabled on PUBLIC repos after 60 days without repo activity, run only on the default branch** | Docs | ~100 min/month for digests, calendar, weekly review, keepalive; heartbeat adds 4,320 min/month at `*/10` (1,440 at `*/30`) because each job bills a 1-minute minimum | Public: unlimited. Private: switch heartbeat to `*/30` or `*/60` |
| **CallMeBot WhatsApp** | Free, "only for personal use", sends only to your own activated number. **No rate limit or text-length limit is published** | Docs (page states none) | 5–30 messages/day typical; hard cap 3 messages/minute, ≤ 900 chars each | Unknown by nature: see limitations |
| **Telegram Bot API** | ~1 msg/s per chat (bursts may 429), 20 msg/min in groups, ~30 msg/s bulk; 4096 chars per message | Docs (rate limits); length from Bot API docs (not re-fetched) | ≤ 3 messages/minute with 1.1 s gaps | > 95 % |
| **Groq** (primary LLM) | For THIS account: `openai/gpt-oss-120b` and `openai/gpt-oss-20b`, **1,000 requests/day and 8,000 tokens/minute each** (read from Groq's response headers on 2026-11-13). Llama models were not enabled for the key even though Groq's public page lists them | Measured (response headers) | Only *new, relevant, non-duplicate* headlines, batched 12 per call: typically 30–150 calls/day. Self-imposed caps: 400/day per model; a 429 (e.g. a daily token limit) triggers cool-down and fail-over | > 55 % |
| **Google Gemini** (optional 3rd LLM) | **Google no longer publishes per-model free limits** on its rate-limit page | Docs + search | Off unless you add a key; capped at 150/day | n/a |
| **BLS public API v1** (US CPI/payrolls actuals) | Keyless; 25 queries/day, 25 series/query (BLS documentation, from memory) | Endpoint measured working keyless today; limit not re-fetched | ≤ 9 queries per release day; hard cap 20/day in code | > 60 % |
| **Yahoo Finance spark**, **CNBC quote API**, **NSE**, **Kraken**, **Coinbase**, **CoinGecko**, **CoinPaprika**, **OKX**, **Bybit**, **Google News RSS**, publisher RSS feeds | Keyless, **no published free-tier terms** (Yahoo, CNBC, NSE, OKX/Bybit feeds are unofficial/undocumented) | Measured working today (OKX unreachable from my network, see limitations) | 1 call/min each for Yahoo+CNBC, 1 per 3 min for CoinGecko, 16 RSS feeds at 1 call per 1–3 min | Far below usual limits; blocking, not quota, is the risk |
| **ForexFactory export feed** (calendar) | Rate-limits hard; `ff_calendar_nextweek.json` returned 404 today (published late in the week) | Measured | 2 requests/day from GitHub (never per minute) | Large |

**Worker CPU (the one to watch).** The free plan allows 10 ms of CPU per run. I benchmarked a full minute on real captured responses (`npm run bench`, Node/V8 on a laptop with extra test-harness overhead): **~4–5 ms warm average, p95 ~8 ms, a cold first run ~12–15 ms**. In production, network waiting is not charged as CPU, so real numbers should be at or below these, but a *cold isolate* can be near the limit. Mitigations built in: feeds are staggered (`everyMin`), only the first 15 items of a feed are parsed, JSON ring buffers are tiny, regexes are precompiled. If Cloudflare logs show "exceeded CPU", raise `everyMin` on a few feeds in `agent.config.ts` (each ≈ 0.3 ms) or remove feeds. After deploying, check *Workers → market-alert-agent → Metrics → CPU time*.

**Latency.** Prices: polled every minute, so alert ≈ source time + ≤ 1 min. News: fast feeds (Google News geopolitics/crises, CNBC, MarketWatch) are polled every minute, others every 2–3 min, then ~1–3 s for the LLM, so typically **1–2 min** from appearing in the feed; the 3-minute feeds (SEC, Economic Times, Mint, Cointelegraph) can take up to ~3–4 min. Google News itself indexes with a delay of a few minutes.

## 2. Data sources and how fresh they are

At least two sources per category; **Yahoo and CNBC are queried together every minute and the freshest quote per asset wins** (Yahoo's 5-minute history is kept for window calculations).

| Category | Sources (in order) | Freshness measured 2026-11-12/13 |
|---|---|---|
| US indices (S&P, Nasdaq, Dow) | Yahoo + CNBC | **Real-time** (last tick within seconds; CNBC flags `realTime`) |
| VIX | Yahoo + CNBC | CNBC real-time; **Yahoo was ~15 min behind**, hence freshest-wins |
| Indian indices (Nifty, Bank Nifty) | Yahoo + CNBC, plus **NSE's own live feed during Indian market hours** (freshest wins; NSE verified reachable from Cloudflare) | **Live delay not yet measured** (market was closed during my checks; all sources showed the same closing print). Run query 9 in `sql/review-queries.sql` on the first trading morning to see each source's lag |
| Sensex | Yahoo only (BSE's API blocks bots; CNBC has no Sensex) | single source; unmeasured |
| India VIX | Yahoo + NSE (live, market hours) | NSE is the exchange's own feed |
| Gold, silver, crude, nat gas (futures) | Yahoo + CNBC | **~10 min delayed** at both sources |
| DXY | Yahoo + CNBC | CNBC real-time; Yahoo ~10 min behind |
| USD/INR | Yahoo + CNBC (`INR=`) | Yahoo's last update was ~27 min old at my check: this quote updates sparsely; staleness allowance is 30 min |
| BTC, ETH, SOL | Yahoo + CNBC (BTC/ETH), then Kraken, then Coinbase | Real-time |
| Total crypto market cap | CoinGecko, then CoinPaprika | Updates every few minutes (polled every 3) |
| Liquidations | OKX public liquidation feed (USD), Bybit open-interest collapse (cascade proxy) | Real-time; **OKX response shape unverified**, see limitations |
| Breaking news | 5 Google News queries + CNBC, MarketWatch, BBC World/Business, Al Jazeera, Economic Times, Mint, Cointelegraph, plus official Fed, RBI and SEC press-release feeds | 1–3 min polling |
| Calendar | ForexFactory export feed (this/next week) + fixed schedules in config (FOMC, RBI MPC, India CPI/GDP) | Daily refresh |
| Macro actuals | BLS API (US CPI, core CPI, payrolls, unemployment, wages); LLM extraction from news for everything else | Within ~1–5 min of release (BLS) / best effort (LLM) |

The ForexFactory **website** is behind a Cloudflare bot challenge, so it is not scraped (and bypassing that is not something this project does); only their published export feed is used.

## 3. Severity rubric (used for price, news, macro and volatility triggers)

| Level | Meaning & routing | Price / vol | News | Macro |
|---|---|---|---|---|
| ⚪ **LOW** | Notable but routine. **Never instant**: collected into the next digest | ~1.8–2.5 σ move (S&P −1.8 % on the day) | Corporate/sector items with no clear read-through | Second-tier data, in line |
| 🟡 **MEDIUM** | Likely to move a market you watch today. **Instant**, WhatsApp (Telegram if it fails) | 2.5–4 σ (S&P −2.5 %, BTC −7 %, gold +0.4 % in 15 min); VIX > 25; India VIX > 20 | Surprise tariffs/sanctions/rate decision, crypto regulatory action, bank/exchange trouble in one region | Tier-1 release heads-up and result (surprise < 2 σ) |
| 🔴 **HIGH** | Major, cross-market. **Instant, both channels every time** | 4–7 σ (S&P −4 %, Nifty −3.6 %, BTC −11 %); VIX > 35; India VIX > 28; liquidation cascade | Military escalation between significant powers, emergency central-bank action, systemic bank / top-10 exchange failure, oil-supply shock | ≥ 2 σ surprise (CPI 0.2 pp off), or a rate decision opposite to consensus |
| 🚨 **WORLD-ENDING** | Rare systemic shock (2008, March 2020, major war outbreak, top-tier exchange collapse). **Instant, both channels** | ≥ 7 σ or a market-wide circuit breaker (US −7 %, NSE index ±10 %); VIX > 50 | War outbreak involving major powers, nuclear event, top-tier bank/exchange/stablecoin collapse, major sovereign default | Never from a scheduled release alone |

σ = the asset's normal move over that window (`dailyVolPct × √(window/trading minutes)`; the session window uses the daily σ). `npm run thresholds` prints the exact % table. Examples with the shipped config: S&P session MEDIUM 2.5 % / HIGH 4 % / WORLD 7 %; BTC session 7 % / 11.2 % / 19.6 %; USD/INR 15-minute MEDIUM 0.12 % (noise floor).

**Safety rules on top of the rubric**
- A **WORLD-ENDING news claim from a single, non-official source is capped to HIGH** until a second publisher carries the same story (then it escalates automatically). This also defends against fake headlines and prompt injection.
- A **HIGH/WORLD price move is cross-checked** against a second data source; if it does not agree, it is downgraded to MEDIUM and labelled "NOT confirmed".
- Stale data (market closed) never triggers; absurd short-window index moves are treated as bad ticks.
- Headline text is **untrusted data**: it is passed to the LLM as a JSON string, the reply is validated against a strict schema (unknown assets/ids dropped, severity enum, text sanitised), and a "fooled" model can still not exceed the caps above. Without any LLM, a conservative keyword scorer takes over.

## 4. Message format

```
🔴 HIGH: Fed cuts rates 50bp in surprise move          ← marker + level + headline (≤ 12 words)
What: Fed cut 50 bp between meetings; S&P futures +2.1%.   ← what happened, key number
Impact (info only, not advice): GOLD ↑, BTC ↑, USDINR ↓    ← watched assets and likely direction
Src: Reuters · 14:32 IST                                    ← source and IST time
```
Alerts that fire in the same minute are merged into one message (highest severity first, `📬 3 alerts · …`). What does not fit stays queued for the next minute; nothing is dropped.

**Delivery rules** (as specified): MEDIUM → WhatsApp with retries/backoff, then the same text to Telegram prefixed *"⚠️ WhatsApp delivery failed"*. HIGH/WORLD-ENDING → both channels immediately. After 3 consecutive WhatsApp failures you get **one** Telegram "WhatsApp looks down" note and **one** when it recovers. If every channel fails the alert stays `pending` and is retried every minute for up to ~12 attempts. Every attempt (including failures) is stored in `alerts.delivery`, and the channels that delivered in `alerts.channels`.

**Dedupe and cooldown:** the same story across sources is merged by headline similarity; per-asset cooldown (MEDIUM 60 min, HIGH 45, WORLD 30); an *escalation to a higher severity breaks through*; a same-severity session move re-alerts only if it extended by another 0.75 daily σ.

## 5. Setup, from zero

You need: a GitHub account, a Cloudflare account, a Supabase account, Telegram and WhatsApp on your phone, and Node.js 20+ on your computer (only to deploy and test; nothing runs on it afterwards). **No card is needed for any of these.**

### Step 1: put the code on GitHub (public recommended)
```bash
git init && git add . && git commit -m "market alert agent"
# create an EMPTY repo on github.com (not a fork: forks start with scheduled workflows disabled), then:
git remote add origin https://github.com/YOU/market-alert-agent.git
git branch -M main && git push -u origin main
```
The repo contains **no secrets** (`.dev.vars` is git-ignored), so it can be public. Public = unlimited free Actions minutes. A private repo also works: edit `.github/workflows/heartbeat.yml` to `*/30` (or `*/60`) to stay inside 2,000 minutes/month.

### Step 2: Telegram bot (fallback channel)
1. In Telegram open **@BotFather** → `/newbot` → pick a name and a username ending in `bot` → copy the **token** (`123456:ABC…`).
2. Open your new bot and send it any message (e.g. `/start`). A bot cannot message you until you do.
3. In a browser open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` → find `"chat":{"id":123456789` → that number is your **chat id**. (Do this in your own browser only; the token is a password.)

### Step 3: CallMeBot WhatsApp activation (primary channel, OPTIONAL)
> **Heads-up (2026-11-13):** callmebot.com now shows *"The bot is currently full. Please check back in a few days; once slots are available, the phone number will be visible"* and hides its number, so new activations are impossible until slots reopen (status page: https://www.callmebot.com/callmebot-servers-availability/). **The agent runs fully on Telegram without it**: when `CALLMEBOT_PHONE`/`CALLMEBOT_APIKEY` are not set it sends everything (including HIGH/WORLD-ENDING, digests and health alerts) to Telegram, with no WhatsApp attempts, no failover prefixes and no "WhatsApp down" notices. When a slot opens, finish the steps below and re-run `npm run setup`; WhatsApp switches on automatically. The API itself was verified up (it answered a dummy call with "APIKey is invalid").

1. Save the bot number shown on callmebot.com/blog/free-api-whatsapp-messages in your phone contacts (any name). *It was +34 644 37 67 94 earlier today, and has changed in the past, so always use the one on that page.*
2. In WhatsApp send that contact exactly: `I allow callmebot to send me messages`
3. Wait for the reply `API Activated for your phone number. Your APIKEY is 123456`. If nothing arrives within 2 minutes, CallMeBot says to try again after 24 hours.
4. Note your **phone** with country code (`+91XXXXXXXXXX`) and the **API key**.
5. CallMeBot cannot confirm delivery (it answers "queued"), which is why HIGH/WORLD-ENDING always go to Telegram too.

### Step 4: Supabase (state and history)
1. supabase.com → **New project** (free plan; pick a region near you, e.g. Mumbai). Save the database password somewhere.
2. **SQL Editor → New query**, paste the whole of [`sql/schema.sql`](sql/schema.sql), **Run**. This creates the tables `alerts`, `asset_state`, `feed_state`, `news_items`, `macro_events`, `kv` and three functions (`agent_tick_state`, `agent_apply`, `agent_prune`). Row Level Security is on with no policies, so the public key can read nothing.
3. **Project Settings → API**: copy the **Project URL** (`https://xxxx.supabase.co`) and the **secret key** (`sb_secret_…`; the legacy `service_role` key also works). Never put it in a browser or a public place.

### Step 5: LLM key (free)
console.groq.com → API Keys → create a key (`gsk_…`). The agent works without any LLM key (keyword scoring only) and also uses Cloudflare Workers AI automatically as a fallback. Optional: add `GEMINI_API_KEY` from Google AI Studio as a third fallback.

### Step 6: GitHub token for the Worker (safeguards)
GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → generate: repository access = **only this repo**; permissions = **Actions: Read and write**, Metadata: Read. Fine-grained tokens expire (set a ≤ 1-year reminder; if it lapses the safeguards stop and nothing else breaks).

### Step 7: deploy the Worker to Cloudflare
```bash
npm install
npx wrangler login          # opens a browser; free account, no card
npm run deploy              # first deploy asks you to choose a workers.dev subdomain
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put CALLMEBOT_PHONE
npx wrangler secret put CALLMEBOT_APIKEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO      # OWNER/REPO
npx wrangler secret put ADMIN_TOKEN      # any long random string
```
The Worker runs from the next minute (cron `* * * * *`). The very first poll of every news feed only *seeds* history, so a new install never floods your phone.

### Step 8: GitHub Actions secrets
Repo → Settings → Secrets and variables → **Actions** → New repository secret, one each: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CALLMEBOT_PHONE`, `CALLMEBOT_APIKEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Then open the **Actions** tab, enable workflows if asked, and run **calendar → Run workflow** once (fills the macro calendar). Optionally run **digest → Run workflow** with `kind = india`, `force = true` to receive a sample morning digest.

### Step 9: first test alert
Local test through the real channels (creates `.dev.vars` from the example, which is git-ignored):
```bash
cp .dev.vars.example .dev.vars      # fill in at least the CALLMEBOT_* and TELEGRAM_* lines
npm run test:alerts                 # one sample alert of each severity
```
Expect 4 WhatsApp messages (⚪ 🟡 🔴 🚨) and 2 Telegram messages (🔴 🚨, because HIGH and WORLD-ENDING always go to both). Or test the *deployed* Worker with its production secrets:
```bash
curl "https://market-alert-agent.<your-subdomain>.workers.dev/test?token=<ADMIN_TOKEN>"
```
`npm run test:alerts:dry` prints the messages without sending anything.

### Step 10: verify it is running
- `https://market-alert-agent.<your-subdomain>.workers.dev/health` → `{"ok":true,"lastRunAgoSec":…}`
- `…/probe?token=<ADMIN_TOKEN>` calls every price source once **from Cloudflare's network** and shows which work from there (e.g. whether NSE blocks cloud IPs).
- `npx wrangler tail` shows one JSON line per minute (`ok`, `ms`, `sub` = subrequests, `errs`).
- Supabase SQL editor: `select * from kv where key = 'heartbeat';`
- Dashboard → Workers → Metrics → **CPU time** (see the CPU note above).

### Step 11: tune
Edit **only** [`agent.config.ts`](agent.config.ts): watchlist, volatility, thresholds, cooldowns, feeds, fixed macro dates, digest times, health limits. `npm run thresholds` shows the resulting % table; [`sql/review-queries.sql`](sql/review-queries.sql) has 12 queries (alerts by severity/status, noisiest assets, suppression reasons, WhatsApp failure counts, failover list, news scoring, delivery latency, **per-source data lag**, health keys, upcoming macro events, table sizes). A weekly summary arrives on Sundays 09:00 IST.

### Try it without any accounts
```bash
npm install
npm run dry-run                   # live prices/news, in-memory DB, prints alerts instead of sending
npm run dry-run -- --ticks 5 --replay-news
npm test                          # 136 tests
npm run bench                     # CPU estimate for one Worker minute
```

## 6. What runs where

| Job | Where | Schedule |
|---|---|---|
| Prices, news, macro heads-up/results, crypto liquidations, health | Cloudflare Worker | every minute |
| Morning digest (India pre-open) incl. the daily "✅ Agent alive" line | GitHub `digest.yml` | 08:30 IST, weekdays |
| US pre-open digest | GitHub `digest.yml` | 08:30 ET; cron fires at both the EDT and EST UTC times and the script sends only when New York time is inside the window, so **daylight saving is handled** |
| Calendar refresh and DB prune | GitHub `calendar.yml` | daily 05:45 IST |
| Worker watchdog | GitHub `heartbeat.yml` | every 10 min |
| Weekly threshold review | GitHub `weekly-review.yml` | Sunday 09:00 IST |
| Repo keepalive | GitHub `keepalive.yml` | 1st and 15th |

**Safeguards for GitHub's weaknesses:** (1) a digest not logged 20 min after its time is **dispatched by the Worker via `workflow_dispatch`**; if still missing at +50 min you are told; (2) a daily commit-if-quiet `keepalive` prevents the 60-day auto-disable on public repos, and the Worker lists the workflows every 6 h and **re-enables any that GitHub disabled** (and tells you); (3) an empty calendar triggers a Worker-initiated refresh; (4) the heartbeat watchdog pings you on both channels if the Worker stops, reminds hourly, and announces recovery.

**Health alerts you will receive (⚙️ SYSTEM, both channels):** Worker not running; a data source or feed failing for N polls (and recovery); LLM quota exhausted / 85 % used (once a day); WhatsApp down/recovered; digest missing; workflow disabled and re-enabled; Supabase unreachable.

## 7. Repository layout

```
agent.config.ts          ← the one file you edit
wrangler.toml            ← Worker + cron (secrets listed in comments)
sql/schema.sql           ← tables, RLS, 3 functions     sql/review-queries.sql ← 12 review queries
src/core/                ← pure logic: thresholds, severity, cooldown, dedupe, keywords, news routing, macro, format
src/providers/           ← Yahoo, CNBC, NSE, Kraken, Coinbase, CoinGecko, OKX/Bybit, BLS, RSS parser, price orchestrator
src/llm/score.ts         ← provider chain, strict-JSON validation, prompt-injection hygiene, quota tracking
src/notify/              ← CallMeBot + Telegram, retry/backoff, merging, failover router, plain-text sender, sample alerts
src/db/                  ← Supabase (PostgREST RPC) and in-memory store
src/worker/              ← tick.ts (orchestrator), news, macro, cryptoSignals, github safeguards, health, index (cron + /health /test /probe)
src/digest/build.ts      ← digest text
scripts/                 ← digest, calendar-refresh, heartbeat, weekly-review, send-test, dry-run, thresholds, cpu-bench
.github/workflows/       ← digest, calendar, heartbeat, weekly-review, keepalive, ci
test/                    ← 136 tests (thresholds, cooldown, dedupe, routing, failover, LLM validation, DST windows, SQL on real Postgres, end-to-end ticks)
```

## 8. Known limitations and what it would cost to remove them

| Limitation | Why | What to pay for to remove it |
|---|---|---|
| **Worker CPU is close to the free 10 ms limit**, mainly on cold isolates | Parsing ~10 feeds + 48 KB of quotes per minute | Workers Paid (USD 5/month at time of writing; check) raises CPU to 30 s and subrequests to 10,000; or trim feeds for free |
| **Unofficial data APIs** (Yahoo spark, CNBC quotes, NSE, OKX/Bybit) can change format or block cloud IPs without notice | No free official real-time feed exists | A paid market-data API (price depends on the provider; check current plans) |
| **Indian index data may be delayed** (Yahoo historically ~15 min; live lag unmeasured because markets were closed) | Free feeds are not exchange-licensed | Licensed NSE/BSE real-time data (paid, exchange licensing applies). Measure first with query 9 |
| **Sensex and India VIX have a single reliable source** (Yahoo; NSE for India VIX if reachable) | BSE blocks bots, CNBC lacks them | Paid data feed |
| **Commodity futures and DXY are ~10 min delayed** at the free sources | Exchange delay rules | Real-time futures data (paid) |
| **CallMeBot is unofficial, personal-use, can be "full" for new activations (as on 2026-11-13; Telegram-only mode covers that), with no delivery receipts, one number, and undocumented limits**; it can break or throttle | It is a free community service | Official WhatsApp Business Cloud API via Meta or a provider such as Twilio (paid per conversation/message). Telegram already covers outages |
| **OKX liquidation feed unverified**: `www.okx.com` timed out from my network and the US/EEA hosts returned empty lists, so I could not confirm the payload shape; the Bybit open-interest proxy was verified | Region blocking | A paid liquidation-data API (e.g. Coinglass-type) for aggregated all-venue data |
| **Liquidations cover only OKX/Bybit**, not the whole market | Free feeds are per-venue | Aggregated paid data |
| **Macro actuals**: US CPI/core CPI/payrolls/unemployment/wages come from BLS (structured); everything else (PPI, GDP, retail sales, Fed/RBI/ECB decisions, India data) is **LLM-extracted from news** and may be missed ("result not auto-captured" message) or occasionally wrong | No free keyed-free calendar with actuals exists (ForexFactory's feed has forecast/previous only) | A paid economic-calendar API with actuals |
| **India CPI/GDP dates are approximate** (flagged "~date approx" in alerts); FOMC and RBI MPC dates are from the official pages as of today | Fixed list in `agent.config.ts` | Verify dates yourself each quarter; no cost |
| **Circuit breakers are inferred** from % move versus previous close, or from CNBC's halt flag | No free official halt feed | Exchange halt feeds (paid) |
| **LLM free tiers**: limits change without notice; Google no longer publishes Gemini limits; the free tier may use prompts to improve products (headlines are public, so low risk); keyword fallback is weaker | Free plans | Paid LLM tier. The agent degrades gracefully and tells you when quota is exhausted |
| **Supabase is a single point of failure** for state; free projects have no SLA and pause after a week without activity (per-minute writes prevent that) | Free plan | Supabase Pro |
| **GitHub scheduled runs can lag or be dropped** | GitHub's design | Mitigated by Worker re-dispatch; nothing to pay |
| **Single Cloudflare cron trigger and single region** | Free plan allows 5 triggers; one per minute is used | Not needed; the heartbeat covers outages |
| **No exchange-holiday calendar**: digests still send on market holidays; price triggers simply see stale data | Out of scope | n/a |
| Alerts are **informational, not investment advice**; direction hints are generic correlations | | |

## 9. Troubleshooting

- **No WhatsApp message, Telegram works:** re-do step 3; the activation reply must have arrived. Run `npm run test:alerts` and look at the printed table.
- **"Exceeded CPU" in `wrangler tail`:** increase `everyMin` for several feeds, or delete low-value feeds.
- **A source keeps failing:** you get a ⚙️ SYSTEM alert after 10 failed polls (6 for feeds). Use `/probe` to see what works from Cloudflare.
- **Digest did not arrive:** check Actions → digest, then `select * from kv where key = 'digest_last';`. The Worker re-dispatches it after 20 minutes.
- **Too many alerts:** run `npm run thresholds`, then raise `dailyVolPct` or `floorPct` for the noisy asset (review query 2), or lengthen `cooldownMin`.
- **Rotating a secret:** `npx wrangler secret put NAME` (Worker) and update the GitHub Actions secret.
