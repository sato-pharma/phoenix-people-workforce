-- luxor_separate_from_qena2_no_rep_seat
--
-- WHAT THIS CHANGES:
--   Clears rep_seat_id on the current Pedia Luxor (OT6) area-map row, so Luxor no longer
--   shares the Qena 2 rep seat (SEAT-PED-REP-UE8). Luxor STAYS in Upper Egypt 2 under the
--   UE-2 DM, other_permanent, carries no target, and still takes its El Qema share — only the
--   shared rep-seat link is removed. Nothing else on the row changes.
-- WHY:
--   Owner decision 2026-10-02: "separate Qena 2 from Luxor, normally as it was." The 2026-09-09
--   split migration (20260909223000) ORIGINALLY set this row to rep_seat_id = NULL ("Luxor ...
--   has no rep of its own"), matching the pinned Upper-Egypt golden rule (tests/pedia-upper-egypt-split.test.ts:
--   "Luxor ... joins Upper Egypt 2 as other_permanent with no rep seat"). A later direct production
--   write on 2026-09-11 set rep_seat_id = SEAT-PED-REP-UE8 to credit the Qena 2 rep for Luxor's
--   sales — a divergence from both the migration and the golden rule, and the row the occupancy
--   reconciler flags as other_row_with_rep_seat. This restores the tracked state. September 2026 is
--   unpublished and unlocked, so no published month is altered; the attribution rollup re-stamps
--   for open periods afterward (published months stay frozen).
-- ROLLBACK:
--   update au.line_area_map set rep_seat_id = 'SEAT-PED-REP-UE8'
--     where line_code='pedia' and area_code='OT6' and effective_to is null;
--   (pre-image preserved in au.bak_20261002_luxor_rep_seat_revert). View/data only — no schema change.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one field on one row, fully reversible, pre-image kept.

begin;

-- Pre-image snapshot (au schema, never public). Idempotent: created once, never overwritten.
create table if not exists au.bak_20261002_luxor_rep_seat_revert as
  select * from au.line_area_map
  where line_code='pedia' and area_code='OT6' and effective_to is null;

-- The revert. Guarded on the drifted value so it is a no-op on a database already at the
-- golden-rule state (and so it never touches any other row).
update au.line_area_map
set rep_seat_id = null,
    notes = 'Upper Egypt split, owner-approved 2026-09-09. Luxor is with Qena 2 and is NOT a separate area: it joins Upper Egypt 2 but carries no target and has no rep of its own. 2026-10-02: owner reverted the 2026-09-11 shared-rep-seat union — Qena 2 and Luxor are separated again; Luxor has no rep seat (restores the 2026-09-09 migration state). Pre-image in au.bak_20261002_luxor_rep_seat_revert.'
where line_code='pedia' and area_code='OT6' and effective_to is null
  and rep_seat_id = 'SEAT-PED-REP-UE8';

commit;
