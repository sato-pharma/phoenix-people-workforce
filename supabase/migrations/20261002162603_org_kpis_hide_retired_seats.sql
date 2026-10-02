-- org_kpis_hide_retired_seats
--
-- WHAT THIS CHANGES:
--   Rebuilds the au.v_org_structure_kpis view so it counts ONLY the seats that
--   au.v_org_tree surfaces, by selecting from the tree instead of scanning au.seats raw.
-- WHY:
--   The KPI view scanned au.seats with no retired-seat filter, while au.v_org_tree was
--   given one in 20260909234500_org_tree_hides_retired_seats.sql. So a retired seat still
--   counted here: SEAT-PED-DM-UE (retired 2026-09-01 in the Pedia Upper-Egypt UE-1/UE-2
--   split) was reported as a vacant Pedia DM, inflating Pedia DM to total 9 / vacant 3 when
--   the live tree is 8 / 2. Defining the KPI view ON TOP of the tree makes the two views
--   structurally unable to diverge again (the tree hides retired seats and their whole
--   subtree recursively). Confirmed read-only on production: the only change is Pedia DM
--   9/3 -> 8/2; every other line and tier is unchanged.
-- ROLLBACK:
--   create or replace view, selecting from au.seats s LEFT JOIN au.occupancy_history o
--   (o.seat_id = s.seat_id AND o.effective_to IS NULL) with no is_active/effective_to filter
--   (the pre-image definition). This is a view-only change — no data is touched, so the
--   rollback is a plain redefinition.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: it redefines one read-only view and writes no rows.

begin;

create or replace view au.v_org_structure_kpis as
select coalesce(t.line_code, '(root)'::text) as line_code,
       t.seat_tier,
       count(*)                                  as total,
       count(*) filter (where not t.is_vacant)   as filled,
       count(*) filter (where t.is_vacant)       as vacant
  from au.v_org_tree t
 group by t.line_code, t.seat_tier;

commit;
