-- phoenix_crm_day_activities
--
-- WHAT THIS CHANGES:
--   1. One new table, public.phoenix_crm_day_activities — a working day that was not a call: a
--      meeting, training, a conference, admin work, travelling, a health day. One row per seat per
--      day, with an optional note and a half-day flag.
--   2. One new function, public.phoenix_crm_save_day_activity(p jsonb) — writes or clears it.
--
-- WHY (owner, 2026-09-26):
--   A rep at a training day currently looks, on every board, exactly like a rep who did nothing. He
--   asked for the day to be recordable, and ruled TWO things about it in the same breath:
--
--     * It is a RECORD ONLY. It changes no call rate, no coverage, no plan-against-actual. Taking a
--       day out of a denominator moves every rate on every manager's board, including for months
--       already reported, and that is its own decision on its own day. Nothing in this migration
--       reads or is read by any phoenix_crm_report_* function.
--     * LEAVE IS NOT HERE. Vacation, excuses and attendance are HR's, with their own approval and
--       their own evidence. A rep marking "leave" in the CRM would create a second truth that nothing
--       reconciles — and the one that pays him is the other one. `activity_type` has no leave value,
--       deliberately, and one must not be added without him saying so.
--
--   The vocabulary is PHOENIX'S OWN, not iReports360's numeric codes. The whole reason
--   `isFieldWorkVisit` exists in src/lib/crm/visit-types.ts is that the vendor jammed calls and day
--   activities into one table and they have to be pulled apart again afterwards. Here a visit is
--   always a call and a day activity is its own row, so nothing ever needs pulling apart.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_save_day_activity(jsonb);
--   drop table if exists public.phoenix_crm_day_activities;
--
-- Verification after apply:
--   select count(*) from public.phoenix_crm_day_activities;                        -- 0
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_day_activities';  -- t
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_day_activity';     -- t

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_day_activities (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text,
  rep_hr_id text,
  entered_by_hr_id text not null,
  activity_date date not null,
  -- Phoenix's own vocabulary. No 'leave' value, by the owner's ruling: HR owns leave.
  activity_type text not null,
  half_day boolean not null default false,
  note text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_day_activities_type
    check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day')),
  constraint phoenix_crm_day_activities_note check (note is null or char_length(note) <= 500),
  constraint phoenix_crm_day_activities_one_a_day unique (seat_id, activity_date, is_test)
);

comment on table public.phoenix_crm_day_activities is
  'A working day that was not a call (owner, 2026-09-26). A RECORD ONLY: it changes no call rate, no coverage and no plan-against-actual. Leave is deliberately absent — HR''s vacation module is the only leave record.';
comment on column public.phoenix_crm_day_activities.half_day is
  'He was in the field for part of the day. The visits he entered stand on their own; this does not scale anything.';

create index if not exists phoenix_crm_day_activities_seat_idx
  on public.phoenix_crm_day_activities (seat_id, activity_date desc);

alter table public.phoenix_crm_day_activities enable row level security;
create policy phoenix_crm_day_activities_service_role
  on public.phoenix_crm_day_activities for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_day_activities from public, anon, authenticated;
grant all on table public.phoenix_crm_day_activities to service_role;

-- ── Writing one ─────────────────────────────────────────────────────────────────────────────────
--
-- One row per seat per day, so saving twice REPLACES rather than piles up: a rep who files "training"
-- and then realises it was a conference changes it, and there is no history to keep because nothing
-- downstream reads this yet. Clearing it is the same call with no activity_type.
--
-- The day is the CALLER'S, already resolved in Africa/Cairo — `current_date` is forbidden in this
-- repo's migrations for exactly the reason it would be wrong here: the server runs in UTC.
create or replace function public.phoenix_crm_save_day_activity(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(btrim(p ->> 'seat_id'), '');
  v_line text := nullif(btrim(p ->> 'line_code'), '');
  v_rep text := nullif(btrim(p ->> 'rep_hr_id'), '');
  v_actor text := nullif(btrim(p ->> 'actor_hr_id'), '');
  v_date date := nullif(p ->> 'activity_date', '')::date;
  v_type text := nullif(btrim(p ->> 'activity_type'), '');
  v_half boolean := coalesce((p ->> 'half_day')::boolean, false);
  v_note text := nullif(btrim(p ->> 'note'), '');
  v_row public.phoenix_crm_day_activities%rowtype;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
begin
  if v_seat is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:day_activity:' || v_seat || ':' || v_date::text));

  if v_type is null then
    delete from public.phoenix_crm_day_activities
    where seat_id = v_seat and activity_date = v_date and is_test = v_is_test;
    return jsonb_build_object('cleared', true);
  end if;

  if v_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  insert into public.phoenix_crm_day_activities (
    seat_id, line_code, rep_hr_id, entered_by_hr_id, activity_date, activity_type, half_day, note, is_test
  )
  values (v_seat, v_line, v_rep, v_actor, v_date, v_type, v_half, v_note, v_is_test)
  on conflict (seat_id, activity_date, is_test) do update
    set activity_type = excluded.activity_type,
        half_day = excluded.half_day,
        note = excluded.note,
        entered_by_hr_id = excluded.entered_by_hr_id,
        line_code = excluded.line_code,
        rep_hr_id = excluded.rep_hr_id,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'cleared', false,
    'id', v_row.id,
    'activity_date', v_row.activity_date,
    'activity_type', v_row.activity_type,
    'half_day', v_row.half_day,
    'note', v_row.note
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_day_activity(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_day_activity(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
