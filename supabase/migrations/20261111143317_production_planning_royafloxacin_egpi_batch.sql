-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Royafloxacin 500 mg at EGPI: EGPI's own batch (16,000 boxes) and its foil.
--
-- WHAT THIS CHANGES:
--   1. ROYAFLOXACIN_EGPI counts 160,000 tablets a batch = 16,000 boxes of 10 (2 strips of 5), in
--      place of the 94,380 that 20261111133401 worked out from "the same tablet as Medizen".
--      The batch still shows 80 kg and the tablet still shows 847.6 mg (the two display columns).
--      The count is stored at the 500 mg of levofloxacin a tablet carries, so the geometry is
--      exactly the factory's figure: 160,000 × 500 mg = 80,000,000 mg = 80 kg. The 815 mg core used
--      before cannot hold it: 160,000 × 815 = 130,400,000, over the run_volume_ml cap of 100,000,000.
--      No formula line is counted by weight (per tablet, per box, per strip or per sample), so the
--      dose figure moves no quantity: levofloxacin stays 512.5 mg a tablet = 82 kg a batch.
--      dose_ml 500 · good_unit_ml 500 · sample_unit_ml 1,000 (the 2-tablet sample box) ·
--      run_volume_ml 80,000,000.
--   2. The aluminium foil gets its amount: 25 kg a batch. A batch is 32,000 strips (16,000 boxes ×
--      2), so the line is 25,000 g / 32,000 = 0.78125 g a strip, per_strip like Saginkgo's foil.
--      A free sample box is one more strip, so samples add their own foil.
--
-- WHY: owner, 2026-11-11 ~14:30 Cairo: "For Royafloxacin 500 EGPI batch size is 80 kg (16000 Box of
-- 2 blisters 10 tab.) 25 kg Aluminium". 160,000 × 500 mg = 80 kg: the factory states its batch by the
-- levofloxacin it holds.
--
-- ROLLBACK (by hand):
--   update public.prodplan_products set run_volume_ml = 76919700, dose_ml = 815, good_unit_ml = 815,
--     sample_unit_ml = 1630 where code = 'ROYAFLOXACIN_EGPI';
--     -- (good_unit_ml first if a check refuses the order: good_unit_ml % dose_ml must be 0)
--   delete from public.prodplan_compositions c using public.prodplan_products p, public.prodplan_materials m
--     where c.product_id = p.id and c.material_id = m.id and p.code = 'ROYAFLOXACIN_EGPI'
--       and m.code = 'BLISTER_ALU_ROYAFLOXACIN' and c.effective_from = date '2026-11-11';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one product's geometry and one new formula line. No plan
-- names ROYAFLOXACIN_EGPI yet (0 rows in prodplan_plans, read before writing).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. EGPI's batch: 160,000 tablets, 16,000 boxes, shown as 80 kg ──────────────────────────────
-- One statement, so the checks (run % dose = 0, good % dose = 0, sample % dose = 0) see the final row.
update public.prodplan_products
set run_volume_ml = 80000000,
    dose_ml = 500,
    good_unit_ml = 500,
    sample_unit_ml = 1000,
    batch_weight_display = 80,
    unit_weight_display = 847.6,
    notes = 'Film-coated tablet, levofloxacin 500 mg, made at EGPI for Sato Pharma. One batch is 80 kg = 160,000 tablets = 16,000 boxes of 10 (2 strips of 5), EGPI''s own figure (owner, 2026-11-11). The 80 kg is the levofloxacin the batch holds (160,000 × 500 mg), so the engine counts at 500 mg a tablet; the coated tablet shows as 847.6 mg, the same tablet as Medizen''s. Levofloxacin hemihydrate 512.5 mg a tablet (82 kg a batch); aluminium foil 25 kg a batch. Only what Sato supplies is listed: levofloxacin, aluminium foil, boxes and leaflets, plus the free sample''s box (1 strip of 2 tablets).',
    updated_at = now()
where code = 'ROYAFLOXACIN_EGPI';

-- ── 2. The aluminium foil: 25 kg a batch = 0.78125 g a strip ────────────────────────────────────
insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, 'per_strip', 0.781250, 'sato', date '2026-11-11',
       '25 kg a batch of 16,000 boxes (32,000 strips): 0.78125 g a strip. EGPI''s figure, owner 2026-11-11.'
from public.prodplan_products p
join public.prodplan_materials m on m.code = 'BLISTER_ALU_ROYAFLOXACIN'
where p.code = 'ROYAFLOXACIN_EGPI'
on conflict (product_id, material_id, effective_from) do nothing;

commit;
