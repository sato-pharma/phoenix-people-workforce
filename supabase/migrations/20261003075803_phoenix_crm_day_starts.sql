-- WHAT: `phoenix_crm_day_starts` — one row per rep per visit day, written when he presses
--       "Show your manager you started working", plus `phoenix_crm_start_day` to write it.
--
-- WHY:  Owner, 2026-10-03: *"I WANT TO MAKE AN FEATURE FOR MEDICAL REPS TO CONFIRM THEY STARTED
--       THEIR WORK BEC AS U KNOW THE VISIT IS ENTERED AFTER IT IS DONE SO I WANT TO KNOW WHEN
--       ACTUALLY DID THEY START WORKING"* — a visit is logged after it happened, so the first
--       visit's `captured_at` is the end of the first call, never the start of the day. The button
--       is shown ONLY before his first AM visit, and he presses it before that visit, not after.
--       He then ruled: *"WHEN THEY PRESS THE BUTTON THEIR LOCATION AND THEIR TIME SEND TO MANAGERS
--       AND SAVED IN SYSTEM"* — so the reading is NOT one of the module's silent integrity signals:
--       it is sent to his district manager and the SFE Manager and kept here, and the button says so
--       in words, because a rep is never told something about him travels where he cannot see it.
--
--       The plan already stores the hour he INTENDED to start (`phoenix_crm_plan_day_starts`
--       .start_am_minute), so this row is the other half of that pair: planned start vs actual.
--
-- ROLLBACK: `drop function if exists public.phoenix_crm_start_day(jsonb);`
--           `drop table if exists public.phoenix_crm_day_starts;`
--           Both are additive and reversible — nothing existing is altered, and no row outside this
--           new table is written, so dropping them restores the previous state exactly.

begin;

-- At most five seconds waiting for any lock: a migration must never hold the module's tables
-- while reps are logging visits.
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_day_starts (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text,
  rep_hr_id text not null,
  -- The VISIT day (02:00 Cairo cut-off), never the calendar date: the day a 01:30 press belongs to
  -- is the one that is ending, exactly as `phoenix_crm_save_visit` files a visit.
  started_on date not null,
  -- The SERVER's clock. The phone's is never trusted for the one figure the whole feature exists for.
  started_at timestamptz not null default now(),
  lat double precision,
  lon double precision,
  accuracy_meters numeric(8, 1),
  -- What the plan said he would start his morning at, snapshotted at the press so a later plan edit
  -- cannot rewrite how punctual he looks. Null when he had no sent plan for the day.
  planned_am_minute integer,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);

-- One press per rep per day, per world. The uniqueness is what makes the RPC idempotent: a second
-- press, a double tap or a retried request answers with the row already there instead of a second
-- start time, and "when did he start" therefore has exactly one answer.
create unique index if not exists phoenix_crm_day_starts_seat_day_idx
  on public.phoenix_crm_day_starts (seat_id, started_on, is_test);

create index if not exists phoenix_crm_day_starts_rep_idx
  on public.phoenix_crm_day_starts (rep_hr_id, started_on desc);

comment on table public.phoenix_crm_day_starts is
  'When a medical rep confirmed he started working, with where he was. Owner ruling 2026-10-03: shown only before his first AM visit, and sent to his district manager and the SFE Manager.';

-- Visibility in this app is application-scoped: every read goes through the service-role client, so
-- RLS here is the belt rather than the braces. It is enabled with NO policy, which is the module's
-- own shape for a table the browser must never reach directly (phoenix_crm_location_integrity).
alter table public.phoenix_crm_day_starts enable row level security;

create policy phoenix_crm_day_starts_service_role
  on public.phoenix_crm_day_starts for all to service_role using (true) with check (true);

revoke all on table public.phoenix_crm_day_starts from public, anon, authenticated;
grant all on table public.phoenix_crm_day_starts to service_role;

/**
 * Record the start of a rep's working day, once.
 *
 * Idempotent by the unique index: a second call on the same seat, day and world returns the row that
 * is already there, with `created` false, so a retried request after a dropped connection can never
 * move the start time he is judged by. The caller decides who may press — the RPC is service-role
 * only and trusts the seat it is handed, exactly like `phoenix_crm_save_visit`.
 */
create or replace function public.phoenix_crm_start_day(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(p ->> 'seat_id'), '');
  v_line text := nullif(trim(p ->> 'line_code'), '');
  v_rep text := nullif(trim(p ->> 'rep_hr_id'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_lat double precision := nullif(p ->> 'lat', '')::double precision;
  v_lon double precision := nullif(p ->> 'lon', '')::double precision;
  v_accuracy numeric(8, 1) := nullif(p ->> 'accuracy_meters', '')::numeric(8, 1);
  v_planned integer := nullif(p ->> 'planned_am_minute', '')::integer;
  -- The visit day: the Cairo date of (now - 2 hours), the module's one definition of "today".
  v_today date := ((now() at time zone 'Africa/Cairo') - interval '2 hours')::date;
  v_row public.phoenix_crm_day_starts;
  v_created boolean := false;
begin
  if v_seat is null or v_rep is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- One writer per seat and day, so two taps landing together cannot both insert.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:day_start:' || v_seat || ':' || v_today::text));

  select * into v_row
  from public.phoenix_crm_day_starts
  where seat_id = v_seat and started_on = v_today and is_test = v_is_test;

  if not found then
    insert into public.phoenix_crm_day_starts
      (seat_id, line_code, rep_hr_id, started_on, lat, lon, accuracy_meters, planned_am_minute, is_test)
    values
      (v_seat, v_line, v_rep, v_today, v_lat, v_lon, v_accuracy, v_planned, v_is_test)
    returning * into v_row;
    v_created := true;
  end if;

  return jsonb_build_object('created', v_created, 'day_start', to_jsonb(v_row));
end;
$$;

-- anon and authenticated inherit EXECUTE through PUBLIC, so revoking only those two is a no-op and
-- the function would stay callable with the key that ships in the browser bundle.
revoke execute on function public.phoenix_crm_start_day(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_start_day(jsonb) to service_role;

-- Without this the new RPC is invisible to PostgREST until a restart, and the first press would
-- answer PGRST202 rather than saving.
notify pgrst, 'reload schema';

commit;
