-- production_planning_guamusin_leaflet
--
-- WHAT THIS CHANGES: adds Guamusin's own leaflet — one new material (LEAFLET_GUAMUSIN), its link to
--   Guamusin alone, and one formula line: one leaflet per box, Sato supplies it.
-- WHY: the owner, 2026-11-03: "in production planner in guamusin no field for pamphlets". Guamusin
--   had no leaflet material at all, so its Planner, Stock, Cost and Settings tabs had no row for one.
--   Asked as a multiple choice, he answered "One per box": one leaflet in each carton of 12 sachets,
--   the basis Royanoxicam and Carvibradine already carry. Six runs are 10,000 boxes, so 10,000
--   leaflets, never 120,000. It is Guamusin's own material because artwork is not interchangeable
--   between products (the same reason its box is its own).
--
--   overage_pct is an explicit 0, like every other Guamusin line: he asked for the waste left empty
--   until a real run measures one, and a null would inherit the module's 3%.
--
--   NO stock row: nobody has reported a count. An absent row says "never counted"; a zero would say
--   "counted, and none". He types the count in the Stock tab. Packaging also carries no expiry date.
--
--   The insert is guarded against a second open line, because two open lines for one material double
--   its requirement on every plan while each row still reads as ordinary.
-- ROLLBACK:
--   delete from public.prodplan_compositions c using public.prodplan_materials m
--    where c.material_id = m.id and m.code = 'LEAFLET_GUAMUSIN';
--   delete from public.prodplan_product_materials pm using public.prodplan_materials m
--    where pm.material_id = m.id and m.code = 'LEAFLET_GUAMUSIN';
--   delete from public.prodplan_materials where code = 'LEAFLET_GUAMUSIN';
--   Only while no plan or stock entry names it; after that, retire it from the Settings tab instead.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: three rows added, none changed.

begin;

insert into public.prodplan_materials (
  code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
  is_imported, lead_time_days, sort_order, notes
)
values
  ('LEAFLET_GUAMUSIN', 'البروشور الداخلي — جواموسين', 'Leaflet — Guamusin', 'count', 'piece', 'piece', 1,
   false, null, 305,
   'Guamusin''s own leaflet. Sato supplies it. One per box of 12 sachets, the same basis the box itself carries.')
on conflict (code) do nothing;

insert into public.prodplan_product_materials (product_id, material_id, sort_order)
select p.id, m.id, 130
from public.prodplan_products p
join public.prodplan_materials m on m.code = 'LEAFLET_GUAMUSIN'
where p.code = 'GUAMUSIN'
on conflict (product_id, material_id) do nothing;

insert into public.prodplan_compositions (
  product_id, material_id, unit_kind, basis, qty_per_basis, supplier, overage_pct, effective_from, notes
)
select p.id, m.id, m.unit_kind, 'per_box', 1.000000, 'sato', 0, date '2026-11-03', 'One leaflet per box of 12 sachets'
from public.prodplan_products p
join public.prodplan_materials m on m.code = 'LEAFLET_GUAMUSIN'
where p.code = 'GUAMUSIN'
  and not exists (
    select 1
    from public.prodplan_compositions c
    where c.product_id = p.id
      and c.material_id = m.id
      and c.effective_to is null
  );

commit;

-- Timestamp 20261103153203 was minted to sort after every migration already on main.
