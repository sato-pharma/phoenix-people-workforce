-- Cairo-zone the date defaults in four live SQL functions.
--
-- WHY. Production Postgres runs `TimeZone = UTC` (verified live 2026-08-01) while the business,
-- the app and the writers all work in Africa/Cairo (UTC+3 in summer). Between Cairo 00:00 and
-- 03:00 — i.e. UTC 21:00-24:00 of the previous day — an unzoned `current_date` evaluates to
-- YESTERDAY. Every night there is a three-hour window in which these functions silently use the
-- wrong day, and nothing errors.
--
-- WHAT EACH ONE COSTS, in the order fixed here:
--
--   1. public.accept_offer_and_create_employee
--      `v_hire_date := coalesce(p_hire_date, o.start_date, current_date)` — when an offer carries
--      no start date and the caller passes none, an acceptance recorded after midnight Cairo
--      stamps the employee's HIRE DATE one day early. That date is not cosmetic: it propagates
--      into the +90-day probation end date and into the contract anniversary, so one wrong write
--      moves two downstream deadlines for the life of the employee.
--
--   2. public.finalize_manual_employee_lifecycle
--      `coalesce(e.hire_date, current_date)` into employee_history.effective_from — a lifecycle
--      row backdated by a day against the rest of the history.
--
--   3. au.f_seat_occupant_asof
--      Bounds the "who holds this seat TODAY" arm with `effective_from <= current_date`. Its
--      WRITER (20260728010000_au_wire_hire_into_seat_on_vacancy_fill.sql:130) stamps
--      `(now() at time zone 'Africa/Cairo')::date`. Writer-Cairo against reader-UTC means a span
--      opened during the window is invisible to the reader that should see it: arm 1 misses, the
--      function falls through to arm 2, and SoS credit moves to a different person for those
--      three hours. Called by au.f_monthly_attribution and au.f_monthly_achievement.
--
--   4. public.generate_employee_lifecycle_notifications
--      `extract(year from current_date)` builds this year's birthday date — on 1 January, between
--      00:00 and 03:00 Cairo, that is last year's birthday, i.e. a date in the past.
--
-- WHAT THIS MIGRATION IS. Each body below was produced by running
-- `regexp_replace(pg_get_functiondef(oid), '\mcurrent_date\M', '(now() at time zone
-- ''Africa/Cairo'')::date', 'g')` against the live production catalog and writing the result
-- straight to this file — the bodies were never retyped or reassembled by hand. \m and \M are
-- word boundaries, so an identifier such as `v_current_date` could not have been corrupted;
-- a word-boundary count and a raw count were compared per function beforehand and were equal.
-- Nothing else in any body changed. Verify by diffing pg_get_functiondef before/after: the only
-- difference must be the date expression.
--
-- Bodies come from pg_get_functiondef, so LANGUAGE / STABLE / SECURITY DEFINER / SET search_path
-- are all carried verbatim. That matters: CREATE OR REPLACE does NOT inherit them, and silently
-- dropping SECURITY DEFINER here would break every caller without direct table access.
--
-- NOT IN SCOPE — the five replacement/vacancy-ownership functions
-- (phx_ensure_terminal_employee_vacancy, phx_release_terminal_manager_ownership,
-- phx_reconcile_stale_replacement_vacancies, phx_reassign_replacement_ownership,
-- phx_autofill_replacement_vacancy_from_employee_insert) also read unzoned `current_date` and
-- are being actively reshaped by a parallel session (20260801150000, 20260801160000). Re-emitting
-- their bodies here would freeze a version that is still changing. They are tracked separately.
-- Three of those five store a real date (not just note text) and are NOT merely cosmetic.
--
-- Idempotent: pure CREATE OR REPLACE plus revokes that are already true. No data is touched.

begin;

CREATE OR REPLACE FUNCTION public.accept_offer_and_create_employee(p_offer_id uuid, p_hr_id text, p_hire_date date DEFAULT NULL::date, p_birth_date date DEFAULT NULL::date, p_contract_start_date date DEFAULT NULL::date, p_contract_renewal_date date DEFAULT NULL::date, p_probation_end_date date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o record;
  v_hire_date date;
  v_hr_id text;
begin
  select * into o
  from public.job_offers
  where id = p_offer_id;

  if not found then
    raise exception 'Offer % not found', p_offer_id;
  end if;

  if o.status not in ('sent','accepted') then
    raise exception 'Offer % is not in a valid status for acceptance. Current status: %', p_offer_id, o.status;
  end if;

  v_hr_id := trim(p_hr_id);
  if v_hr_id is null or v_hr_id = '' then
    raise exception 'HR_ID is required';
  end if;

  if exists (select 1 from public.employees where hr_id = v_hr_id)
     and coalesce(o.employee_hr_id, '') <> v_hr_id then
    raise exception 'HR_ID % already exists in employees', v_hr_id;
  end if;

  v_hire_date := coalesce(p_hire_date, o.start_date, (now() at time zone 'Africa/Cairo')::date);

  insert into public.employees (
    hr_id,
    full_name,
    work_email,
    mobile_number,
    job_title,
    hire_date,
    employment_status,
    manager_hr_id,
    department_id,
    line_id,
    area_id,
    position_id,
    birth_date,
    contract_start_date,
    contract_renewal_date,
    probation_end_date,
    onboarding_source,
    onboarding_status,
    payroll_eligible,
    organogram_visible,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.candidate_name,
    o.candidate_email,
    o.candidate_phone,
    o.job_title,
    v_hire_date,
    'active',
    o.manager_hr_id,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    p_birth_date,
    coalesce(p_contract_start_date, v_hire_date),
    p_contract_renewal_date,
    p_probation_end_date,
    'job_offer',
    'active',
    true,
    true,
    now(),
    now()
  )
  on conflict (hr_id) do update
  set
    full_name = excluded.full_name,
    work_email = excluded.work_email,
    mobile_number = excluded.mobile_number,
    job_title = excluded.job_title,
    hire_date = excluded.hire_date,
    employment_status = 'active',
    manager_hr_id = excluded.manager_hr_id,
    department_id = excluded.department_id,
    line_id = excluded.line_id,
    area_id = excluded.area_id,
    position_id = excluded.position_id,
    birth_date = coalesce(excluded.birth_date, public.employees.birth_date),
    contract_start_date = coalesce(excluded.contract_start_date, public.employees.contract_start_date),
    contract_renewal_date = coalesce(excluded.contract_renewal_date, public.employees.contract_renewal_date),
    probation_end_date = coalesce(excluded.probation_end_date, public.employees.probation_end_date),
    onboarding_source = 'job_offer',
    onboarding_status = 'active',
    payroll_eligible = true,
    organogram_visible = true,
    updated_at = now();

  insert into public.employee_compensation (
    employee_hr_id,
    gross_salary,
    net_salary,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.salary_amount,
    o.salary_amount,
    now(),
    now()
  )
  on conflict (employee_hr_id) do update
  set
    gross_salary = coalesce(excluded.gross_salary, public.employee_compensation.gross_salary),
    net_salary = coalesce(excluded.net_salary, public.employee_compensation.net_salary),
    updated_at = now();

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    position_id,
    note,
    created_at
  )
  values (
    v_hr_id,
    'hired_from_offer',
    v_hire_date,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    'Created from accepted job offer ' || coalesce(o.offer_code, o.id::text),
    now()
  );

  update public.job_offers
  set
    status = 'accepted',
    accepted_at = coalesce(accepted_at, now()),
    employee_hr_id = v_hr_id,
    onboarding_status = 'employee_created',
    updated_at = now()
  where id = p_offer_id;

  insert into public.job_offer_audit_logs (offer_id, action, actor_type, actor_reference, details, created_at)
  values (
    p_offer_id,
    'employee_created',
    'system',
    v_hr_id,
    jsonb_build_object('hr_id', v_hr_id, 'hire_date', v_hire_date),
    now()
  );

  perform public.generate_employee_lifecycle_notifications(v_hr_id);

  return v_hr_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_manual_employee_lifecycle(p_employee_hr_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e record;
begin
  select * into e from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  update public.employees
  set
    employment_status = coalesce(employment_status, 'active'),
    onboarding_source = coalesce(onboarding_source, 'manual_add'),
    onboarding_status = coalesce(onboarding_status, 'active'),
    payroll_eligible = coalesce(payroll_eligible, true),
    organogram_visible = coalesce(organogram_visible, true),
    updated_at = now()
  where hr_id = p_employee_hr_id;

  insert into public.employee_compensation (employee_hr_id, created_at, updated_at)
  values (p_employee_hr_id, now(), now())
  on conflict (employee_hr_id) do nothing;

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    team_id,
    position_id,
    note,
    created_at
  )
  values (
    p_employee_hr_id,
    'manual_employee_finalized',
    coalesce(e.hire_date, (now() at time zone 'Africa/Cairo')::date),
    e.department_id,
    e.line_id,
    e.area_id,
    e.team_id,
    e.position_id,
    'Manual employee lifecycle finalized',
    now()
  );

  perform public.generate_employee_lifecycle_notifications(p_employee_hr_id);
end;
$function$;

CREATE OR REPLACE FUNCTION au.f_seat_occupant_asof(p_seat_id text, p_asof date)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
  select coalesce(
    -- 1. Today's wiring wins: whoever holds this seat now inherits its history.
    (
      select oh.occupant_hr_id
      from au.occupancy_history oh
      where oh.seat_id = p_seat_id
        and oh.effective_from <= (now() at time zone 'Africa/Cairo')::date
        and (oh.effective_to is null or oh.effective_to > (now() at time zone 'Africa/Cairo')::date)
      order by oh.effective_from desc
      limit 1
    ),
    -- 2. Seat vacant today ⇒ the person who actually held it in that period keeps the credit.
    (
      select oh.occupant_hr_id
      from au.occupancy_history oh
      where oh.seat_id = p_seat_id
        and oh.effective_from <= p_asof
        and (oh.effective_to is null or oh.effective_to > p_asof)
      order by oh.effective_from desc
      limit 1
    )
    -- 3. No third arm on purpose. The previous `effective_from asc` fallback returned the earliest
    --    occupant the seat EVER had whenever neither window matched — inventing an owner who never
    --    held the seat in that period. Nobody held it ⇒ NULL, and the sale stays area-level.
  );
$function$;

CREATE OR REPLACE FUNCTION public.generate_employee_lifecycle_notifications(p_employee_hr_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e record;
  d integer;
begin
  select * into e
  from public.employees
  where hr_id = p_employee_hr_id;

  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  -- Probation: 30/14/7/0 days
  if e.probation_end_date is not null then
    foreach d in array array[30,14,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'probation',
        e.hr_id,
        e.probation_end_date - d,
        case when d = 0 then 'Probation ends today: ' else 'Probation reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.probation_end_date)
      );
    end loop;
  end if;

  -- Contract renewal: 60/30/7/0 days
  if e.contract_renewal_date is not null then
    foreach d in array array[60,30,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'contract_renewal',
        e.hr_id,
        e.contract_renewal_date - d,
        case when d = 0 then 'Contract renewal due today: ' else 'Contract renewal reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.contract_renewal_date)
      );
    end loop;
  end if;

  -- Birthday: current year occurrence only for now; yearly scheduler can regenerate annually
  if e.birth_date is not null then
    perform public.create_lifecycle_notification_event(
      'birthday',
      e.hr_id,
      make_date(extract(year from (now() at time zone 'Africa/Cairo')::date)::int, extract(month from e.birth_date)::int, extract(day from e.birth_date)::int),
      'Birthday reminder: ' || e.full_name,
      jsonb_build_object('birth_date', e.birth_date)
    );
  end if;
end;
$function$;

-- Self-contained re-assertion of the intended grants.
--
-- The revokes are no-ops against production's ACLs, where all four already read
-- {postgres=X, service_role=X}. They are NOT no-ops everywhere: on staging
-- au.f_seat_occupant_asof still carried the default (NULL) ACL, and a NULL ACL means "PUBLIC has
-- EXECUTE". The first REVOKE against such a function materialises the ACL and drops the PUBLIC
-- entry — taking service_role's access with it, because service_role held EXECUTE only by virtue
-- of being a member of PUBLIC. That is a silent fail-closed: the revoke succeeds, and the next
-- service_role call fails instead.
--
-- So the grants below are stated explicitly rather than inherited. Together the two halves make
-- the end state identical in every environment regardless of what the ACL was before —
-- PUBLIC cannot execute, service_role can — instead of depending on state this migration did not
-- create. Both are idempotent.
revoke execute on function public.accept_offer_and_create_employee(uuid,text,date,date,date,date,date) from public;
revoke execute on function public.finalize_manual_employee_lifecycle(text) from public;
revoke execute on function public.generate_employee_lifecycle_notifications(text) from public;
revoke execute on function au.f_seat_occupant_asof(text,date) from public;

grant execute on function public.accept_offer_and_create_employee(uuid,text,date,date,date,date,date) to service_role;
grant execute on function public.finalize_manual_employee_lifecycle(text) to service_role;
grant execute on function public.generate_employee_lifecycle_notifications(text) to service_role;
grant execute on function au.f_seat_occupant_asof(text,date) to service_role;

commit;
