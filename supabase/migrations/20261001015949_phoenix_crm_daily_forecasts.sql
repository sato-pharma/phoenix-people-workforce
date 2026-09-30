-- phoenix_crm_daily_forecasts
--
-- WHAT THIS CHANGES:
--   1. One new table, public.phoenix_crm_daily_forecasts — the boxes a CNS rep expects to sell today,
--      one row per territory per day per product, with the pre-filled figure he was offered beside
--      the one he sent.
--   2. One new function, public.phoenix_crm_save_daily_forecast(p jsonb) — sends (or re-sends) a
--      day's forecast, replacing that day's lines and keeping the FIRST send's time.
--
-- WHY (owner, 2026-10-01: "build the daily forecast module in Phoenix ONLY FOR CNS LINE"):
--   The CNS reps typed a "Daily forecast" into the line's WhatsApp group — seven lines by hand, on a
--   template copied between regions with the numbers barely changed. Phoenix now pre-fills each
--   product with the rep's daily share of the month's target, he changes what he disagrees with and
--   sends, and his managers read who sent and, once a month is published, how delivery compared.
--
--   CNS ONLY, and the database says so itself: the table's CHECK and the function both refuse any
--   other line, so a screen or a route that forgot the rule still cannot write a Pedia forecast.
--
--   A second send the same day REPLACES the boxes (he corrected a figure) but keeps created_at of the
--   first send, because "who sent by 10 o'clock" is what the board is read for and a later correction
--   must not make an early sender look late.
--
--   The day is the CALLER'S, already resolved in Africa/Cairo (the visit day) — current_date is the
--   database's UTC day and is forbidden in this module's migrations.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_save_daily_forecast(jsonb);
--   drop table if exists public.phoenix_crm_daily_forecasts;
--   (Nothing else reads the table. Dropping it loses the forecasts sent since it went live.)
--
-- Verification after apply:
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_daily_forecasts';      -- t
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_daily_forecast';         -- t
--   select has_function_privilege('anon', 'public.phoenix_crm_save_daily_forecast(jsonb)', 'execute');  -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: one new table and one new function, no existing row touched.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_daily_forecasts (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text not null,
  area_code text,
  rep_hr_id text,
  entered_by_hr_id text not null,
  forecast_date date not null,
  product_code text not null,
  units integer not null,
  -- The pre-filled figure he was offered (the month's target units ÷ its working days), recomputed by
  -- the server at send time and never taken from the screen. Null when the product had no target.
  suggested_units integer,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_daily_forecasts_cns_only check (line_code = 'cns'),
  constraint phoenix_crm_daily_forecasts_units check (units between 0 and 5000),
  constraint phoenix_crm_daily_forecasts_suggested check (suggested_units is null or suggested_units >= 0),
  constraint phoenix_crm_daily_forecasts_one_a_product unique (seat_id, forecast_date, product_code, is_test)
);

comment on table public.phoenix_crm_daily_forecasts is
  'The CNS daily forecast (owner, 2026-10-01): the boxes a rep expects to sell today, per product. CNS only. A re-send replaces the day''s lines and keeps the first send''s created_at.';
comment on column public.phoenix_crm_daily_forecasts.suggested_units is
  'The pre-filled figure offered to the rep: the month''s target units for this product and area, divided by the month''s working days (Saturday to Wednesday, less national holidays). Recomputed by the server, never taken from the screen.';

create index if not exists phoenix_crm_daily_forecasts_seat_idx
  on public.phoenix_crm_daily_forecasts (seat_id, forecast_date desc);
create index if not exists phoenix_crm_daily_forecasts_day_idx
  on public.phoenix_crm_daily_forecasts (forecast_date, is_test);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role (a member of it), so the grant that follows is mandatory. The
-- `drop policy if exists` keeps the file replayable.
alter table public.phoenix_crm_daily_forecasts enable row level security;
drop policy if exists phoenix_crm_daily_forecasts_service_role on public.phoenix_crm_daily_forecasts;
create policy phoenix_crm_daily_forecasts_service_role
  on public.phoenix_crm_daily_forecasts for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_daily_forecasts from public, anon, authenticated;
grant all on table public.phoenix_crm_daily_forecasts to service_role;

-- ── Sending one ─────────────────────────────────────────────────────────────────────────────────
--
-- p: seat_id, line_code, area_code, rep_hr_id, actor_hr_id, forecast_date, is_test,
--    lines: [{ product_code, units, suggested_units }]
create or replace function public.phoenix_crm_save_daily_forecast(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(btrim(p ->> 'seat_id'), '');
  v_line text := lower(nullif(btrim(p ->> 'line_code'), ''));
  v_area text := nullif(btrim(p ->> 'area_code'), '');
  v_rep text := nullif(btrim(p ->> 'rep_hr_id'), '');
  v_actor text := nullif(btrim(p ->> 'actor_hr_id'), '');
  v_date date := nullif(p ->> 'forecast_date', '')::date;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_lines jsonb := p -> 'lines';
  v_line_item jsonb;
  v_product text;
  v_units integer;
  v_suggested integer;
  v_first timestamptz;
  v_count integer := 0;
begin
  if v_seat is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_line is distinct from 'cns' then
    raise exception 'phoenix_crm:not_forecast_line';
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 or jsonb_array_length(v_lines) > 50 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- One line per product: a duplicate is the screen's bug, refused here rather than half-saved.
  if (select count(distinct upper(btrim(item ->> 'product_code'))) from jsonb_array_elements(v_lines) item) <> jsonb_array_length(v_lines) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:daily_forecast:' || v_seat || ':' || v_date::text));

  select min(created_at) into v_first
  from public.phoenix_crm_daily_forecasts
  where seat_id = v_seat and forecast_date = v_date and is_test = v_is_test;

  delete from public.phoenix_crm_daily_forecasts
  where seat_id = v_seat and forecast_date = v_date and is_test = v_is_test;

  for v_line_item in select value from jsonb_array_elements(v_lines)
  loop
    v_product := upper(nullif(btrim(v_line_item ->> 'product_code'), ''));
    if v_product is null then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if jsonb_typeof(v_line_item -> 'units') <> 'number' then
      raise exception 'phoenix_crm:bad_input';
    end if;
    v_units := (v_line_item ->> 'units')::integer;
    if v_units < 0 or v_units > 5000 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    v_suggested := case
      when jsonb_typeof(v_line_item -> 'suggested_units') = 'number' then greatest(0, (v_line_item ->> 'suggested_units')::integer)
      else null
    end;

    insert into public.phoenix_crm_daily_forecasts (
      seat_id, line_code, area_code, rep_hr_id, entered_by_hr_id, forecast_date,
      product_code, units, suggested_units, is_test, created_at, updated_at
    )
    values (
      v_seat, v_line, v_area, v_rep, v_actor, v_date,
      v_product, v_units, v_suggested, v_is_test, coalesce(v_first, now()), now()
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'saved', v_count,
    'first_sent_at', coalesce(v_first, now()),
    'forecast_date', v_date
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_daily_forecast(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_daily_forecast(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
