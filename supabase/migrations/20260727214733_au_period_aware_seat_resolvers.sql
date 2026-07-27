-- =============================================================================
-- ONE CANONICAL PERIOD-AWARE SEAT RESOLVER (no naive "newest row" anywhere)
-- =============================================================================
-- Trigger: the Anti Infective NSM (B-157) resignation, effective 2026-07-13. Seat
-- SEAT-AIF-NSM now carries TWO occupancy spans — B-157 [2026-02-01, 2026-07-13)
-- and a vacant placeholder [2026-07-13, open). Any resolver that took "the newest
-- occupancy_history row" without a period / effective_to filter would still name
-- B-157 as the sitting NSM, and would route the line's Others (OT) block — 7,995
-- fact rows that reach the NSM seat through the SEAT-AIF-OTHERS pseudo-DM — to a
-- person who has left.
--
-- AUDIT RESULT (2026-07-27, read-only against production ozucdzovmcqvepbozvqf):
-- that naive resolver does not exist. Every occupant read already filters:
--   au.v_org_tree, au.v_org_structure_kpis          -> effective_to is null (current)
--   au.f_monthly_attribution (4x), f_monthly_achievement (2x)
--                                                   -> as-of period_end (history)
--   au.resign_occupant / hire_into_seat / transfer_occupant
--                                                   -> effective_to is null
--   public.phx_resign_employee_and_open_vacancy     -> effective_to is null
-- No TypeScript reads au.occupancy_history directly; the app goes through
-- public.au_v_org_tree. SEAT-AIF-NSM correctly reads VACANT today.
--
-- What this migration fixes is the SAME defect class one table over, plus the
-- duplication that lets the naive pattern back in:
--
-- FIX 1 - au.line_area_map is period-versioned (effective_from / effective_to, with
--   the partial unique index `line_area_map_current ... where effective_to is null`)
--   yet EVERY reader joins it with no period filter: f_monthly_attribution (4 joins),
--   f_monthly_achievement (1), and public.au_v_line_area_map — the wrapper the
--   Territory & Sales drilldown, monthly targets and the employee region resolver all
--   read. Harmless today (125 rows, 0 closed). The moment a successor NSM re-maps one
--   (line, area) to a different DM/rep seat, the join matches the old AND the new row
--   and that area's sales are counted TWICE. Measured on live 2026-05 data: Anti
--   Infective / OT1 goes 14 units -> 28 units. au.f_line_area_map_asof returns exactly
--   one row per (line_code, area_code) by construction, so the fan-out is impossible.
--
-- FIX 2 - the occupant window predicate was copy-pasted in six places. It is now one
--   function, au.f_seat_occupant_asof, so there is a single thing to keep right.
--
-- FIX 3 - phx_resign_employee_and_open_vacancy locates the resigning employee's seat
--   by comparing occupant_hr_id RAW. HR_ID is always compared normalized in this
--   codebase, and au.occupancy_history already carries the generated
--   occupant_canonical_hr_id column for exactly this. One casing/whitespace difference
--   would silently skip the vacate step and leave a departed occupant sitting on the
--   seat — precisely the bug this migration is named after. Zero drift today
--   (verified), so this is a latch, not a repair.
--
-- BEHAVIOUR ON TODAY'S DATA: byte-identical. Proven read-only against production —
-- no (line_code, area_code) has more than one row, and the as-of projection is
-- set-identical to the raw table for all 12 period-ends of 2026. History is NOT
-- rewritten: SEAT-AIF-NSM still resolves to B-157 for Feb-Jun 2026 and to VACANT
-- from Jul 2026 on.
--
-- Regression guard: tests/au-seat-occupant-resolver.test.ts.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The canonical seat-occupant resolver.
-- ---------------------------------------------------------------------------
-- Occupancy spans are half-open [effective_from, effective_to): a resignation closes
-- the span on date D and opens the vacant placeholder on the same date D, so exactly
-- one span covers any given day. The ordering below prefers the span covering p_asof
-- and falls back to the EARLIEST span when p_asof precedes the seat's first span —
-- the seed baseline case (see 20260718130000), which credits the baseline occupant
-- for periods that predate the seat model rather than dropping the sales entirely.
create or replace function au.f_seat_occupant_asof(p_seat_id text, p_asof date)
returns text
language sql
stable
security definer
set search_path to 'au', 'public'
as $$
  select oh.occupant_hr_id
  from au.occupancy_history oh
  where oh.seat_id = p_seat_id
  order by
    (oh.effective_from <= p_asof and (oh.effective_to is null or oh.effective_to > p_asof)) desc,
    oh.effective_from asc
  limit 1;
$$;

comment on function au.f_seat_occupant_asof(text, date) is
  'Canonical seat-occupant resolver. Returns the occupant of p_seat_id as of p_asof: the occupancy span covering that date (half-open [effective_from, effective_to)), else the earliest span. NULL when that span is a vacant placeholder. Never resolve an occupant by taking the newest occupancy_history row - a resigned occupant is the newest NON-NULL row on a vacated seat.';

revoke all on function au.f_seat_occupant_asof(text, date) from public, anon, authenticated;
grant execute on function au.f_seat_occupant_asof(text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 2) The canonical (line, area) -> seat map, as of a date.
-- ---------------------------------------------------------------------------
-- Same window + earliest-span fallback as the occupant resolver above. `distinct on`
-- guarantees at most ONE row per (line_code, area_code), which is what makes the
-- attribution joins fan-out-proof after a future re-map.
create or replace function au.f_line_area_map_asof(p_asof date)
returns table (
  line_code text,
  area_code text,
  operational_region_code text,
  area_state text,
  other_type text,
  staffed_in_line_code text,
  dm_seat_id text,
  rep_seat_id text,
  carries_target boolean
)
language sql
stable
security definer
set search_path to 'au', 'public'
rows 150
as $$
  select distinct on (m.line_code, m.area_code)
    m.line_code,
    m.area_code,
    m.operational_region_code,
    m.area_state,
    m.other_type,
    m.staffed_in_line_code,
    m.dm_seat_id,
    m.rep_seat_id,
    m.carries_target
  from au.line_area_map m
  order by
    m.line_code,
    m.area_code,
    (m.effective_from <= p_asof and (m.effective_to is null or m.effective_to > p_asof)) desc,
    m.effective_from asc;
$$;

comment on function au.f_line_area_map_asof(date) is
  'Canonical (line_code, area_code) -> DM/rep seat mapping as of p_asof. Exactly one row per key, so joining it can never fan out a sales fact row across a superseded and a current mapping.';

revoke all on function au.f_line_area_map_asof(date) from public, anon, authenticated;
grant execute on function au.f_line_area_map_asof(date) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Attribution engine: same logic, resolved through the two helpers.
-- ---------------------------------------------------------------------------
-- Body is 20260719140000_au_direct_area_attribution.sql verbatim except that
-- `au.line_area_map` became `au.f_line_area_map_asof(v_period_end)` and each inline
-- occupancy lateral became a call to au.f_seat_occupant_asof. Branch semantics,
-- grouping and the confidential-product exclusion are untouched.
create or replace function au.f_monthly_attribution(p_period text)
 returns table(period text, channel text, line_code text, region_code text, area_code text, area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text, sales_units numeric, sales_value numeric, mapped boolean, unmapped_reason text)
 language plpgsql
 stable security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with fact as (
    select
      f.official_line,
      f.region_code                              as sos_region_code,
      nullif(btrim(f.area_code), '')             as sos_area_code,
      upper(btrim(coalesce(f.product_code,'')))  as product_code,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code,''))) not in ('LA003','LA004','SS001')
  ),
  priced as (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(pp.factory_price, 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = fa.product_code
  ),
  -- The (line, area) -> seat map in force at period end, with each seat's occupant as
  -- of the same date, resolved ONCE (~125 rows) instead of once per fact row — the
  -- inline laterals this replaces re-ran the occupancy lookup for all ~30k fact rows.
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  )
  -- Branch A: indirect (distributor) sales mapped to a (line, area) seat.
  select
    p_period,
    'indirect'::text,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.effective_units * pr.factory_price),
    true,
    null::text
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where not pr.is_direct
    and pr.line_code is not null
    and pr.canonical_area_code is not null
  group by lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
           (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
           lam.dm_seat_id, lam.dm_occupant_hr_id, pr.product_code

  union all
  -- Branch B1: DIRECT sales that carry an area -> attribute to the (line, area) seat
  -- (channel stays 'direct'; value = direct_value = the sheet value).
  select
    p_period,
    'direct'::text,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.direct_value),
    true,
    null::text
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where pr.is_direct
    and pr.line_code is not null
    and pr.canonical_area_code is not null
  group by lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
           (lam.other_type is not null), lam.rep_seat_id, lam.rep_occupant_hr_id,
           lam.dm_seat_id, lam.dm_occupant_hr_id, pr.product_code

  union all
  -- Branch B2: DIRECT sales with NO area (or an area with no seat map) -> region
  -- level, no rep. This is the manual company upload path.
  select
    p_period,
    'direct'::text,
    pr.line_code,
    coalesce(nullif(pr.sos_region_code,''), 'NATIONAL'),
    null, null, false,
    null, null, null, null,
    pr.product_code,
    sum(pr.total_qty),
    sum(pr.direct_value),
    true,
    null::text
  from priced pr
  left join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where pr.is_direct
    and pr.line_code is not null
    and (pr.canonical_area_code is null or lam.line_code is null)
  group by pr.line_code, coalesce(nullif(pr.sos_region_code,''),'NATIONAL'), pr.product_code

  union all
  -- Branch C: unmapped — Head Office line, blank area, or a (line,area) with no seat map.
  select
    p_period,
    'unmapped'::text,
    pr.line_code,
    null,
    pr.canonical_area_code,
    null, false,
    null, null, null, null,
    pr.product_code,
    sum(pr.total_qty),
    sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
    false,
    case
      when pr.line_code is null then 'unmapped_line'
      when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
      when (not pr.is_direct) then 'no_area_map'
      else 'unmapped_other'
    end
  from priced pr
  left join lam_asof lam
    on lam.line_code = pr.line_code
   and lam.area_code = pr.canonical_area_code
  where pr.line_code is null
     or ((not pr.is_direct) and (pr.canonical_area_code is null or lam.line_code is null))
  group by pr.line_code, pr.canonical_area_code, pr.is_direct,
           case
             when pr.line_code is null then 'unmapped_line'
             when (not pr.is_direct) and pr.canonical_area_code is null then 'blank_area'
             when (not pr.is_direct) then 'no_area_map'
             else 'unmapped_other'
           end,
           pr.product_code;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4) Achievement grid: same substitution, no semantic change.
-- ---------------------------------------------------------------------------
create or replace function au.f_monthly_achievement(p_period text)
 returns table(period text, line_code text, region_code text, area_code text, area_state text, is_other boolean, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, product_code text, actual_units numeric, actual_value numeric, target_units numeric, target_value numeric, achievement_value numeric, achievement_units numeric, has_target boolean, has_actual boolean)
 language plpgsql
 stable security definer
 set search_path to 'au', 'public'
as $function$
#variable_conflict use_column
declare
  v_period_end date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
begin
  return query
  with actuals as (
    select a.line_code, a.area_code, a.product_code,
           sum(a.sales_units) as actual_units, sum(a.sales_value) as actual_value
    from au.f_monthly_attribution(p_period) a
    where a.channel = 'indirect'
       or (a.channel = 'direct' and a.area_code is not null)
    group by a.line_code, a.area_code, a.product_code
  ),
  tgt as (
    select t.line_code, t.area_code, t.product_code, t.target_units, t.target_value
    from au.monthly_targets t
    where t.period = p_period
  ),
  keys as (
    select actuals.line_code, actuals.area_code, actuals.product_code from actuals
    union
    select tgt.line_code, tgt.area_code, tgt.product_code from tgt
  ),
  -- Same as f_monthly_attribution: the mapping in force at period end plus each seat's
  -- occupant as of that date, resolved once rather than once per (area, product) key.
  lam_asof as materialized (
    select
      l.line_code,
      l.area_code,
      l.operational_region_code,
      l.area_state,
      l.other_type,
      l.dm_seat_id,
      l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  )
  select
    p_period,
    k.line_code,
    lam.operational_region_code,
    k.area_code,
    lam.area_state,
    (lam.other_type is not null),
    lam.rep_seat_id, lam.rep_occupant_hr_id,
    lam.dm_seat_id, lam.dm_occupant_hr_id,
    k.product_code,
    coalesce(ac.actual_units, 0), coalesce(ac.actual_value, 0),
    tg.target_units, tg.target_value,
    case when tg.target_value is not null and tg.target_value <> 0
         then coalesce(ac.actual_value, 0) / tg.target_value end,
    case when tg.target_units is not null and tg.target_units <> 0
         then coalesce(ac.actual_units, 0) / tg.target_units end,
    (tg.line_code is not null),
    (ac.line_code is not null)
  from keys k
  left join actuals ac on ac.line_code = k.line_code and ac.area_code = k.area_code and ac.product_code = k.product_code
  left join tgt tg on tg.line_code = k.line_code and tg.area_code = k.area_code and tg.product_code = k.product_code
  left join lam_asof lam on lam.line_code = k.line_code and lam.area_code = k.area_code;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5) The public wrapper is a CURRENT-state view — say so.
-- ---------------------------------------------------------------------------
-- Read by src/lib/sales/territory/skeleton.ts, src/lib/sales/monthly-targets.ts and
-- src/lib/employees/region-resolver.ts, all of which want "the mapping in force now".
-- Without this filter they would each start seeing one row per historical mapping the
-- first time an area is re-mapped. Callers that need a past mapping must use
-- au.f_line_area_map_asof(date), not this view.
create or replace view public.au_v_line_area_map as
  select m.*, ca.area_name
  from au.line_area_map m
  join au.canonical_areas ca on ca.area_code = m.area_code
  where m.effective_to is null;

-- ---------------------------------------------------------------------------
-- 6) FIX 3 — normalized HR_ID when vacating the resigning employee's seat.
-- ---------------------------------------------------------------------------
-- Verbatim 20260718210000_phx_resign_employee_and_open_vacancy_rpc.sql except for the
-- step-5 lookup, which now matches on the generated occupant_canonical_hr_id instead
-- of the raw occupant_hr_id. search_path is still '' so every reference stays fully
-- qualified.
create or replace function public.phx_resign_employee_and_open_vacancy(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_employee_status text,
  p_reason text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text,
  p_workflow_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_line_name text;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_resignation_id uuid;
  v_seat_id text;
begin
  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_resign_employee_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;

  select name into v_line_name from public.lines where id = v_employee.line_id;
  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;

  -- 1. Open the replacement vacancy (mirrors insertFallbackVacancy's full payload).
  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;

  -- 2. Record the resignation (mirrors insertResignationRecord's full payload).
  insert into public.employee_resignations (
    employee_hr_id, employee_name, job_title, line_name,
    submitted_date, effective_date, resignation_date, last_working_date,
    reason, notes, workflow_notes, exit_status, status,
    create_vacancy, vacancy_id, submitted_by_hr_id, created_by, created_at, updated_at
  ) values (
    p_employee_hr_id, v_employee.full_name, coalesce(v_position_title, v_employee.job_title), v_line_name,
    p_submitted_date, p_effective_date, p_submitted_date, p_effective_date,
    p_reason, coalesce(p_workflow_notes, p_reason), p_workflow_notes, 'submitted', 'submitted',
    true, v_vacancy_id, p_submitted_by_hr_id, p_actor, now(), now()
  )
  returning id into v_resignation_id;

  -- 3. Update the employee's own lifecycle fields (mirrors updateEmployeeLifecycleFallback).
  --    This UPDATE fires the existing terminal-lifecycle triggers exactly as the JS
  --    fallback's equivalent UPDATE always has — no trigger logic is duplicated here.
  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 4. Deactivate app access (DB-side only; Telegram deactivation is an external API
  --    call and must stay in application code — see the note at the top of this file).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 5. Fix-3: vacate the resigning employee's current au seat, if any, in the SAME
  --    transaction — closes the gap that let stale occupants linger past a resignation
  --    (the exact bug FIX-D corrected once, as a one-time cutover repair, not an ongoing fix).
  --    Matched on the generated canonical HR_ID: a raw comparison silently misses on any
  --    casing/whitespace difference and leaves the departed occupant on the seat.
  select seat_id into v_seat_id
  from au.occupancy_history
  where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
    and effective_to is null
    and node_type = 'person'
  limit 1;
  if v_seat_id is not null then
    perform au.resign_occupant(v_seat_id, p_effective_date, coalesce(p_reason, 'resignation'), p_actor);
  end if;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_code', p_vacancy_code
  );
end;
$$;

-- The `public` schema has a project-wide default ACL that auto-grants EXECUTE to
-- `authenticated` on every new function — `revoke ... from public` alone does NOT
-- remove that direct grant. Both revokes are required or this RPC is callable by any
-- Supabase-authenticated session via PostgREST, bypassing every app-layer
-- permission/workflow check normally gating a resignation.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from public;
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) to service_role;

notify pgrst, 'reload schema';

commit;
