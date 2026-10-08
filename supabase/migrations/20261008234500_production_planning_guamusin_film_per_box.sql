-- The aluminium sachet film finally has its formula line: 0.018 kg per box of 12 sachets.
--
-- Owner, 2026-10-08, answering the one question the corrected spec sheet
-- (`xlsx/Guamusin-data-checked.xlsx`, Product tab, question 5) had left open since that morning —
-- "Kilograms of aluminum film per 1,000 sachets … STILL OPEN, and only DBK can answer it". He sent
-- DBK's own table, headed **Quantity Aluminum / box**, reading **0.018**, and confirmed the basis
-- when asked: 0.018 kg per box of twelve. He also identified the 16,667 beside it as the boxes per
-- run, not a stock figure, so the 230.95 kg at DBK is unchanged and no stock row is touched here.
--
-- WHY `per_box` AND NOT `per_dose`: that is the basis he gave, in his own caption, and it is the
-- figure anyone can check against his sheet. The two are the same quantity today — 18 g per box of
-- 12 is 1.5 g per sachet, and both make the 6-run order 180 kg — so recording his number on his
-- basis costs nothing and keeps the row auditable against the source. Guamusin has no free samples,
-- so good units, packaging sets and sachets are one and the same count.
--
-- WHY THE UNIT IS GRAMS: `prodplan_materials.base_unit` for this film is `g` with
-- `base_per_display = 1000`, and every composition in this module stores BASE units — the ten
-- powders are `per_dose` in grams and sum to exactly 5.000 g, which is the 5 g sachet. 0.018 kg is
-- therefore 18 g. Writing 0.018 here would ask DBK for 18 grams of film for the whole order.
--
-- WHAT IT MEANS FOR THE BUY LIST: 6 runs = 120,000 sachets = 10,000 boxes × 18 g = 180,000 g
-- = 180 kg, against 230.95 kg held at DBK. So this order needs no film purchase and leaves
-- 50.95 kg. The film stops being the one material with stock and no requirement.
--
-- 🔴 THE `not exists` GUARD IS NOT DECORATION. A second open composition line for one material
-- DOUBLES its requirement on every plan while each row still looks ordinary — that is exactly the
-- defect the LEAFLET split was written to avoid. This insert is therefore idempotent: re-running it
-- cannot create a second line, and it declines to run at all if a line is already in force.
--
-- To revert: close or delete the row this creates.
--   delete from public.prodplan_compositions c
--    using public.prodplan_products p, public.prodplan_materials m
--    where c.product_id = p.id and c.material_id = m.id
--      and p.code = 'GUAMUSIN' and m.code = 'SACHET_FILM_ALU'
--      and c.effective_from = date '2026-10-08';

begin;

insert into public.prodplan_compositions
       (product_id, material_id, unit_kind, basis, qty_per_basis, overage_pct, supplier,
        effective_from, effective_to, notes)
select p.id,
       m.id,
       'mass',
       'per_box',
       18.000000,
       0,
       'sato',
       date '2026-10-08',
       null,
       '0.018 kg of aluminium film per box of 12 sachets, from DBK'
  from public.prodplan_products p,
       public.prodplan_materials m
 where p.code = 'GUAMUSIN'
   and m.code = 'SACHET_FILM_ALU'
   and not exists (
     select 1
       from public.prodplan_compositions c
      where c.product_id = p.id
        and c.material_id = m.id
        and c.effective_to is null
   );

commit;
