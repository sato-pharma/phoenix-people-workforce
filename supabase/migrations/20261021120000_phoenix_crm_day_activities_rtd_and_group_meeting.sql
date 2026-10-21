-- phoenix_crm_day_activities_rtd_and_group_meeting
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_day_activities.activity_type admits two more kinds: 'rtd' and 'group_meeting'.
--   2. phoenix_crm_save_day_activity accepts them. Nothing else in the function changes.
--
-- WHY (owner, 2026-10-21): "in this screen add also RTD & Group meeting" - the rep's Record the day screen.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE: the plan's own checks (phoenix_crm_plan_activities, the manager
--   plan) still admit the original seven, and the iReports360 doors (crm_visits_unified) name no worked-day
--   code for these two, so they stay a RECORD ONLY and move no call rate, coverage or attendance figure.
--
-- ROLLBACK: delete or re-file any 'rtd' / 'group_meeting' rows, restore the check from
--   20260929235553 and re-run that file's phoenix_crm_save_day_activity.

begin;
set local lock_timeout = '5s';

-- SAFE: widening a CHECK to admit two more values; every existing row already satisfies the new form.
alter table public.phoenix_crm_day_activities drop constraint if exists phoenix_crm_day_activities_type;
alter table public.phoenix_crm_day_activities
  add constraint phoenix_crm_day_activities_type
  check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting'));

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

  if v_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'rtd', 'group_meeting') then
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

commit;
