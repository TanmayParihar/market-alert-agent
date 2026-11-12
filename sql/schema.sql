-- Market-alert agent: Supabase (Postgres) schema.
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> paste -> Run). Safe to re-run.
--
-- Security model: every table has Row Level Security ON and NO policies, so the public anon/publishable key can read
-- and write nothing. Only the service-role / secret key (which bypasses RLS) used by the Worker and GitHub Actions can.

create table if not exists public.alerts (
  id            uuid primary key,
  created_at    timestamptz not null default now(),
  dedupe_key    text not null unique,
  kind          text not null check (kind in ('price','vol','news','macro','crypto','system','digest','test')),
  severity      text not null check (severity in ('LOW','MEDIUM','HIGH','WORLD_ENDING')),
  status        text not null check (status in ('pending','sent','failed','digest_pending','digested','suppressed')),
  reason        text,                                   -- why suppressed / digested / failed
  headline      text not null,
  what          text,
  impact        text,
  source        text,
  source_time   timestamptz,
  asset_ids     text[] not null default '{}',
  payload       jsonb not null default '{}',
  channels      text[] not null default '{}',           -- channels that accepted it: whatsapp / telegram
  delivery      jsonb not null default '[]',            -- every attempt incl. failures
  attempts      int not null default 0,
  sent_at       timestamptz,
  digested_at   timestamptz
);
create index if not exists alerts_pending_idx on public.alerts (status) where status in ('pending','digest_pending');
create index if not exists alerts_created_idx on public.alerts (created_at desc);
create index if not exists alerts_kind_sev_idx on public.alerts (kind, severity, created_at desc);

create table if not exists public.asset_state (
  asset_id    text primary key,
  last_price  double precision,
  prev_close  double precision,
  last_ts     bigint,
  source      text,
  ring        jsonb not null default '[]',              -- [[epochSec, price], ...] ~75 min of history
  last_alert  jsonb,                                    -- {severity, at, pct, window}: drives cooldown/escalation
  updated_at  timestamptz not null default now()
);

create table if not exists public.feed_state (
  feed_id     text primary key,
  seen        jsonb not null default '[]',              -- last item ids seen (bounded by the Worker)
  last_ok     timestamptz,
  last_err    text,
  fails       int not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists public.news_items (
  id               text primary key,
  created_at       timestamptz not null default now(),
  published_at     timestamptz,
  source           text not null,
  feed_id          text not null,
  title            text not null,
  title_norm       text not null,
  url              text,
  cluster_id       text not null,
  is_market_moving boolean not null default false,
  severity         text not null default 'NONE',
  scorer           text not null default 'none',        -- model name, 'keywords' or 'prefilter'
  score            jsonb not null default '{}'
);
create index if not exists news_created_idx on public.news_items (created_at desc);
create index if not exists news_cluster_idx on public.news_items (cluster_id);

create table if not exists public.macro_events (
  id            text primary key,
  source        text not null,                          -- 'faireconomy' | 'config'
  title         text not null,
  country       text not null,
  impact        text not null,
  event_time    timestamptz not null,
  forecast      text,
  previous      text,
  actual        text,
  status        text not null default 'scheduled' check (status in ('scheduled','headsup_sent','result_sent','result_missed','cancelled')),
  watch         boolean not null default false,         -- true = heads-up + result alerts
  approx        boolean not null default false,
  resolver      jsonb,
  attempts      int not null default 0,
  meta          jsonb not null default '{}',
  updated_at    timestamptz not null default now()
);
create index if not exists macro_time_idx on public.macro_events (event_time);

create table if not exists public.kv (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.alerts        enable row level security;
alter table public.asset_state   enable row level security;
alter table public.feed_state    enable row level security;
alter table public.news_items    enable row level security;
alter table public.macro_events  enable row level security;
alter table public.kv            enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- One round-trip read for the whole per-minute tick (keeps Worker subrequests low).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.agent_tick_state(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare result jsonb;
begin
  -- undeliverable for 6 h: stop retrying, keep the row for the history
  update public.alerts set status = 'failed', reason = coalesce(reason, 'expired undelivered after 6h')
   where status = 'pending' and created_at < p_now - interval '6 hours';

  select jsonb_build_object(
    'assets', coalesce((select jsonb_agg(to_jsonb(a)) from public.asset_state a), '[]'::jsonb),
    'feeds',  coalesce((select jsonb_agg(to_jsonb(f)) from public.feed_state f), '[]'::jsonb),
    'kv',     coalesce((select jsonb_object_agg(k.key, k.value) from public.kv k), '{}'::jsonb),
    'pending', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at) from (
          select id, dedupe_key, kind, severity, headline, what, impact, source, source_time, asset_ids, payload, attempts, delivery, created_at
            from public.alerts where status = 'pending' order by created_at limit 30) x), '[]'::jsonb),
    'events', coalesce((
        select jsonb_agg(to_jsonb(e)) from public.macro_events e
         where e.status in ('scheduled','headsup_sent')
           and e.event_time between p_now - interval '45 minutes' and p_now + interval '75 minutes'), '[]'::jsonb),
    'event_count_48h', (select count(*) from public.macro_events where event_time between p_now and p_now + interval '48 hours')
  ) into result;
  return result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Single transactional write used by the Worker and the GitHub scripts. p is a JSON object with optional arrays:
--   assets, feeds, news_items, alerts_insert, alerts_update, events, events_upsert, kv (object)
-- Returns {"inserted":[alert ids that were NEW]} so the caller never delivers a duplicate (dedupe_key is unique).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.agent_apply(p jsonb)
returns jsonb language plpgsql as $$
declare inserted uuid[] := '{}';
begin
  insert into public.asset_state (asset_id, last_price, prev_close, last_ts, source, ring, last_alert, updated_at)
  select x->>'asset_id', (x->>'last_price')::float8, (x->>'prev_close')::float8, (x->>'last_ts')::bigint, x->>'source',
         coalesce(x->'ring', '[]'::jsonb), case when jsonb_typeof(x->'last_alert') = 'object' then x->'last_alert' else null end, now()
    from jsonb_array_elements(coalesce(p->'assets', '[]'::jsonb)) x
  on conflict (asset_id) do update set
    last_price = excluded.last_price, prev_close = excluded.prev_close, last_ts = excluded.last_ts, source = excluded.source,
    ring = excluded.ring, last_alert = excluded.last_alert, updated_at = now();

  insert into public.feed_state (feed_id, seen, last_ok, last_err, fails, updated_at)
  select x->>'feed_id', coalesce(x->'seen', '[]'::jsonb), (x->>'last_ok')::timestamptz, x->>'last_err', coalesce((x->>'fails')::int, 0), now()
    from jsonb_array_elements(coalesce(p->'feeds', '[]'::jsonb)) x
  on conflict (feed_id) do update set
    seen = excluded.seen, last_ok = excluded.last_ok, last_err = excluded.last_err, fails = excluded.fails, updated_at = now();

  insert into public.news_items (id, published_at, source, feed_id, title, title_norm, url, cluster_id, is_market_moving, severity, scorer, score)
  select x->>'id', (x->>'published_at')::timestamptz, x->>'source', x->>'feed_id', x->>'title', x->>'title_norm', x->>'url',
         x->>'cluster_id', coalesce((x->>'is_market_moving')::boolean, false), coalesce(x->>'severity', 'NONE'),
         coalesce(x->>'scorer', 'none'), coalesce(x->'score', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p->'news_items', '[]'::jsonb)) x
  on conflict (id) do nothing;

  with ins as (
    insert into public.alerts (id, dedupe_key, kind, severity, status, reason, headline, what, impact, source, source_time, asset_ids, payload)
    select (x->>'id')::uuid, x->>'dedupe_key', x->>'kind', x->>'severity', x->>'status', x->>'reason', x->>'headline', x->>'what',
           x->>'impact', x->>'source', (x->>'source_time')::timestamptz,
           coalesce(array(select jsonb_array_elements_text(coalesce(x->'asset_ids', '[]'::jsonb))), '{}'),
           coalesce(x->'payload', '{}'::jsonb)
      from jsonb_array_elements(coalesce(p->'alerts_insert', '[]'::jsonb)) x
    on conflict (dedupe_key) do nothing
    returning id)
  select coalesce(array_agg(id), '{}') into inserted from ins;

  update public.alerts a set
    status      = u->>'status',
    reason      = coalesce(u->>'reason', a.reason),
    channels    = case when u ? 'channels' then array(select jsonb_array_elements_text(u->'channels')) else a.channels end,
    delivery    = case when u ? 'delivery' then a.delivery || (u->'delivery') else a.delivery end,
    attempts    = a.attempts + coalesce((u->>'attempts_inc')::int, 0),
    sent_at     = coalesce((u->>'sent_at')::timestamptz, a.sent_at),
    digested_at = coalesce((u->>'digested_at')::timestamptz, a.digested_at)
   from jsonb_array_elements(coalesce(p->'alerts_update', '[]'::jsonb)) u
  where a.id = (u->>'id')::uuid;

  insert into public.macro_events (id, source, title, country, impact, event_time, forecast, previous, actual, status, watch, approx, resolver, attempts, meta, updated_at)
  select x->>'id', x->>'source', x->>'title', x->>'country', x->>'impact', (x->>'event_time')::timestamptz, x->>'forecast', x->>'previous',
         x->>'actual', coalesce(x->>'status', 'scheduled'), coalesce((x->>'watch')::boolean, false), coalesce((x->>'approx')::boolean, false),
         case when jsonb_typeof(x->'resolver') = 'object' then x->'resolver' else null end, coalesce((x->>'attempts')::int, 0),
         coalesce(x->'meta', '{}'::jsonb), now()
    from jsonb_array_elements(coalesce(p->'events_upsert', '[]'::jsonb)) x
  on conflict (id) do update set
    title = excluded.title, impact = excluded.impact, event_time = excluded.event_time, forecast = excluded.forecast, previous = excluded.previous,
    watch = excluded.watch, approx = excluded.approx, resolver = excluded.resolver, updated_at = now();
    -- note: actual / status / attempts are deliberately NOT overwritten by a calendar refresh

  update public.macro_events m set
    actual   = coalesce(u->>'actual', m.actual),
    status   = coalesce(u->>'status', m.status),
    attempts = coalesce((u->>'attempts')::int, m.attempts),
    updated_at = now()
   from jsonb_array_elements(coalesce(p->'events', '[]'::jsonb)) u
  where m.id = u->>'id';

  insert into public.kv (key, value, updated_at)
  select e.key, e.value, now() from jsonb_each(coalesce(p->'kv', '{}'::jsonb)) e
  on conflict (key) do update set value = excluded.value, updated_at = now();

  return jsonb_build_object('inserted', to_jsonb(inserted));
end $$;

-- Housekeeping (the daily GitHub workflow calls this): keeps the free 500 MB database tiny.
create or replace function public.agent_prune()
returns jsonb language plpgsql as $$
declare n1 int; n2 int; n3 int;
begin
  delete from public.news_items where created_at < now() - interval '3 days';             get diagnostics n1 = row_count;
  delete from public.macro_events where event_time < now() - interval '30 days';           get diagnostics n2 = row_count;
  delete from public.alerts where created_at < now() - interval '400 days';                get diagnostics n3 = row_count;
  return jsonb_build_object('news_items', n1, 'macro_events', n2, 'alerts', n3);
end $$;

-- Lock the functions to the service role (skipped automatically on a plain Postgres without Supabase roles).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.agent_tick_state(timestamptz) from public, anon, authenticated;
    revoke all on function public.agent_apply(jsonb) from public, anon, authenticated;
    revoke all on function public.agent_prune() from public, anon, authenticated;
    grant execute on function public.agent_tick_state(timestamptz) to service_role;
    grant execute on function public.agent_apply(jsonb) to service_role;
    grant execute on function public.agent_prune() to service_role;
  end if;
end $$;
