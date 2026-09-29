-- ---------------------------------------------------------------------------
-- The last denormalized label on public.employees: area_name.
--
-- Three columns on this table duplicated a link beside them. Measured on production 2026-09-29,
-- across all 198 employees:
--
--   line_name         1 populated   line_id        181
--   department_name   0 populated   department_id  180
--   area_name       145 populated   area_id        174
--
-- The first two were dropped earlier the same day. area_name is the one that LOOKED alive, and this
-- is the measurement that settles it, taken immediately before this migration:
--
--     0 rows carry a label with no link  -> the label can never answer where the link cannot
--     4 rows carry both and DISAGREE     -> two read "Fayoum-Beni Suef", that territory's name from
--                                           BEFORE the split, against the link's "Fayoum"; two read
--                                           "ALEX-BHR" against the canonical "Alex-BHR"
--
-- A pre-image of hr_id, full_name, area_id and area_name for all 198 rows is taken below before the
-- column goes, and a copy of those four disagreements is in the PR.
--
-- ORDER MATTERS, TWICE OVER:
--
--   1. The APP had to stop naming the column first, and be serving. PostgREST answers a missing
--      column with an ERROR and fails the whole read, so the DDL would turn every employee read in
--      the app into a 42703 the moment it ran.
--   2. public.au_v_employee_seat_drift selects e.area_name, so the column cannot be dropped while
--      that view exists. It is rebuilt WITHOUT the label first. No CASCADE anywhere: cascade would
--      have deleted the view rather than refusing, and a dropped view is silent until something
--      reads it.
--
-- The rebuild also removes `area_name_drifted`, the flag derived from the label. It fired on 16 of
-- the 94 seated actives while `area_id_drifted` — the same comparison against the LINK — fired on
-- 0: every one of the 16 was a missing or stale label on a person whose seat and area link agree.
-- Nothing in the app read either that flag or the `employee_area_name` column (the four readers
-- take hr_id, full_name, seat_id, seat_tier, seat_area_name, seat_region_code, seat_manager_hr_id).
-- ---------------------------------------------------------------------------

-- Rollback material for the column, kept beside the earlier two.
create table if not exists public.employees_area_label_preimage_20260929 as
select hr_id, full_name, area_id, area_name
from public.employees;

-- ---------------------------------------------------------------------------
-- 1. The drift view, without the label and the flag derived from it.
--    create or replace cannot remove an output column, so this is a drop and a rebuild — which
--    means the grants are recreated too, or a service-role-only view would be born readable.
-- ---------------------------------------------------------------------------

drop view if exists public.au_v_employee_seat_drift;

create view public.au_v_employee_seat_drift as
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
  lam.operational_region_code    as seat_region_code,
  e.region_code                  as employee_region_code,
  parent_occ.occupant_hr_id      as seat_manager_hr_id,
  e.manager_hr_id                as employee_manager_hr_id,
  e.pending_manager_replacement_for_hr_id as pending_marker,
  -- The area check that survives: the LINK against the seat. It reports 0 today, where the label
  -- version reported 16 false ones.
  (se.seat_tier = 'REP' and ar.id is not null and e.area_id is distinct from ar.id)         as area_id_drifted,
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
  'Every active seated employee whose denormalized employees columns disagree with the au seat model. The seat is the source of truth; a true flag here means the copy is wrong, not the seat. Filter on the *_drifted / stale_marker booleans. The area_name label and its area_name_drifted flag were removed on 2026-09-29 with the column: area_id_drifted is the area check.';

revoke all on public.au_v_employee_seat_drift from public, anon, authenticated;
grant select on public.au_v_employee_seat_drift to service_role;

-- ---------------------------------------------------------------------------
-- 2. The columns themselves. Nothing else depends on either — the dependency sweep ran with
--    public.employees.hr_id (99 entries) as its positive control, so an empty result meant empty.
--
-- 🔴 department_name IS HERE A SECOND TIME, AND THAT IS THE WHOLE LESSON OF THIS CHANGE.
-- It was dropped earlier on 2026-09-29 after a grep-based census of the reads — and the census
-- missed `src/lib/reports/organogram-au-source.ts`, which named it in a 16-column select and
-- DISCARDED the error. PostgREST failed that whole read, so from the moment the column went, every
-- occupied seat on the organogram lost its occupant: names rendered as HR IDs and a seated District
-- Manager rendered as a vacancy. The owner saw it before any check did. The column was re-added as
-- an empty text column to restore the page within seconds (it held 0 of 198 values, so nothing was
-- lost or restored but the column itself), and it goes again here, with the corrected reads live.
--
-- The guard that now makes this safe is a TREE-WIDE scan in tests/employee-line-is-read-from-the-
-- link.test.ts: it walks src/ and app/, anchors on `.from("employees")`, and resolves a select
-- passed as a CONSTANT rather than a literal — which is how admin/test-accounts.ts hid one too.
-- ---------------------------------------------------------------------------

alter table public.employees drop column if exists area_name;
alter table public.employees drop column if exists department_name;
