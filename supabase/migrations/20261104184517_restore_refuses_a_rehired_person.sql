-- restore_refuses_a_rehired_person
--
-- WHAT THIS CHANGES: public.phx_restore_employee_after_cancelled_resignation (added by
--   20261104174918) refuses when the person already holds another employee record with the same
--   national ID that is still employed. Nothing else in the function changes.
-- WHY: Cancel on the Resignations screen gives the old record back — active and on payroll. A
--   person re-hired under a new HR ID would then be paid on both. Omaima Wael resigned as AI-0009
--   and was re-hired the same evening as PD-0039; the owner kept PD-0039 (4 Nov 2026).
-- ROLLBACK: re-run the function body from 20261104174918 (create or replace).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This replaces one function; no row changes.

create or replace function public.phx_restore_employee_after_cancelled_resignation(
  p_resignation_id uuid,
  p_actor text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_res public.employee_resignations;
  v_emp public.employees;
  v_last_day date;
  v_newer integer;
  v_taken text;
  v_filled text;
  v_span record;
  v_seats text[] := array[]::text[];
  v_cancelled text[] := array[]::text[];
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_rehired text;
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'system');
begin
  select * into v_res from public.employee_resignations where id = p_resignation_id for update;
  if not found then
    raise exception 'restore: resignation % not found', p_resignation_id;
  end if;
  if lower(coalesce(v_res.status, v_res.exit_status, '')) = 'completed' then
    raise exception 'restore: a completed resignation cannot be cancelled';
  end if;

  select * into v_emp
    from public.employees
   where lower(btrim(hr_id)) = lower(btrim(v_res.employee_hr_id))
   for update;
  if not found then
    raise exception 'restore: employee % not found', v_res.employee_hr_id;
  end if;

  -- A resignation filed on the Resignations screen and never completed left the person active:
  -- there is nothing to give back.
  if lower(coalesce(v_emp.employment_status, '')) not in ('resigned', 'terminated') then
    return jsonb_build_object('restored', false, 'reason', 'employee_not_terminal', 'employeeHrId', v_emp.hr_id);
  end if;

  -- Re-hired under a new HR ID already (same national ID, still employed): giving the old record
  -- back as well would put one person on payroll twice. Omaima Wael, 4 Nov 2026: resigned as
  -- AI-0009 and re-hired the same evening as PD-0039 on the Pedia line.
  if nullif(btrim(coalesce(v_emp.national_id, '')), '') is not null then
    select string_agg(e.hr_id, ', ' order by e.hr_id) into v_rehired
      from public.employees e
     where btrim(e.national_id) = btrim(v_emp.national_id)
       and lower(btrim(e.hr_id)) <> lower(btrim(v_emp.hr_id))
       and lower(coalesce(e.employment_status, '')) not in
         ('resigned', 'terminated', 'declined_offer', 'historical_payroll_record', 'system_placeholder');
    if v_rehired is not null then
      raise exception 'restore: % was re-hired as % — cancelling would put the same person on payroll twice; keep the new record, or end it before cancelling',
        v_emp.hr_id, v_rehired;
    end if;
  end if;

  -- Only the exit that took them out is undone, never an older one under a newer exit.
  select count(*) into v_newer
    from public.employee_resignations r
   where lower(btrim(r.employee_hr_id)) = lower(btrim(v_emp.hr_id))
     and r.id <> v_res.id
     and r.created_at > v_res.created_at
     and lower(coalesce(r.status, r.exit_status, '')) not in ('cancelled', 'rejected');
  if v_newer > 0 then
    raise exception 'restore: % has a newer exit record — cancel that one instead', v_emp.hr_id;
  end if;

  v_last_day := coalesce(v_res.last_working_date, v_res.effective_date);
  if v_emp.last_working_date is distinct from v_last_day then
    raise exception 'restore: % ended on % on the employee record but this resignation says % — they were taken out by something else',
      v_emp.hr_id, coalesce(v_emp.last_working_date::text, 'no date'), coalesce(v_last_day::text, 'no date');
  end if;

  -- Refuse before touching anything when a seat or a vacancy has gone to someone else.
  select string_agg(p.seat_id || ' (now ' || cur.occupant_hr_id || ')', ', ' order by p.seat_id)
    into v_taken
    from au.occupancy_history p
    join au.occupancy_history cur
      on cur.seat_id = p.seat_id and cur.effective_to is null and cur.occupant_hr_id is not null
   where p.occupant_canonical_hr_id = lower(btrim(v_emp.hr_id))
     and p.node_type = 'person'
     and p.effective_to in (v_last_day, v_last_day + 1)
     and cur.occupant_canonical_hr_id <> lower(btrim(v_emp.hr_id));
  if v_taken is not null then
    raise exception 'restore: the seat % left has since been given to someone else: % — move them first', v_emp.hr_id, v_taken;
  end if;

  select string_agg(coalesce(v.vacancy_code, v.id::text) || ' (' || v.filled_by_hr_id || ')', ', ')
    into v_filled
    from public.position_vacancies v
   where (v.id = v_res.vacancy_id or v.replacement_for_hr_id = v_emp.hr_id)
     and lower(coalesce(v.status, 'open')) = 'filled'
     and v.filled_at >= v_res.created_at;
  if v_filled is not null then
    raise exception 'restore: the replacement vacancy for % was already filled: % — move that person first', v_emp.hr_id, v_filled;
  end if;

  -- The vacancies first, so the employee update below finds no open replacement to fill.
  with closed as (
    update public.position_vacancies v
       set status = 'cancelled',
           note = concat_ws(E'\n', nullif(v.note, ''),
             format('Cancelled %s: the resignation of %s was cancelled and they are back in this job.', v_today, v_emp.hr_id)),
           updated_at = now()
     where (v.id = v_res.vacancy_id or v.replacement_for_hr_id = v_emp.hr_id)
       and lower(coalesce(v.status, 'open')) = 'open'
    returning coalesce(v.vacancy_code, v.id::text) as code
  )
  select coalesce(array_agg(code order by code), array[]::text[]) into v_cancelled from closed;

  -- The seat: drop the resignation's vacant placeholder and reopen their own span, so the history
  -- reads as if they never left.
  for v_span in
    select ph.occupancy_id as placeholder_id, ph.seat_id, ph.prev_occupancy_id
      from au.occupancy_history ph
      join au.occupancy_history p on p.occupancy_id = ph.prev_occupancy_id
     where ph.effective_to is null
       and ph.occupant_hr_id is null
       and ph.event_type = 'resign'
       and p.occupant_canonical_hr_id = lower(btrim(v_emp.hr_id))
       and p.effective_to = ph.effective_from
       and ph.effective_from in (v_last_day, v_last_day + 1)
     order by ph.seat_id
  loop
    delete from au.occupancy_history where occupancy_id = v_span.placeholder_id;
    update au.occupancy_history set effective_to = null where occupancy_id = v_span.prev_occupancy_id;
    perform au.sync_area_state_for_seat(v_span.seat_id, 'vacant_will_hire', 'occupied');
    v_seats := v_seats || v_span.seat_id::text;
  end loop;

  perform set_config('request.phx_allow_terminal_employee_reactivation', 'on', true);
  update public.employees
     set employment_status = 'active',
         payroll_eligible = true,
         organogram_visible = true,
         exit_reason = null,
         exit_status = null,
         exit_category = null,
         last_working_date = null,
         resignation_date = null,
         crm_id = coalesce(crm_id, v_res.crm_id_before),
         updated_at = now()
   where hr_id = v_emp.hr_id;
  perform set_config('request.phx_allow_terminal_employee_reactivation', '', true);

  update public.app_auth_users set is_active = true, updated_at = now() where hr_id = v_emp.hr_id;
  update public.user_access_profiles set is_active = true, updated_at = now() where hr_id = v_emp.hr_id;

  begin
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      v_actor,
      'employee_resignation_cancel_restore',
      v_emp.hr_id,
      format('Resignation cancelled: %s is active again, on payroll, back on %s', v_emp.hr_id,
        coalesce(nullif(array_to_string(v_seats, ', '), ''), 'no seat')),
      jsonb_build_object(
        'resignationId', v_res.id,
        'lastWorkingDayUndone', v_last_day,
        'seatsRestored', to_jsonb(v_seats),
        'vacanciesCancelled', to_jsonb(v_cancelled),
        'crmIdRestored', v_emp.crm_id is null and v_res.crm_id_before is not null
      )
    );
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'restored', true,
    'employeeHrId', v_emp.hr_id,
    'seatsRestored', to_jsonb(v_seats),
    'vacanciesCancelled', to_jsonb(v_cancelled),
    'crmIdRestored', v_emp.crm_id is null and v_res.crm_id_before is not null
  );
end;
$function$;

revoke execute on function public.phx_restore_employee_after_cancelled_resignation(uuid, text) from public, anon, authenticated;
grant execute on function public.phx_restore_employee_after_cancelled_resignation(uuid, text) to service_role;
