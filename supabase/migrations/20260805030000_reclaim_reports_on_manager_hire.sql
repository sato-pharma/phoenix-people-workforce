-- Hiring a manager must reclaim the reports that resignation pushed upward.
--
-- THE DEFECT (found live 2026-08-05): resignation is a two-sided move that only ever ran one way.
-- `phx_release_terminal_manager_ownership` correctly reassigns a departing manager's reports UP to
-- the next manager and stamps `pending_manager_replacement_for_hr_id` so a future replacement can
-- re-inherit them. Nothing ever performed that re-inheritance. Hiring into the seat left every
-- report stranded at the higher manager, permanently.
--
-- Measured on production before this migration:
--   * AI-0008 (Magdy El Senosey) was hired into SEAT-AIF-NSM and had **0 direct reports** while
--     running the entire Anti Infective line;
--   * all 5 AIF District Managers plus the acting DM still reported to the CEO (AA), whose direct
--     report count was inflated to 21;
--   * 12 active employees still carried markers naming B-157 and B-175, both long resigned.
--
-- This matters beyond the org chart: `employees.manager_hr_id` drives approval routing, team
-- visibility and hierarchy scoping, so a stranded report sends its approvals to the wrong person.
--
-- Same disease as the rest of this series: the seat model was RIGHT the whole time
-- (SEAT-AIF-NSM occupied by AI-0008, the DM seats are its children) and only the denormalized
-- copy on `employees` was wrong. The permanent fix is to derive the copy from the seat whenever
-- occupancy changes, rather than maintaining it by hand.
--
-- The one-off correction of the 11 stranded rows was applied to production by hand under owner
-- approval (2026-08-05), each row audited as `employee_manager_reassignment` with before/after.
-- This migration installs the mechanism so it cannot recur.
--
-- Deliberately NOT done here: the marker is only cleared when the employee's OWN manager seat is
-- occupied. The 5 Upper Egypt 2 reps keep their `B-175` marker because SEAT-AIF-DM-UE-2 is still
-- genuinely vacant — that marker is what keeps reporting views grouping them under the vacant DM
-- seat instead of rendering them as direct NSM reports.
--
-- Data impact of this migration: none (one function + one trigger).
-- Rollback:
--   drop trigger if exists trg_au_reclaim_reports_on_manager_hire on au.occupancy_history;
--   drop function if exists public.au_reclaim_reports_on_manager_hire();

create or replace function public.au_reclaim_reports_on_manager_hire()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_child record;
  v_count integer := 0;
begin
  -- Only when a seat becomes OCCUPIED by a person. A vacate writes effective_to, and a
  -- vacant_placeholder row carries a null occupant; neither should reclaim anything.
  if new.occupant_hr_id is null or new.effective_to is not null then
    return null;
  end if;

  -- Every seat directly beneath this one: its occupant now reports to the new arrival.
  for v_child in
    select o.occupant_hr_id as child_hr_id
      from au.seats s
      join au.occupancy_history o on o.seat_id = s.seat_id
     where s.parent_seat_id = new.seat_id
       and o.effective_to is null
       and o.occupant_hr_id is not null
       -- An acting DM occupies both the manager seat and their own rep seat beneath it; they
       -- must never become their own manager.
       and lower(btrim(o.occupant_hr_id)) is distinct from lower(btrim(new.occupant_hr_id))
  loop
    begin
      update public.employees
         set manager_hr_id = new.occupant_hr_id,
             -- Their own manager seat is now filled, so the "awaiting a replacement" marker is
             -- satisfied and must not linger as debris.
             pending_manager_replacement_for_hr_id = null,
             updated_at = now()
       where lower(btrim(hr_id)) = lower(btrim(v_child.child_hr_id))
         and (upper(coalesce(manager_hr_id, '')) is distinct from upper(new.occupant_hr_id)
              or pending_manager_replacement_for_hr_id is not null);

      if found then
        v_count := v_count + 1;
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values (
          'system', 'employee_manager_reassignment', v_child.child_hr_id,
          format('Reclaimed by %s on hire into seat %s', new.occupant_hr_id, new.seat_id),
          jsonb_build_object(
            'managerHrId', new.occupant_hr_id,
            'seatId', new.seat_id,
            'trigger', 'au_reclaim_reports_on_manager_hire'
          )
        );
      end if;
    exception when others then
      -- A reporting-line sync must never fail a hire; the drift detector will surface anything
      -- this could not apply.
      null;
    end;
  end loop;

  return null;
end;
$function$;

revoke execute on function public.au_reclaim_reports_on_manager_hire() from public, anon, authenticated;
grant execute on function public.au_reclaim_reports_on_manager_hire() to service_role;

drop trigger if exists trg_au_reclaim_reports_on_manager_hire on au.occupancy_history;
create trigger trg_au_reclaim_reports_on_manager_hire
after insert on au.occupancy_history
for each row
execute function public.au_reclaim_reports_on_manager_hire();

-- ---------------------------------------------------------------------------
-- The drift detector: whatever cannot be auto-derived must be VISIBLE, not silent.
-- Every remaining disagreement between the employee copy and the seat model shows up here.
-- ---------------------------------------------------------------------------

create or replace view public.au_v_employee_seat_drift as
with seated as (
  select oh.occupant_hr_id as hr_id, s.seat_id, s.seat_tier, s.line_code, s.area_code, s.parent_seat_id
  from au.occupancy_history oh
  join au.seats s on s.seat_id = oh.seat_id
  where oh.effective_to is null and oh.occupant_hr_id is not null
)
select
  e.hr_id,
  e.full_name,
  se.seat_id,
  se.seat_tier,
  ar.id                          as seat_area_id,
  e.area_id                      as employee_area_id,
  ar.name                        as seat_area_name,
  e.area_name                    as employee_area_name,
  lam.operational_region_code    as seat_region_code,
  e.region_code                  as employee_region_code,
  parent_occ.occupant_hr_id      as seat_manager_hr_id,
  e.manager_hr_id                as employee_manager_hr_id,
  e.pending_manager_replacement_for_hr_id as pending_marker,
  (se.seat_tier = 'REP' and ar.id is not null and e.area_id is distinct from ar.id)         as area_id_drifted,
  (se.seat_tier = 'REP' and ar.name is not null
     and coalesce(e.area_name, '') is distinct from coalesce(ar.name, ''))                  as area_name_drifted,
  (se.seat_tier = 'REP' and lam.operational_region_code is not null
     and coalesce(e.region_code, '') is distinct from coalesce(lam.operational_region_code, '')) as region_code_drifted,
  -- An acting DM occupies both the manager seat and their own rep seat beneath it, so their rep
  -- seat's "manager" resolves to themselves. That is not drift — nobody manages themselves — and
  -- their real manager is the one above the acting seat.
  (parent_occ.occupant_hr_id is not null
     and lower(btrim(parent_occ.occupant_hr_id)) is distinct from lower(btrim(e.hr_id))
     and upper(coalesce(e.manager_hr_id, '')) is distinct from upper(parent_occ.occupant_hr_id)) as manager_drifted,
  (parent_occ.occupant_hr_id is not null
     and lower(btrim(parent_occ.occupant_hr_id)) is distinct from lower(btrim(e.hr_id))
     and e.pending_manager_replacement_for_hr_id is not null) as stale_marker
from seated se
join public.employees e on upper(btrim(e.hr_id)) = upper(btrim(se.hr_id))
left join public.areas ar on ar.code = se.area_code and ar.is_active
left join au.line_area_map lam
       on lam.line_code = se.line_code and lam.area_code = se.area_code and lam.effective_to is null
left join lateral (
  select o.occupant_hr_id
    from au.occupancy_history o
   where o.seat_id = se.parent_seat_id and o.effective_to is null and o.occupant_hr_id is not null
   limit 1
) parent_occ on true
where lower(coalesce(e.employment_status, '')) = 'active';

comment on view public.au_v_employee_seat_drift is
  'Every active seated employee whose denormalized employees columns disagree with the au seat model. The seat is the source of truth; a true flag here means the copy is wrong, not the seat. Filter on the *_drifted / stale_marker booleans.';

revoke all on public.au_v_employee_seat_drift from public, anon, authenticated;
grant select on public.au_v_employee_seat_drift to service_role;
