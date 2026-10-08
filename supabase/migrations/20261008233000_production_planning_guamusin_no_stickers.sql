-- Guamusin has NO stickers, and its batch is a WEIGHT.
--
-- Owner, 2026-10-08, after looking at the shipped screen: *"guamusin have no stickers"*. This
-- CORRECTS his earlier message of the same day — *"package material no expiry date \Aluminum ,boxes
-- & stickers"* — which named three packaging items and is why `STICKER_GUAMUSIN` was seeded with a
-- `per_box` composition row in 20261008210000. His later word wins.
--
-- 🔴 WHY THIS IS NOT COSMETIC: the sticker carried a LIVE `per_box` composition line, so every
-- Guamusin plan was putting 10,000 stickers on the buy list — a real quantity of a material he does
-- not buy for this product, against a 6-run order. It never reached a purchase because the material
-- holds no stock row and no price, but the line was on the sheet and in the buy list.
--
-- The material row is DEACTIVATED rather than deleted, which is this module's standing practice (see
-- the LEAFLET split, 2026-10-06): a delete would make his original three-item packaging message
-- unreadable against the data, and a reactivation could not then be told from a fresh seeding. What
-- is REMOVED is the composition line and the product join — the two things that put it on a buy
-- list. Nothing touches Ivyronc, whose own sticker is a real material with a real formula line.
--
-- To revert: re-insert the join and the composition row, and set is_active = true:
--   insert into public.prodplan_product_materials (product_id, material_id)
--     select p.id, m.id from public.prodplan_products p, public.prodplan_materials m
--      where p.code = 'GUAMUSIN' and m.code = 'STICKER_GUAMUSIN';
--   insert into public.prodplan_compositions (product_id, material_id, basis, qty, overage_pct,
--                                             supplier, effective_from)
--     select p.id, m.id, 'per_box', 1, 0, 'sato', '2026-01-01'
--       from public.prodplan_products p, public.prodplan_materials m
--      where p.code = 'GUAMUSIN' and m.code = 'STICKER_GUAMUSIN';
--   update public.prodplan_materials set is_active = true where code = 'STICKER_GUAMUSIN';

begin;

-- 1. The composition line — the one thing that puts a material on a buy list.
delete from public.prodplan_compositions c
 using public.prodplan_products p, public.prodplan_materials m
 where c.product_id = p.id
   and c.material_id = m.id
   and p.code = 'GUAMUSIN'
   and m.code = 'STICKER_GUAMUSIN';

-- 2. The product join, so the material cannot appear on Guamusin's materials list at all.
delete from public.prodplan_product_materials pm
 using public.prodplan_products p, public.prodplan_materials m
 where pm.product_id = p.id
   and pm.material_id = m.id
   and p.code = 'GUAMUSIN'
   and m.code = 'STICKER_GUAMUSIN';

-- 3. The material itself stays, deactivated. It has no stock row and no price, so there is nothing
--    to close at zero — unlike the retired combined LEAFLET, which did.
update public.prodplan_materials
   set is_active = false
 where code = 'STICKER_GUAMUSIN';

commit;
