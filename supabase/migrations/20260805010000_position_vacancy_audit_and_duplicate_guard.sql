-- Phase C vacancy hygiene: make vacancy churn visible, and stop new duplicates.
--
-- Two independent problems, both measured on production 2026-08-05:
--
-- 1. VACANCY CHANGES ARE INVISIBLE. `select count(*) from audit_logs where entity_type ilike
--    '%vacan%'` returned ZERO — not one vacancy status change has ever been recorded, while 23
--    vacancy rows were touched in the preceding 7 days alone (21 other entity types ARE audited).
--    That is why the 2026-08-04 bulk cancellations left no trace and the module keeps feeling
--    like it drifts on its own.
--
-- 2. DUPLICATE OPEN VACANCIES BREAK HIRING. `position_vacancies` has no unique index beyond
--    `vacancy_code`, so one seat accumulated open rows from five code eras (Heliopolis and
--    Sohag2 each carry TWO rows for the same departed person plus a structural row). The
--    autofill tiers in phx_autofill_replacement_vacancy_from_employee_insert each demand
--    EXACTLY ONE candidate, so a duplicated slot makes a new hire match nothing and silently
--    never reach their seat.
--
-- Scope of the guard is deliberately narrow, from measured invariants:
--   * au.seats holds at most ONE active REP seat per (line_code, area_code) — verified, max = 1.
--   * All 6 duplicated open slots are `medical_representative`; ZERO non-rep slots are duplicated.
-- So the guard covers rep vacancies only. Head-office and manager vacancies (regulatory_affairs,
-- district_sales_manager) legitimately may repeat per area and are untouched.
--
-- The guard fires only when a row BECOMES open (insert, or a status transition into 'open'), never
-- on edits to an already-open row — otherwise it would block the very cleanup that removes the
-- existing duplicates, and block cancelling one of a duplicated pair.
--
-- Data impact of this migration: none. Two functions + two triggers; no row is modified.
-- Rollback:
--   drop trigger if exists trg_position_vacancies_audit on public.position_vacancies;
--   drop trigger if exists trg_position_vacancies_single_open_rep on public.position_vacancies;
--   drop function if exists public.phx_audit_position_vacancy_change();
--   drop function if exists public.phx_guard_single_open_rep_vacancy();

-- ---------------------------------------------------------------------------
-- 1. Audit every vacancy creation and status transition.
--    Never break the write: the whole body is exception-guarded, exactly like the
--    au_seat_hire audit path in phx_hire_into_seat_on_vacancy_filled.
-- ---------------------------------------------------------------------------

create or replace function public.phx_audit_position_vacancy_change()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_old_status text := lower(coalesce(old.status, 'open'));
  v_new_status text := lower(coalesce(new.status, 'open'));
  v_actor text := coalesce(nullif(btrim(current_setting('phoenix.actor_login_id', true)), ''), 'system');
  v_line text;
  v_area text;
begin
  -- Only creations and genuine status transitions are worth a row; ordinary edits
  -- (notes, manager backfill) would drown the signal.
  if tg_op = 'UPDATE' and v_old_status = v_new_status then
    return null;
  end if;

  begin
    select l.name into v_line from public.lines l where l.id = new.line_id;
    select a.name into v_area from public.areas a where a.id = new.area_id;

    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, old_values, new_values)
    values (
      v_actor,
      'position_vacancy',
      coalesce(new.vacancy_code, new.id::text),
      case
        when tg_op = 'INSERT' then
          format('Vacancy %s opened for %s / %s%s',
            coalesce(new.vacancy_code, new.id::text),
            coalesce(v_line, 'unknown line'),
            coalesce(v_area, 'unknown area'),
            case when new.replacement_for_hr_id is not null
                 then ' (replacing ' || new.replacement_for_hr_id || ')' else '' end)
        else
          format('Vacancy %s: %s -> %s%s',
            coalesce(new.vacancy_code, new.id::text), v_old_status, v_new_status,
            case when new.filled_by_hr_id is not null
                 then ' (filled by ' || new.filled_by_hr_id || ')' else '' end)
      end,
      case when tg_op = 'UPDATE' then jsonb_build_object(
        'status', old.status,
        'filledByHrId', old.filled_by_hr_id,
        'replacementForHrId', old.replacement_for_hr_id
      ) else null end,
      jsonb_build_object(
        'vacancyId', new.id,
        'vacancyCode', new.vacancy_code,
        'status', new.status,
        'lineId', new.line_id,
        'lineName', v_line,
        'areaId', new.area_id,
        'areaName', v_area,
        'jobTitle', new.job_title,
        'managerHrId', new.manager_hr_id,
        'replacementForHrId', new.replacement_for_hr_id,
        'filledByHrId', new.filled_by_hr_id,
        'operation', tg_op
      )
    );
  exception when others then
    -- Auditing must never fail a vacancy write.
    null;
  end;

  return null;
end;
$function$;

revoke execute on function public.phx_audit_position_vacancy_change() from public, anon, authenticated;
grant execute on function public.phx_audit_position_vacancy_change() to service_role;

drop trigger if exists trg_position_vacancies_audit on public.position_vacancies;
create trigger trg_position_vacancies_audit
after insert or update on public.position_vacancies
for each row
execute function public.phx_audit_position_vacancy_change();

-- ---------------------------------------------------------------------------
-- 2. One open REP vacancy per (line, area).
-- ---------------------------------------------------------------------------

create or replace function public.phx_guard_single_open_rep_vacancy()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_position_code text;
  v_existing text;
begin
  if lower(coalesce(new.status, 'open')) <> 'open' then
    return new;
  end if;
  -- Only when the row BECOMES open. Editing or cancelling an already-open row must stay
  -- possible, or this would block the cleanup of the pre-existing duplicates.
  if tg_op = 'UPDATE' and lower(coalesce(old.status, 'open')) = 'open' then
    return new;
  end if;
  if new.line_id is null or new.area_id is null then
    return new;
  end if;

  select p.code into v_position_code from public.positions p where p.id = new.position_id;
  -- Structural rule: au.seats holds at most one active REP seat per (line, area), so a second
  -- open rep vacancy for that slot is always a duplicate. Manager / head-office vacancies carry
  -- no such invariant and are deliberately not guarded.
  if coalesce(v_position_code, '') <> 'medical_representative' then
    return new;
  end if;

  select string_agg(coalesce(pv.vacancy_code, pv.id::text), ', ' order by pv.id)
    into v_existing
    from public.position_vacancies pv
    join public.positions p2 on p2.id = pv.position_id
   where lower(coalesce(pv.status, 'open')) = 'open'
     and pv.line_id = new.line_id
     and pv.area_id = new.area_id
     and p2.code = 'medical_representative'
     and pv.id is distinct from new.id;

  if v_existing is not null then
    raise exception 'vacancy: an open medical-rep vacancy already exists for this line/area (%) - close or cancel it before opening another, or the hire autofill will match neither', v_existing
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$function$;

revoke execute on function public.phx_guard_single_open_rep_vacancy() from public, anon, authenticated;
grant execute on function public.phx_guard_single_open_rep_vacancy() to service_role;

drop trigger if exists trg_position_vacancies_single_open_rep on public.position_vacancies;
create trigger trg_position_vacancies_single_open_rep
before insert or update on public.position_vacancies
for each row
execute function public.phx_guard_single_open_rep_vacancy();
