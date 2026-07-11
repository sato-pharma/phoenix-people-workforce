-- 20260620010000_weekly_plans_atomic_item_replace.sql
--
-- Hardens Weekly / Monthly Plans item writes. The original state-transition
-- RPCs locked the header, but create/update still deleted and reinserted item
-- rows before calling the submit RPC. This function replaces plan items and,
-- optionally, submits the plan inside the same transaction under the same
-- employee_plan_headers row lock.

begin;

create or replace function public.phx_weekly_plan_replace_items(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text,
  p_items jsonb,
  p_submit boolean default false
)
returns table (new_status text, new_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
  current_revision integer;
  header_period_start date;
  header_period_end date;
  item_row jsonb;
  item_activity_date_text text;
  item_activity_date date;
  item_sort_order integer;
  next_status text;
  now_ts timestamptz := now();
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'weekly_plan_invalid_transition: plan items payload must be a JSON array' using errcode = 'P0001';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'weekly_plan_invalid_transition: plan must include at least one item' using errcode = 'P0001';
  end if;

  select status, revision, period_start_date, period_end_date
    into current_status, current_revision, header_period_start, header_period_end
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  if current_status not in ('draft', 'manager_returned', 'ceo_returned') then
    raise exception 'weekly_plan_invalid_transition: items cannot be replaced from status ''%''', current_status using errcode = 'P0001';
  end if;

  delete from public.employee_plan_items
    where plan_id = p_plan_id;

  for item_row in select * from jsonb_array_elements(p_items)
  loop
    item_activity_date_text := btrim(coalesce(item_row->>'activityDate', ''));

    if item_activity_date_text !~ '^\d{4}-\d{2}-\d{2}$'
       or to_char(to_date(item_activity_date_text, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> item_activity_date_text then
      raise exception 'weekly_plan_invalid_transition: item activityDate must be a valid YYYY-MM-DD date' using errcode = 'P0001';
    end if;

    item_activity_date := to_date(item_activity_date_text, 'YYYY-MM-DD');

    if item_activity_date < header_period_start or item_activity_date > header_period_end then
      raise exception 'weekly_plan_invalid_transition: item activityDate % is outside plan period % to %',
        item_activity_date_text,
        header_period_start,
        header_period_end
        using errcode = 'P0001';
    end if;

    item_sort_order := coalesce(nullif(item_row->>'sortOrder', '')::integer, 0);

    insert into public.employee_plan_items (
      plan_id,
      activity_date,
      start_time,
      end_time,
      activity_type,
      activity_title,
      objective,
      attendees,
      location_text,
      area,
      double_visit_medical_rep_hr_id,
      double_visit_medical_rep_name,
      notes,
      sort_order
    )
    values (
      p_plan_id,
      item_activity_date,
      nullif(item_row->>'startTime', '')::time,
      nullif(item_row->>'endTime', '')::time,
      coalesce(nullif(btrim(item_row->>'activityType'), ''), 'Other'),
      coalesce(nullif(btrim(item_row->>'activityTitle'), ''), 'Activity'),
      nullif(btrim(coalesce(item_row->>'objective', '')), ''),
      nullif(btrim(coalesce(item_row->>'attendees', '')), ''),
      nullif(btrim(coalesce(item_row->>'locationText', '')), ''),
      nullif(btrim(coalesce(item_row->>'area', '')), ''),
      nullif(btrim(coalesce(item_row->>'doubleVisitMedicalRepHrId', '')), ''),
      nullif(btrim(coalesce(item_row->>'doubleVisitMedicalRepName', '')), ''),
      coalesce(item_row->>'notes', ''),
      item_sort_order
    );
  end loop;

  if p_submit then
    next_status := public.phx_weekly_plan_next_status(current_status, 'submit', true);

    update public.employee_plan_headers
      set status = next_status,
          submitted_at = coalesce(submitted_at, now_ts),
          submitted_by_login_id = coalesce(submitted_by_login_id, p_actor_login_id),
          revision = revision + 1,
          updated_at = now_ts
      where id = p_plan_id;

    insert into public.employee_plan_decisions
      (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
      values
      (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'submit', current_status, next_status, null);
  else
    next_status := current_status;

    update public.employee_plan_headers
      set revision = revision + 1,
          updated_at = now_ts
      where id = p_plan_id;
  end if;

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_replace_items(uuid, integer, text, text, text, jsonb, boolean) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_replace_items(uuid, integer, text, text, text, jsonb, boolean) to service_role;

comment on function public.phx_weekly_plan_replace_items(uuid, integer, text, text, text, jsonb, boolean) is
  'Atomically replaces employee_plan_items under the locked employee_plan_headers revision and optionally submits the plan.';

commit;
