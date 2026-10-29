-- production_planning_carvibradine_link_suppliers
--
-- WHAT THIS CHANGES: fills prodplan_product_materials.supplier for the four Carvibradine materials
--   that have no formula line: the aluminium blister foil is Sato's, the purified water, the ethyl
--   alcohol and the absolute ethanol are Hochster's.
-- WHY: the owner, 2026-10-29: "In Carvibradine T we supply Carvidilol, Ivabradine, Pumphlet, Boxes &
--   aluminium Foil". Carvedilol, ivabradine, the leaflet and the box carry 'sato' on their formula
--   lines and the ten excipients carry 'factory'. The foil has no line (its weight per box is not on
--   Hochster's papers) and the three solvents never get one (Q.S., they evaporate), so without this
--   the screen lists the foil with the factory's materials and the solvents as formula gaps — the
--   same fix 20261029000100 made for Royanoxicam. The supplier lives on the PRODUCT link, so
--   Royanoxicam's rows for the shared water and alcohol are not touched.
--   A line in force always wins over this column; it only answers when there is no line.
-- ROLLBACK: update public.prodplan_product_materials pm set supplier = null
--   from public.prodplan_products p where pm.product_id = p.id and p.code = 'CARVIBRADINE';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: four rows updated.

begin;

update public.prodplan_product_materials pm
   set supplier = 'sato'
  from public.prodplan_products p, public.prodplan_materials m
 where pm.product_id = p.id
   and pm.material_id = m.id
   and p.code = 'CARVIBRADINE'
   and m.code = 'BLISTER_ALU_CARVIBRADINE';

update public.prodplan_product_materials pm
   set supplier = 'factory'
  from public.prodplan_products p, public.prodplan_materials m
 where pm.product_id = p.id
   and pm.material_id = m.id
   and p.code = 'CARVIBRADINE'
   and m.code in ('PURIFIED_WATER', 'ETHYL_ALCOHOL', 'ABSOLUTE_ETHANOL');

commit;
