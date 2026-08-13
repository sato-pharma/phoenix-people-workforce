-- Weekly Sales: backfill the Fayoum/Beni Suef area tags (GZ6/UE9) on STAGING to match production.
--
-- THE GAP. public.weekly_sales_branch_region_map has zero rows tagged to GZ6 (Fayoum) or UE9 (Beni
-- Suef) on staging; production has 29, all region_code='GZ' ('Giza'), verified correct. All 29
-- natural-key tuples already exist on staging with area_code IS NULL -- this is an UPDATE-only
-- backfill, no INSERTs.
--
-- WIDER THAN THE MAP ALONE. public.weekly_sales_rows carries its own area_code, resolved from this
-- map AT IMPORT TIME (20260730150000_weekly_sales_branch_area.sql). Production has 1,191 fact rows
-- tagged and matchable via this exact mapping; staging has zero of either, because matchability
-- depends on the map already having area_code set -- exactly what this file adds. That earlier
-- migration's own step 4 backfills weekly_sales_rows in the same transaction it adds the column,
-- specifically so populating the map later "repairs history without waiting for the next weekly
-- upload" (its own words). Reproducing that step here is what makes this a real fix rather than a
-- half one: fixing only the map would leave staging's historical fact rows silently untagged even
-- though the map now says otherwise.
--
-- ORIGIN. Production's 29 rows were set by an ad-hoc script run directly against production on
-- 2026-08-11/12 (updated_by = chatgpt_branch_area_import_2026-08-12 / claude-brick-fill-2026-08-12),
-- never captured as a migration. Neither the original area split
-- (20260803180926_split_gz6_fayoum_beni_suef.sql) nor the later convergence
-- (20260813090000_converge_staging_gz8_gz9_to_gz6_ue9.sql) touches this table -- grep confirms zero
-- mentions of it in either. This migration formalizes what already exists on production.
--
-- THE WRINKLE. Two of the 29 keyed rows carry a stale region_code on staging:
-- ('PS','الفيوم','sales') is currently region_code='UE', and ('PS','بني سويف','sales') is currently
-- region_code='AB'. weekly_branch_area_is_consistent_trg (20260730150000_weekly_sales_branch_area.sql)
-- rejects an area_code write whose area's region doesn't match the row's region_code, so tagging
-- either row while its region_code is still stale would be rejected outright. Rather than special-
-- case those two rows, both UPDATEs below set region_code='GZ', region_name='Giza' unconditionally on
-- every row in their list -- a harmless no-op on the 27 rows that already carry them, and exactly the
-- fix the 2 stale rows need, landed in the SAME statement so the trigger only ever sees the corrected
-- region_code alongside the new area_code, never the mismatched intermediate state. Deliberately NOT
-- copying the 20260730150100 precedent's `where region_code = '<fixed>'` gate: that precondition
-- would silently exclude the two stale rows and under-match to 27/29 without erroring.
--
-- area_name is deliberately NOT set here: weekly_branch_area_is_consistent_trg fills it unconditionally
-- from source_of_sales_areas whenever area_code is set -- same as the Kafr El-Sheikh precedent below.
--
-- Matched on the natural key (distributor, raw branch, file type), not row ids, so this applies
-- identically in staging and production -- same pattern as
-- 20260730150100_weekly_kafr_elsheikh_area_seed.sql. Guarded by area_code is null so a re-run after
-- the first successful apply touches 0 rows on the two map UPDATEs.
--
-- Rollback: set area_code back to null for the 29 rows below; for the two special-cased rows also
-- set region_code/region_name back to their prior values ('UE'/... and 'AB'/...). For the
-- weekly_sales_rows backfill, set area_code back to null for rows whose area_code = 'GZ6' or 'UE9'
-- and whose branch matches these same map rows.

begin;

-- 1. GZ6 / Fayoum -- 11 rows. ('PS','الفيوم','sales') is the stale-region_code row in this group
--    (currently 'UE'); every other row here already carries region_code='GZ'.
update public.weekly_sales_branch_region_map
   set area_code   = 'GZ6',
       region_code = 'GZ',
       region_name = 'Giza',
       updated_by  = 'weekly_fayoum_beni_suef_area_seed',
       updated_at  = now()
 where area_code is null
   and not excluded
   and (distributor_code, raw_branch, source_file_type) in (
     ('EG',   '04030101',           'any'),
     ('IS',   '26',                 'any'),
     ('IS-S', '26',                 'any'),
     ('POS',  'Retail Al-Fayoum',   'any'),
     ('PS',   'Retail Al-Fayoum_ك', 'sales'),
     ('PS',   'الفيوم',              'sales'),   -- stale region_code='UE' before this migration
     ('PS',   'الفيوم_ك',            'sales'),
     ('PS',   'Fayoum Branch',      'stock'),
     ('PS',   'Retail Al-Fayoum_ك', 'stock'),
     ('PS',   'الفيوم',              'stock'),
     ('PS',   'الفيوم_ك',            'stock')
   );

-- 2. UE9 / Beni Suef -- 18 rows. ('PS','بني سويف','sales') is the stale-region_code row in this
--    group (currently 'AB'); every other row here already carries region_code='GZ'.
update public.weekly_sales_branch_region_map
   set area_code   = 'UE9',
       region_code = 'GZ',
       region_name = 'Giza',
       updated_by  = 'weekly_fayoum_beni_suef_area_seed',
       updated_at  = now()
 where area_code is null
   and not excluded
   and (distributor_code, raw_branch, source_file_type) in (
     ('EG',   '04030103',             'any'),
     ('EG',   'فرع بني سويف',           'any'),
     ('IS',   '39',                   'any'),
     ('IS',   '62',                   'any'),
     ('IS-S', '39',                   'any'),
     ('IS-S', '62',                   'any'),
     ('POS',  'Retail Bani Sueaf',    'any'),
     ('POS',  'Retail Bani Sueaf 2',  'any'),
     ('PS',   'Retail Bani Sueaf 2_ك','sales'),
     ('PS',   'Retail Bani Sueaf_ك',  'sales'),
     ('PS',   'بنى سويف_ك',            'sales'),
     ('PS',   'بني سويف',              'sales'),  -- stale region_code='AB' before this migration
     ('PS',   'Bani Sweif Branch',    'stock'),
     ('PS',   'Bani Swif Regional',   'stock'),
     ('PS',   'Retail Bani Sueaf 2_ك','stock'),
     ('PS',   'Retail Bani Sueaf_ك',  'stock'),
     ('PS',   'بنى سويف_ك',            'stock'),
     ('PS',   'بني سويف',              'stock')
   );

-- 3. Repair weekly_sales_rows history from the map, now that it has these 29 rows tagged --
--    reproducing 20260730150000_weekly_sales_branch_area.sql's own step 4 verbatim (same join,
--    same guard). Row count is data-dependent (staging's own weekly_sales_rows volume, not
--    necessarily production's 1,191) -- reported below, not hard-asserted.
update public.weekly_sales_rows r
   set area_code = m.area_code
  from public.weekly_sales_branch_region_map m
 where m.area_code is not null
   and not m.excluded
   and upper(btrim(m.distributor_code)) = upper(btrim(r.distributor_code))
   and upper(btrim(coalesce(m.raw_branch, ''))) in (
         upper(btrim(coalesce(r.branch_code, ''))),
         upper(btrim(coalesce(r.branch_name, '')))
       )
   and r.area_code is distinct from m.area_code;

-- ─── VERIFY ───────────────────────────────────────────────────────────────────────────────────
do $verify$
declare
  v_total         int;
  v_gz6           int;
  v_ue9           int;
  v_special       int;
  v_bad_region    text;
  v_bad_area_name text;
  v_wsr_tagged    int;
begin
  select count(*) into v_total
    from public.weekly_sales_branch_region_map
   where area_code in ('GZ6','UE9');
  if v_total <> 29 then
    raise exception 'expected exactly 29 rows tagged GZ6/UE9 after backfill, found %', v_total;
  end if;

  select count(*) into v_gz6 from public.weekly_sales_branch_region_map where area_code = 'GZ6';
  if v_gz6 <> 11 then
    raise exception 'expected 11 GZ6/Fayoum rows, found % -- a tuple in the Fayoum list did not match a staging row', v_gz6;
  end if;

  select count(*) into v_ue9 from public.weekly_sales_branch_region_map where area_code = 'UE9';
  if v_ue9 <> 18 then
    raise exception 'expected 18 UE9/Beni Suef rows, found % -- a tuple in the Beni Suef list did not match a staging row', v_ue9;
  end if;

  -- Every tagged row must sit inside GZ/Giza. The trigger enforces region_code on write; this
  -- re-checks region_code AND region_name (the trigger never touches region_name) rather than
  -- trusting the trigger fired as expected.
  select string_agg(distributor_code || '/' || raw_branch || '/' || source_file_type
                     || '=' || region_code || '/' || region_name, ', ')
    into v_bad_region
    from public.weekly_sales_branch_region_map
   where area_code in ('GZ6','UE9')
     and (region_code <> 'GZ' or region_name <> 'Giza');
  if v_bad_region is not null then
    raise exception 'GZ6/UE9 rows outside region GZ/Giza: %', v_bad_region;
  end if;

  -- The two previously stale-region rows specifically must now show the correction.
  select count(*) into v_special
    from public.weekly_sales_branch_region_map
   where distributor_code = 'PS'
     and source_file_type = 'sales'
     and raw_branch in ('الفيوم', 'بني سويف')
     and region_code = 'GZ'
     and region_name = 'Giza';
  if v_special <> 2 then
    raise exception 'expected both previously stale rows (PS/الفيوم/sales was region_code=UE, PS/بني سويف/sales was region_code=AB) to now show region_code=GZ/region_name=Giza, found %', v_special;
  end if;

  -- area_name is trigger-derived, not set by this migration -- confirm it was actually filled from
  -- source_of_sales_areas rather than left null or stale.
  select string_agg(distributor_code || '/' || raw_branch, ', ') into v_bad_area_name
    from public.weekly_sales_branch_region_map
   where (area_code = 'GZ6' and area_name is distinct from 'Fayoum')
      or (area_code = 'UE9' and area_name is distinct from 'Beni Suef');
  if v_bad_area_name is not null then
    raise exception 'area_name not filled correctly by weekly_branch_area_is_consistent_trg for: %', v_bad_area_name;
  end if;

  select count(*) into v_wsr_tagged
    from public.weekly_sales_rows
   where area_code in ('GZ6','UE9');

  raise notice 'verify: 29 map rows tagged (11 GZ6 Fayoum + 18 UE9 Beni Suef), region_code/region_name = GZ/Giza throughout, both stale-region rows corrected, area_name trigger-filled correctly, % weekly_sales_rows fact row(s) now tagged GZ6/UE9', v_wsr_tagged;
end
$verify$;

commit;
