-- Ivyronc's five formula gaps, closed: three excipients from the order calculator, the aluminium
-- seal at one per bottle, and the scrapped old leaflet taken out of consideration altogether.
--
-- Owner, 2026-10-08: "fill Ivyronc's five missing formula lines from the order calculator sheet."
-- Measured on production the same night, Ivyronc linked 14 materials but carried only 8 composition
-- lines in force, so its buy list silently understated FIVE materials — not the one a memory note
-- claimed. The gap was found while verifying Guamusin, which has no gap: 12 materials, 12 lines.
--
-- THE SOURCE FOR THE THREE EXCIPIENTS IS `xlsx/Ivyronc - order calculator and stock ledger.xlsx`,
-- sheet "Per batch", column B "Per 5 ml (gram)". Two sibling workbooks in `xlsx/` are named
-- "SUPERSEDED - do not use" and were not read for any figure here.
--
--     Xanthan Gum (pharma grade)   0.005   g per 5 ml dose
--     Citric acid anhydrous        0.005   g per 5 ml dose
--     Liquid Lemon Flavor          0.0035  g per 5 ml dose
--
-- WHY THOSE NUMBERS NEED NO CONVERSION: all three materials carry `base_unit = 'g'` with
-- `base_per_display = 1000`, and every composition in this module stores BASE units. The sheet's
-- column is already grams per dose, so it is written through unchanged — which is also why the
-- three lines already in force match their own sheet cells exactly (ivy extract 0.035, sorbitol 2,
-- potassium sorbate 0.0067). Contrast Guamusin's aluminium film, where 0.018 *kg* per box had to
-- become 18 g: there the sheet's unit was not the base unit.
--
-- WHY `overage_pct` IS LEFT NULL RATHER THAN SET: null inherits the module's 3% default, which is
-- exactly what the sheet applies ("Loss / overage 0.03", and its "Per batch +3%" column). All of
-- Ivyronc's existing lines are null for the same reason. Guamusin's rows carry an explicit 0
-- because the owner asked for its waste left alone until a real run measures one — that is a
-- Guamusin decision and must not be copied here.
--
-- WHY THE SUPPLIERS DIFFER, AND WHY TWO ARE DELIBERATELY `shared_unsettled`:
--   · Citric acid is `factory`. The sheet puts it under "The FACTORY supplies these - nothing for
--     you to send", and the Settled tab answers "Comes from the factory". Shown, never bought.
--   · Xanthan gum and lemon flavour are `shared_unsettled`. Both sit under "Sometimes you,
--     sometimes the factory - settle with EGPI before the run starts", both are noted "Either side
--     can supply", and the sheet's own "YOU WILL SEND" cell is BLANK for each — nobody has settled
--     them. `shared_unsettled` is the honest record of that: the requirement is shown, and it
--     contributes nothing to the buy list until somebody settles it. Writing `sato` would invent a
--     purchase he has not agreed to; writing `factory` would hide one he may still owe.
--     `prodplan_plan_lines` refuses that supplier, so a plan cannot be COMMITTED until he settles.
--
-- THE ALUMINIUM SEAL IS ONE PER BOTTLE FROM THE FACTORY — HIS ANSWER, 2026-10-08, ASKED BECAUSE
-- THE WORKBOOK DOES NOT SAY. The Settled tab puts the seal outside the sheet with the bottle and
-- the cap ("Outside this sheet - the factory supplies them"), so no quantity for it appears
-- anywhere, and this module's standing rule is that a material with no figure is never given a
-- guessed one. He was asked and chose one per bottle from the factory, which is exactly how its two
-- trio-mates are already recorded. `per_packaging_set` is the basis they use, and on Ivyronc one
-- packaging set IS one bottle (`units_per_box = 1`), so per-set, per-box and per-bottle coincide.
-- `unit_kind` is `count` because the composite FK `(material_id, unit_kind)` demands the material's
-- own kind, and `prodplan_compositions_count_whole_check` demands a whole number for a count.
--
-- THE OLD LEAFLET IS DEACTIVATED, NOT GIVEN A LINE — "100% forget about the old leaflet. Only
-- consider the new one" (owner, 2026-10-08, asked). `LEAFLET_OLD` holds 68,250 pieces the Settled
-- tab calls scrapped ("New leaflet only - the 68,250 old ones are scrapped"), so a formula line
-- would demand 115,875 leaflets that are being thrown away. Deactivating the MATERIAL is the
-- precedent its own family already set: the pre-split `LEAFLET` is `is_active = false` with its
-- link left in place, and `service.ts` reads materials with `.eq("is_active", true)`, so the row
-- and its 68,250 stop reaching the screen at all. 🔴 THE STOCK ROW IS DELIBERATELY KEPT — the
-- 68,250 is the written-off quantity, and deleting it would destroy the record of the write-off
-- rather than hide it. `LEAFLET_NEW` is untouched and stays the only leaflet in the formula.
--
-- WHAT IT MEANS FOR THE ORDER (9 batches, the sheet's first order): one run is 1,250,000 ml at 5 ml
-- a dose = 250,000 doses, so 0.005 g/dose is 1.25 kg a batch and 0.0035 g/dose is 0.875 kg. Across
-- 9 batches with 3% overage that is 11.5875 kg of xanthan gum, 11.5875 kg of citric acid and
-- 8.11125 kg of lemon flavour — the sheet's own "NEEDED for the whole order" cells, reproduced by
-- the engine rather than restated. Nothing is held at EGPI for any of the three (stock reads 0), so
-- the two unsettled ones are the whole of what settling with EGPI decides. The seal is the
-- factory's, so it shows 115,875 needed and is never bought.
--
-- 🔴 THE `not exists` GUARD IS NOT DECORATION. A second open composition line for one material
-- DOUBLES its requirement on every plan while each row still looks ordinary — the defect the
-- LEAFLET split was written to avoid. Each insert below is idempotent on its own material:
-- re-running this file cannot create a second line, and it declines per material if one is in
-- force. The `update` is idempotent by nature.
--
-- To revert: delete the four rows this creates and switch the old leaflet back on.
--   delete from public.prodplan_compositions c
--    using public.prodplan_products p, public.prodplan_materials m
--    where c.product_id = p.id and c.material_id = m.id
--      and p.code = 'IVYRONC'
--      and m.code in ('XANTHAN_GUM', 'CITRIC_ACID_ANH', 'LEMON_FLAVOUR', 'ALUMINIUM_SEAL')
--      and c.effective_from = date '2026-10-08';
--   update public.prodplan_materials set is_active = true where code = 'LEAFLET_OLD';

begin;

-- 1. The three excipients his order calculator states, in grams per 5 ml dose.
insert into public.prodplan_compositions
       (product_id, material_id, unit_kind, basis, qty_per_basis, overage_pct, supplier,
        effective_from, effective_to, notes)
select p.id,
       m.id,
       'mass',
       'per_dose',
       spec.qty_per_dose_g,
       null,
       spec.supplier,
       date '2026-10-08',
       null,
       spec.note
  from public.prodplan_products p,
       public.prodplan_materials m,
       (values
          ('XANTHAN_GUM',     0.005000, 'shared_unsettled',
           'Xanthan gum 0.005 g per 5 ml dose, from the order calculator; either side may supply'),
          ('CITRIC_ACID_ANH', 0.005000, 'factory',
           'Citric acid anhydrous 0.005 g per 5 ml dose, from the order calculator; EGPI supplies it'),
          ('LEMON_FLAVOUR',   0.003500, 'shared_unsettled',
           'Liquid lemon flavour 0.0035 g per 5 ml dose, from the order calculator; either side may supply')
       ) as spec (material_code, qty_per_dose_g, supplier, note)
 where p.code = 'IVYRONC'
   and m.code = spec.material_code
   and not exists (
     select 1
       from public.prodplan_compositions c
      where c.product_id = p.id
        and c.material_id = m.id
        and c.effective_to is null
   );

-- 2. The aluminium seal: one per bottle, brought by the factory. His answer, not the workbook's.
insert into public.prodplan_compositions
       (product_id, material_id, unit_kind, basis, qty_per_basis, overage_pct, supplier,
        effective_from, effective_to, notes)
select p.id,
       m.id,
       'count',
       'per_packaging_set',
       1.000000,
       null,
       'factory',
       date '2026-10-08',
       null,
       'One aluminium seal per bottle, brought by the factory with the bottle and the cap'
  from public.prodplan_products p,
       public.prodplan_materials m
 where p.code = 'IVYRONC'
   and m.code = 'ALUMINIUM_SEAL'
   and not exists (
     select 1
       from public.prodplan_compositions c
      where c.product_id = p.id
        and c.material_id = m.id
        and c.effective_to is null
   );

-- 3. The scrapped old leaflet leaves the planner. Its stock row stays as the write-off record.
update public.prodplan_materials
   set is_active = false,
       updated_at = now()
 where code = 'LEAFLET_OLD'
   and is_active;

commit;
