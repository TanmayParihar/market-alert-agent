-- Review queries: paste into the Supabase SQL editor to tune thresholds. (All times shown in IST.)

-- 1) What did I get in the last 7 days, by severity and what happened to it?
select severity, status, count(*) as n
  from alerts where created_at > now() - interval '7 days' and kind <> 'test'
 group by 1, 2 order by array_position(array['WORLD_ENDING','HIGH','MEDIUM','LOW'], severity), 2;

-- 2) Noisiest assets (instant alerts actually sent) - candidates for higher thresholds in agent.config.ts
select unnest(asset_ids) as asset, severity, count(*) as sent
  from alerts where status = 'sent' and kind in ('price','vol','crypto') and created_at > now() - interval '30 days'
 group by 1, 2 order by sent desc limit 20;

-- 3) How often is the cooldown doing its job? (suppressed alerts and why)
select reason, count(*) as n
  from alerts where status = 'suppressed' and created_at > now() - interval '7 days'
 group by 1 order by n desc;

-- 4) Latest 40 alerts with delivery detail (IST)
select to_char(created_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') as ist,
       severity, kind, status, channels, left(headline, 70) as headline, reason
  from alerts order by created_at desc limit 40;

-- 5) WhatsApp reliability: delivery attempts that failed, per day
select date_trunc('day', created_at at time zone 'Asia/Kolkata')::date as day,
       count(*) filter (where d->>'channel' = 'whatsapp' and (d->>'ok')::boolean = false) as wa_failed_attempts,
       count(*) filter (where d->>'channel' = 'whatsapp' and (d->>'ok')::boolean = true)  as wa_ok_attempts,
       count(*) filter (where d->>'channel' = 'telegram') as telegram_attempts
  from alerts, jsonb_array_elements(delivery) d
 where created_at > now() - interval '14 days'
 group by 1 order by 1 desc;

-- 6) Alerts that needed Telegram failover
select to_char(created_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') as ist, severity, left(headline, 60) as headline, channels
  from alerts where 'telegram' = any(channels) and not 'whatsapp' = any(channels) order by created_at desc limit 30;

-- 7) News: what did the model call market-moving vs not (is the scorer too eager?)
select scorer, severity, count(*) as n
  from news_items where created_at > now() - interval '3 days'
 group by 1, 2 order by 1, 3 desc;

-- 8) Alert latency: seconds between the source's own timestamp and delivery (price alerts use the data timestamp)
select kind, severity,
       round(avg(extract(epoch from (sent_at - source_time)))::numeric, 0) as avg_sec,
       round(percentile_cont(0.9) within group (order by extract(epoch from (sent_at - source_time)))::numeric, 0) as p90_sec,
       count(*) as n
  from alerts where status = 'sent' and sent_at is not null and source_time is not null and created_at > now() - interval '14 days'
 group by 1, 2 order by 1, 2;

-- 9) How fresh is each source? Data time vs wall clock per asset (run while the relevant market is OPEN).
--    Use this to see whether Indian index data (Yahoo / CNBC / NSE) is delayed, and by how many minutes.
select asset_id, source, to_char(to_timestamp(last_ts) at time zone 'Asia/Kolkata', 'HH24:MI:SS') as data_time_ist,
       to_char(updated_at at time zone 'Asia/Kolkata', 'HH24:MI:SS') as checked_ist,
       round((extract(epoch from updated_at) - last_ts) / 60.0, 1) as lag_minutes
  from asset_state order by lag_minutes desc;

-- 10) Agent health: heartbeat, WhatsApp state, source health, LLM usage
select key, value, to_char(updated_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI:SS') as updated_ist
  from kv where key in ('heartbeat', 'wa_state', 'src_health', 'llm', 'digest_last', 'gh_check') order by key;

-- 11) Upcoming macro events (next 7 days, IST)
select to_char(event_time at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') as ist, country, title, impact, forecast, previous, status, watch, approx
  from macro_events where event_time between now() and now() + interval '7 days' order by event_time;

-- 12) Table sizes (stay far under the 500 MB free limit)
select relname as table, pg_size_pretty(pg_total_relation_size(relid)) as size
  from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc;
