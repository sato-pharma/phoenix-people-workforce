-- Weekly Sales: the Ibn Sina Lacto (IS-L) depot 'A2' Assiut 2 Warehouse takes the area Assuit 2.
--
-- WHAT
--   One row of public.weekly_sales_branch_region_map: distributor_code 'IS-L', raw_branch 'A2',
--   area_code moves from NULL to 'UE4'. The region stays 'UE' Upper Egypt. area_name is left to the
--   table's BEFORE trigger, which fills it from the area master (it stamped "Gharbia 1 (Tanta)" on
--   depot '04' the same way).
--
-- WHY
--   OWNER RULING, 2026-10-13: "wire to assuit 2".
--
--   20261013011406_weekly_ibn_sina_lacto_feed_seed.sql seeded 'A2' region-only, with NO area, and
--   said so in its header as a JUDGEMENT CALL rather than a fact: it followed the warehouse
--   precedent already in that table — 'AS' Almaza Storage, 'B1' Benisuef 2 Warehouse and 'O1'
--   October Regional Warehouse all carry a region and no area, because a warehouse serves a region
--   rather than one area. The owner has now ruled the other way for this depot: it is Assiut's, so
--   it takes the Assiut 2 area.
--
--   'UE4' is the area master's own code for it — public.source_of_sales_areas holds
--   ('UE4', 'Assuit 2', region 'UE'), spelled "Assuit" there, which is why the code and not the
--   name is what this migration writes.
--
--   Worth knowing for anyone reading the numbers: of this depot's 171 units in the 2026-10-11 file,
--   167 are Lacto Basic — Head Office, which weekly does not track — so the area choice moves 4
--   units of a tracked line today. It matters for every future week, not for that one file.
--
-- WHY A MIGRATION AND NOT JUST THE ADMIN TAB
--   The seed migration is how this row exists at all, so a rebuild from migrations would otherwise
--   restore the area-less version and silently undo the ruling. The admin tab was used for nothing
--   here; the change is applied by this file, on staging and on production.
--
-- ROLLBACK (restores exactly what the seed migration wrote):
--   update public.weekly_sales_branch_region_map
--      set area_code = null, area_name = null
--    where distributor_code = 'IS-L' and raw_branch = 'A2';
--
-- Idempotent: re-applying sets the same value. It touches ONE row, named by both distributor_code
-- and raw_branch, and no other distributor's map is read or changed.

update public.weekly_sales_branch_region_map
   set area_code  = 'UE4',
       updated_by = 'claude-isl-a2-assuit2-2026-10-13'
 where distributor_code = 'IS-L'
   and raw_branch = 'A2';
