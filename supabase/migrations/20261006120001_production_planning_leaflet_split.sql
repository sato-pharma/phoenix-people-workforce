-- production_planning_leaflet_split
--
-- WHAT THIS CHANGES: splits the single `LEAFLET` material into `LEAFLET_OLD` and `LEAFLET_NEW`,
--   moves EGPI's 78,250 reported pieces onto them as 68,250 old + 10,000 new (the split the
--   factory's own report already described in its note), retires the combined material by setting
--   `is_active = false`, and gives the NEW leaflet its first composition row: one per packaging
--   set, supplied by Sato, effective 2026-10-06.
--
-- WHY: the owner settled it on 2026-10-06 — "split the leaflet into old and new and track both".
--   Until now the leaflet was one material carrying one number and no composition row, so it
--   appeared in the stock tab and contributed nothing to any buy list. Two leaflet artworks are not
--   one item: splitting them is only meaningful because an old-artwork leaflet cannot go into a new
--   box, which is why the requirement lands on the NEW one and the old 68,250 is tracked as its own
--   balance to run down or write off rather than as cover for new production.
--
--   Nothing is destroyed and no total moves: 68,250 + 10,000 = the 78,250 EGPI reported, the
--   original report row stays exactly where it is as the evidence, and the retired material is
--   deactivated rather than deleted so its history stays readable. The combined material also gets
--   a closing zero row, so that if it is ever reactivated it cannot double-count the same pieces.
--
-- ROLLBACK:
--   update prodplan_compositions set effective_to = '2026-10-06'
--    where material_id = (select id from prodplan_materials where code = 'LEAFLET_NEW');
--   update prodplan_materials set is_active = true  where code = 'LEAFLET';
--   update prodplan_materials set is_active = false where code in ('LEAFLET_OLD','LEAFLET_NEW');
--   -- the stock rows are append-only and are left in place; the combined material's own
--   -- 2026-10-05 report row is untouched, so reactivating it restores the 78,250 reading.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- 1 · The two materials, mirroring the carton and sticker exactly (count / piece / 21 days).
--     Sorted either side of the combined material's old 110 so they read in the obvious order.
insert into prodplan_materials
  (code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display,
   is_imported, lead_time_days, is_active, sort_order, notes)
values
  ('LEAFLET_NEW', 'البروشور الداخلي — الجديد', 'Leaflet — new artwork',
   'count', 'piece', 'piece', 1, false, 21, true, 110,
   'The current artwork — the one a new box takes. Owner, 2026-10-06: the leaflet is tracked, and this is the version a run consumes.'),
  ('LEAFLET_OLD', 'البروشور الداخلي — القديم', 'Leaflet — old artwork',
   'count', 'piece', 'piece', 1, false, 21, true, 111,
   'The superseded artwork, 68,250 pieces across two lots at EGPI. Tracked so the balance is visible, with NO composition row: it is not cover for new production, it is stock to run down or write off.')
on conflict (code) do nothing;

-- 2 · Move EGPI's report onto them, same as_of_date as the report it came from so the split is
--     dated when the factory counted it rather than when it was recorded here.
insert into prodplan_stock_entries
  (material_id, unit_kind, location_id, qty, as_of_date, source, note)
select m.id, m.unit_kind, l.id, v.qty, date '2026-10-05', 'factory_report', v.note
  from (values
    ('LEAFLET_OLD', 68250.000000::numeric,
     'The old-artwork half of EGPI''s 2026-10-05 report of 78,250 leaflets — 68,250 across two lots.'),
    ('LEAFLET_NEW', 10000.000000::numeric,
     'The new-artwork half of EGPI''s 2026-10-05 report of 78,250 leaflets — 10,000 pieces.')
  ) as v(code, qty, note)
  join prodplan_materials m on m.code = v.code
  join prodplan_locations l on l.code = 'EGPI'
 where not exists (
   select 1 from prodplan_stock_entries s
    where s.material_id = m.id and s.location_id = l.id and s.as_of_date = date '2026-10-05'
 );

-- 3 · Close the combined material out at zero before retiring it, so a later reactivation cannot
--     read 78,250 a second time on top of the two halves.
insert into prodplan_stock_entries
  (material_id, unit_kind, location_id, qty, as_of_date, source, note)
select m.id, m.unit_kind, l.id, 0, date '2026-10-06', 'adjustment',
       'Retired: these 78,250 pieces now live on LEAFLET_OLD (68,250) and LEAFLET_NEW (10,000). Zeroed here so the combined material cannot double-count them.'
  from prodplan_materials m
  join prodplan_locations l on l.code = 'EGPI'
 where m.code = 'LEAFLET'
   and not exists (
     select 1 from prodplan_stock_entries s
      where s.material_id = m.id and s.location_id = l.id and s.as_of_date = date '2026-10-06'
   );

update prodplan_materials
   set is_active = false,
       notes = 'Retired 2026-10-06: split into LEAFLET_OLD and LEAFLET_NEW because the two artworks are not one item. Kept, not deleted, so EGPI''s original 78,250 report stays readable.',
       updated_at = now()
 where code = 'LEAFLET' and is_active;

-- 4 · The new leaflet's first composition row — one per packaging set, every sample included,
--     exactly like the carton and the sticker it goes in with. Supplied by Sato: it is Sato's own
--     printed artwork, which is why Sato is the one holding and counting it.
insert into prodplan_compositions
  (product_id, material_id, unit_kind, basis, qty_per_basis, supplier, effective_from, notes)
select p.id, m.id, m.unit_kind, 'per_packaging_set', 1, 'sato', date '2026-10-06',
       'Owner, 2026-10-06: the leaflet is tracked. One per packaging set including every sample, the same as the carton and the sticker. The old artwork is a separate material and is not cover for this line.'
  from prodplan_products p
  cross join prodplan_materials m
 where p.code = 'IVYRONC'
   and m.code = 'LEAFLET_NEW'
   and not exists (
     select 1 from prodplan_compositions c
      where c.product_id = p.id and c.material_id = m.id and c.effective_from = date '2026-10-06'
   );

commit;

-- Verify
--   select code, is_active, sort_order from prodplan_materials where code like 'LEAFLET%' order by sort_order;
--   select m.code, s.qty, s.as_of_date, s.source
--     from prodplan_stock_entries s join prodplan_materials m on m.id = s.material_id
--    where m.code like 'LEAFLET%' order by m.code, s.as_of_date;
--   select m.code, c.basis, c.qty_per_basis, c.supplier, c.effective_from, c.effective_to
--     from prodplan_compositions c join prodplan_materials m on m.id = c.material_id
--    where m.code like 'LEAFLET%';
