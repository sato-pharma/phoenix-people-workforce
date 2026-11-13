-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — a committed plan line may carry the basis 'per_run_measured'.
--
-- WHAT: widens prodplan_plan_lines_basis_check by one value, 'per_run_measured'. Nothing else.
--
-- WHY: a Sato material with NO formula line now takes its amount from the product's own recorded
-- runs — what one batch really consumed (opening + delivered − closing ÷ batches). Royafloxacin
-- review, 2026-11-13: "leave the aluminum consumption field blank and calculate it based on the
-- actual consumption after production is completed". When such a plan is committed, its line is
-- snapshotted with basis 'per_run_measured' and the measured per-batch quantity, so the committed
-- plan keeps the foil it bought. The old check refused that value, so the line would have been
-- dropped from the snapshot.
--
-- prodplan_compositions keeps its own check unchanged: a formula line can never be 'per_run_measured'
-- — the measured amount is read at plan time, never stored as a line.
--
-- ROLLBACK (by hand, only while no line carries the new value):
--   alter table public.prodplan_plan_lines drop constraint prodplan_plan_lines_basis_check;
--   alter table public.prodplan_plan_lines add constraint prodplan_plan_lines_basis_check
--     check (snap_basis = any (array['per_dose','per_packaging_set','per_good_unit','per_sample_unit','per_box','per_strip']));
--
-- Neither destructive nor bulk: one CHECK widened, no row touched.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

alter table public.prodplan_plan_lines drop constraint if exists prodplan_plan_lines_basis_check;
alter table public.prodplan_plan_lines add constraint prodplan_plan_lines_basis_check
  check (snap_basis = any (array[
    'per_dose'::text, 'per_packaging_set'::text, 'per_good_unit'::text, 'per_sample_unit'::text,
    'per_box'::text, 'per_strip'::text, 'per_run_measured'::text
  ]));

commit;
