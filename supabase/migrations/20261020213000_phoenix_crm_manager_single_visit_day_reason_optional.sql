-- phoenix_crm_manager_single_visit_day_reason_optional
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_manager_single_visit_days.reason may be empty: the column drops NOT NULL, and its check
--      now holds only the length (1 to 500 characters) of a reason that was written.
--   2. phoenix_crm_raise_manager_single_visit_day no longer refuses an ask with no reason (note_required);
--      a reason over 500 characters is still refused. Nothing else in the function changes.
--
-- WHY (owner, 2026-10-20): "make writing why optional" — about the district manager's ask for a second or
--   third day of single visits (20261020210546). A refusal by his managers still needs a note; only the
--   ask's own reason becomes optional.
--
-- ROLLBACK: put the old check and NOT NULL back once no row holds a null reason, and re-run the raise
--   function from 20261020210546.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_manager_single_visit_days alter column reason drop not null;
alter table public.phoenix_crm_manager_single_visit_days drop constraint if exists phoenix_crm_manager_single_visit_days_reason;
alter table public.phoenix_crm_manager_single_visit_days
  add constraint phoenix_crm_manager_single_visit_days_reason check (reason is null or char_length(reason) between 1 and 500);

create or replace function public.phoenix_crm_raise_manager_single_visit_day(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_seat text := nullif(trim(coalesce(p ->> 'manager_seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'visit_date', '')::date;
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_row public.phoenix_crm_manager_single_visit_days%rowtype;
begin
  if v_manager is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- The reason is optional (owner, 2026-10-20: "make writing why optional"); only its length is held.
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;
  if v_approver = v_manager or v_second = v_manager or (v_second is not null and v_second = v_approver) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if extract(isodow from v_date) = 5 then
    raise exception 'phoenix_crm:single_visit_day_not_field';
  end if;
  if v_date < v_today then
    raise exception 'phoenix_crm:single_visit_day_passed';
  end if;
  -- This week or the coming one: the application names the exact weeks; this is the outer fence.
  if v_date > v_today + 13 then
    raise exception 'phoenix_crm:single_visit_day_too_far';
  end if;

  -- Saturday is isodow 6, so (isodow + 1) % 7 days back is the week's Saturday.
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);

  -- The week's own lock, the one every half-day save of his week takes.
  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  if exists (
    select 1 from public.phoenix_crm_manager_single_visit_days d
    where d.manager_hr_id = v_manager and d.visit_date = v_date and d.is_test = v_is_test
      and d.status in ('pending', 'first_approved', 'approved')
  ) then
    raise exception 'phoenix_crm:single_visit_day_already_asked';
  end if;
  -- The second and the third day: two asked or approved a week at most.
  if (
    select count(*) from public.phoenix_crm_manager_single_visit_days d
    where d.manager_hr_id = v_manager and d.week_start = v_week and d.is_test = v_is_test
      and d.status in ('pending', 'first_approved', 'approved')
  ) >= 2 then
    raise exception 'phoenix_crm:single_visit_days_full';
  end if;

  insert into public.phoenix_crm_manager_single_visit_days
    (manager_hr_id, manager_seat_id, week_start, visit_date, reason, status, approver_hr_id, second_approver_hr_id, is_test)
  values
    (v_manager, v_seat, v_week, v_date, v_reason, 'pending', v_approver, v_second, v_is_test)
  returning * into v_row;

  return jsonb_build_object(
    'request_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'week_start', v_row.week_start,
    'visit_date', v_row.visit_date,
    'approver_hr_id', v_row.approver_hr_id,
    'second_approver_hr_id', v_row.second_approver_hr_id,
    'status', v_row.status,
    'version', v_row.version,
    'is_test', v_row.is_test
  );
end;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_raise_manager_single_visit_day(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_manager_single_visit_day(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
