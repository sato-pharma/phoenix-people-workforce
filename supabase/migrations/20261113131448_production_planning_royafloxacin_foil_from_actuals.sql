-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royafloxacin 500 mg at EGPI: the aluminium foil's amount is left blank.
--
-- WHAT: closes ROYAFLOXACIN_EGPI's one formula line for BLISTER_ALU_ROYAFLOXACIN (0.78125 g a strip,
-- 25 kg a batch, opened 2026-11-11 by 20261111143317) at effective_to 2026-11-13. No row is deleted:
-- a line is closed, never removed, so a plan committed under it still reproduces. With no line in
-- force the foil reads Sato's (the product link's supplier), and its amount is taken from the
-- actual consumption of EGPI's recorded Royafloxacin batches once the first one is recorded
-- (src/lib/production-planning/learning.ts, measuredConsumptionByProduct). Until then it reads
-- "no amount entered", stays off the buy list, and the missing-data warning names it.
-- Medizen's Royafloxacin already has no foil line, so it is untouched.
--
-- WHY: the review "Revision of Royafloxacin 500 Production Data and Stock Settings", forwarded by the
-- owner 2026-11-13: "kindly leave the aluminum consumption field blank and calculate it based on
-- the actual consumption after production is completed."
--
-- ROLLBACK (by hand):
--   update public.prodplan_compositions c set effective_to = null
--   from public.prodplan_products p, public.prodplan_materials m
--   where c.product_id = p.id and c.material_id = m.id and p.code = 'ROYAFLOXACIN_EGPI'
--     and m.code = 'BLISTER_ALU_ROYAFLOXACIN' and c.effective_from = date '2026-11-11';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Neither destructive nor bulk: one row's effective_to set, fully reversible by the rollback above.
-- No plan names ROYAFLOXACIN_EGPI and no run is recorded for it (read before writing, 2026-11-13).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

update public.prodplan_compositions c
set effective_to = date '2026-11-13'
from public.prodplan_products p, public.prodplan_materials m
where c.product_id = p.id
  and c.material_id = m.id
  and p.code = 'ROYAFLOXACIN_EGPI'
  and m.code = 'BLISTER_ALU_ROYAFLOXACIN'
  and c.effective_from = date '2026-11-11'
  and c.effective_to is null;

commit;
