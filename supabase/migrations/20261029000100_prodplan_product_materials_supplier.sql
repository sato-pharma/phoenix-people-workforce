-- prodplan_product_materials_supplier
--
-- WHAT THIS CHANGES: adds prodplan_product_materials.supplier — who brings a product's material
--   when no formula line is in force for it — and fills it for the three Royanoxicam 8 mg materials
--   that have no line: the aluminium blister foil is Sato's, the purified water and the ethyl
--   alcohol are the factory's.
-- WHY: the owner, 2026-10-29: "In Roya Noxicam tablet, we only supply the active material, Laura
--   Noxicam boxes, pamphlet, and aluminium foil only. We don't supply inactive materials." The ten
--   excipients already carry 'factory' on their formula lines, and Lornoxicam, the box and the
--   leaflet carry 'sato'. The foil has no line on purpose (2026-10-21: "leave empty for now"), so the
--   screen could not tell it was Sato's and listed it with the factory's materials on the Cost and
--   Stock tabs. Water and alcohol never get a line (Q.S., they evaporate) and read as gaps.
--   A line in force always wins over this column; it only answers when there is no line.
-- ROLLBACK: alter table public.prodplan_product_materials drop column supplier;
--   (the screen falls back to "formula not entered" for a material with no line, as before)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one added nullable column, and three rows updated.

begin;

alter table public.prodplan_product_materials
  add column if not exists supplier text null;

alter table public.prodplan_product_materials
  drop constraint if exists prodplan_product_materials_supplier_check;
alter table public.prodplan_product_materials
  add constraint prodplan_product_materials_supplier_check
  check (supplier is null or supplier in ('sato', 'factory', 'shared_unsettled'));

comment on column public.prodplan_product_materials.supplier is
  'Who brings this material for this product when NO formula line is in force for it. A line in force always wins. Null means nobody has said.';

update public.prodplan_product_materials pm
   set supplier = 'sato'
  from public.prodplan_products p, public.prodplan_materials m
 where pm.product_id = p.id
   and pm.material_id = m.id
   and p.code = 'ROYANOXICAM'
   and m.code = 'BLISTER_ALU_ROYANOXICAM';

update public.prodplan_product_materials pm
   set supplier = 'factory'
  from public.prodplan_products p, public.prodplan_materials m
 where pm.product_id = p.id
   and pm.material_id = m.id
   and p.code = 'ROYANOXICAM'
   and m.code in ('PURIFIED_WATER', 'ETHYL_ALCOHOL');

commit;
