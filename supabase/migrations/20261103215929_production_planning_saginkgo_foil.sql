-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Production Planner — Saginkgo's aluminium foil gets its amount.
--
-- WHAT THIS CHANGES: sets Saginkgo's `strips_per_box` to 3, adds one formula line for its foil,
-- 0.761667 g a strip, Sato's, and corrects the foil's note, which said no amount was recorded.
--
-- WHY: owner, 2026-11-03: "0.002285 aluminum quaty per box and the box is 3 شرايط sample is one so
-- divide by 3". His figure is read as KILOGRAMS: the foil is bought by the kilogram, and 0.002285 g
-- could not cover a box. So 2.285 g a box of 3 strips, and 2.285 / 3 = 0.761666… g a strip, rounded UP
-- to the 6 decimals the column holds, because a formula never under-orders. A batch with no samples
-- is 3,000 strips and 2,285.001 g raw: the rounding costs one milligram a batch.
--
-- 🔴 APPLY THIS ONE AFTER THE CODE IS LIVE. Older code does not know `per_strip`, and its read drops
-- a line whose basis it does not recognise.
--
-- ROLLBACK:
--   delete from public.prodplan_compositions c using public.prodplan_products p, public.prodplan_materials m
--    where c.product_id = p.id and c.material_id = m.id and p.code = 'SAGINKGO'
--      and m.code = 'BLISTER_ALU_SAGINKGO' and c.effective_from = date '2026-11-03';
--   update public.prodplan_products set strips_per_box = null where code = 'SAGINKGO';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one product, one material, one new formula line.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;

update public.prodplan_products
   set strips_per_box = 3
 where code = 'SAGINKGO';

update public.prodplan_materials
   set notes = 'Sato supplies it. Bought by the kilogram. 2.285 g a box of 3 strips, so one formula line per strip: a sample box is one strip. Packaging does not expire.'
 where code = 'BLISTER_ALU_SAGINKGO';

insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes
)
select p.id, m.id, m.unit_kind, v.basis, v.qty, v.supplier, date '2026-11-03', v.note
from public.prodplan_products p
join (values
  ('BLISTER_ALU_SAGINKGO', 'per_strip', 0.761667, 'sato', '2.285 g a box of 3 strips, divided by 3; a sample box is one strip')
) as v(code, basis, qty, supplier, note) on true
join public.prodplan_materials m on m.code = v.code
where p.code = 'SAGINKGO'
on conflict (product_id, material_id, effective_from) do nothing;

commit;

-- Timestamp 20261103215929 was minted to sort after every migration already on main.
