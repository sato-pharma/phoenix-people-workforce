-- Converge a divergent Fayoum/Beni Suef split onto the canonical GZ6 / UE9 area codes.
--
-- WHY. 20260803180926_split_gz6_fayoum_beni_suef.sql split GZ6 into GZ6 "Fayoum" and a new UE9
-- "Beni Suef". Production is in exactly that state. STAGING is not: its ledger records
-- 20260803180926 as applied, but the split was performed out-of-band under different codes —
-- GZ6 retired inactive, and two new areas GZ8 "Fayoum" / GZ9 "Beni Suef". That is the second
-- false-green found in the 2026-08-12 ledger audit.
--
-- WHY GZ6/UE9 WINS, and not on preference. `UE9` is hardcoded in 10 TypeScript modules; `GZ9`
-- appears in none. The decisive one is business logic, not a constant:
-- src/lib/sales/closing-area-merges.ts folds GZ6 + UE9 into ONE Closing Matrix row on Pedia and CNS
-- per an owner ruling of 2026-08-07. Where Beni Suef is GZ9 that lookup finds nothing, so the merge
-- silently does not happen and staging's closing numbers differ from production's. Choosing GZ8/GZ9
-- would mean editing owner-ruled logic to match a staging accident.
--
-- The ims_ratio also converges to the owner's derivation. Both splits total the parent's 0.0258, but
-- divide it differently — production 0.0097/0.0161 (from the owner classifying all 16 bricks on
-- 2026-08-03, per 20260803180926's header), staging 0.0147/0.0111, which traces to no migration.
--
-- THE BRICKS ALREADY AGREE, which is what makes this safe. Verified 2026-08-12, byte-identical:
--   Fayoum    B125-10, B125-12, B125-13, B125-M1, B191-3, B191-4        (6)
--   Beni Suef B127-66, B128-2, B128-34, B128-4, B128-M1, B191-1,
--             B191-2, B191-5, B191-6, B191-7                            (10)
-- So no brick changes owner here. Only the area LABEL above them moves.
--
-- SELF-NO-OP ON PRODUCTION AND ON A REBUILD. Everything is gated on GZ8/GZ9 existing and UE9 not.
-- On production that gate is false and this file does nothing.
--
-- MECHANICS. source_of_sales_areas is referenced by source_of_sales_area_aliases and
-- source_of_sales_blocks with ON UPDATE CASCADE, and blocks -> bricks cascades in turn, so renaming
-- the area carries the whole geography hierarchy. But source_of_sales_fact_rollup and
-- source_of_sales_import_rows DENORMALISE area_code with no FK, and au.canonical_areas /
-- au.line_area_map / au.seats / au.monthly_targets have NO foreign keys at all — every one of those
-- is updated explicitly below.
--
-- ─── DELIBERATELY NOT DONE HERE ────────────────────────────────────────────────────────────────
-- Staging diverges from production in four further ways that are NOT area codes. Each is listed with
-- its delta so none of them is silently forgotten; none blocks the code paths this file exists to fix.
--   1. BLOCK B221. Production re-homed bricks B191-3/B191-4 into block B125 (1 Fayoum block, 6
--      bricks). Staging created a new block B221 for them (2 Fayoum blocks, 4 + 2). Folding B221
--      into B125 moves bricks between blocks and changes block-level reporting — its own change.
--   2. SEAT IDS are assigned to opposite areas. Production: SEAT-AIF-REP-GZ6 = Fayoum,
--      SEAT-AIF-REP-UE9 = Beni Suef. Staging: SEAT-AIF-REP-GZ8 = Fayoum, SEAT-AIF-REP-GZ6 = Beni
--      Suef. This file repoints each seat's area_code but does NOT rename seat_ids: au.seats has no
--      FKs, so parent_seat_id and line_area_map.dm_seat_id/rep_seat_id are loose strings that a
--      rename would have to chase. Cosmetic, and higher risk than value.
--   3. au.line_area_map pedia area_state is 'occupied' on staging, 'vacant_will_hire' on production.
--   4. au.monthly_targets: staging has none for these areas; production has 14 rows. And
--      au.direct_region_allocation UE-1 weight is 3 on staging, 2 on production.
--
-- Rollback: no clean one. The GZ8/GZ9 codes and the retired-GZ6 row are destroyed. Restore from a
-- pre-change snapshot of source_of_sales_areas / au.canonical_areas / au.line_area_map, or re-run the
-- out-of-band split. Dry-run first (commit -> rollback) and read the row counts.

begin;

do $mig$
declare
  n_rollup      bigint;
  n_import      bigint;
  n_blocks      bigint;
  n_bricks      bigint;
  n_aliases     bigint;
  n_canon       bigint;
  n_lam         bigint;
  n_seats       bigint;
  n_targets     bigint;
  n_stale_lam   bigint;
  n_tmp         bigint;
begin
  ----------------------------------------------------------------- gate
  if not exists (select 1 from public.source_of_sales_areas where area_code in ('GZ8','GZ9')) then
    raise notice 'converge_gz8_gz9: no GZ8/GZ9 areas present — nothing to do (this is production and a fresh rebuild).';
    return;
  end if;

  if exists (select 1 from public.source_of_sales_areas where area_code = 'UE9') then
    raise exception 'UE9 already exists alongside GZ8/GZ9 — the state is not what this file was written for. Investigate before re-running.';
  end if;

  -- The bricks must already match the owner's classification, or the label move is not safe.
  if (select string_agg(brick_id, ',' order by brick_id) from public.source_of_sales_bricks where area_code = 'GZ8')
     is distinct from 'B125-10,B125-12,B125-13,B125-M1,B191-3,B191-4' then
    raise exception 'GZ8 bricks are not the expected 6 Fayoum bricks — refusing to relabel. Found: %',
      (select string_agg(brick_id, ',' order by brick_id) from public.source_of_sales_bricks where area_code = 'GZ8');
  end if;
  if (select string_agg(brick_id, ',' order by brick_id) from public.source_of_sales_bricks where area_code = 'GZ9')
     is distinct from 'B127-66,B128-2,B128-34,B128-4,B128-M1,B191-1,B191-2,B191-5,B191-6,B191-7' then
    raise exception 'GZ9 bricks are not the expected 10 Beni Suef bricks — refusing to relabel. Found: %',
      (select string_agg(brick_id, ',' order by brick_id) from public.source_of_sales_bricks where area_code = 'GZ9');
  end if;

  -- GZ6 must be the retired shell (no geography under it), or deleting it would orphan something.
  if exists (select 1 from public.source_of_sales_blocks where area_code = 'GZ6')
     or exists (select 1 from public.source_of_sales_bricks where area_code = 'GZ6') then
    raise exception 'the GZ6 row still has blocks or bricks under it — not the retired shell this file expects.';
  end if;

  raise notice 'converge_gz8_gz9: gate passed. GZ8 -> GZ6 (Fayoum), GZ9 -> UE9 (Beni Suef).';

  ----------------------------------------------------------------- 1. retire the empty GZ6 shell
  -- Its au.line_area_map rows are stale (an inactive area with no geography). Production has no
  -- equivalent, and they would collide with GZ8's rows once GZ8 becomes GZ6.
  delete from au.line_area_map where area_code = 'GZ6';
  get diagnostics n_stale_lam = row_count;
  delete from au.canonical_areas where area_code = 'GZ6';
  delete from public.source_of_sales_areas where area_code = 'GZ6';
  raise notice 'converge_gz8_gz9: retired the empty GZ6 shell (% stale line_area_map row(s) removed)', n_stale_lam;

  ----------------------------------------------------------------- 2. GZ8 -> GZ6, GZ9 -> UE9
  -- The rename cascades to source_of_sales_area_aliases and source_of_sales_blocks, and blocks
  -- cascade on to source_of_sales_bricks. Counted before the update, since afterwards the old code
  -- no longer matches.
  select count(*) into n_blocks  from public.source_of_sales_blocks  where area_code in ('GZ8','GZ9');
  select count(*) into n_bricks  from public.source_of_sales_bricks  where area_code in ('GZ8','GZ9');
  select count(*) into n_aliases from public.source_of_sales_area_aliases where area_code in ('GZ8','GZ9');

  update public.source_of_sales_areas
     set area_code = 'GZ6',
         area_name = 'Fayoum',
         normalized_area_name = 'fayoum',
         ims_ratio = 0.0097,
         description = 'Giza',
         updated_at = now()
   where area_code = 'GZ8';

  update public.source_of_sales_areas
     set area_code = 'UE9',
         area_name = 'Beni Suef',
         normalized_area_name = 'beni suef',
         ims_ratio = 0.0161,
         description = 'Split out of GZ6 Fayoum-Beni Suef on 2026-08-03',
         updated_at = now()
   where area_code = 'GZ9';

  raise notice 'converge_gz8_gz9: areas renamed; cascaded to % block(s), % brick(s), % alias(es)',
    n_blocks, n_bricks, n_aliases;

  ----------------------------------------------------------------- 3. denormalised area_code columns
  update public.source_of_sales_fact_rollup set area_code = 'GZ6' where area_code = 'GZ8';
  get diagnostics n_rollup = row_count;
  update public.source_of_sales_fact_rollup set area_code = 'UE9' where area_code = 'GZ9';
  get diagnostics n_tmp = row_count;
  n_rollup := n_rollup + n_tmp;

  update public.source_of_sales_import_rows set area_code = 'GZ6' where area_code = 'GZ8';
  get diagnostics n_import = row_count;
  update public.source_of_sales_import_rows set area_code = 'UE9' where area_code = 'GZ9';
  get diagnostics n_tmp = row_count;
  n_import := n_import + n_tmp;
  raise notice 'converge_gz8_gz9: fact_rollup % row(s), import_rows % row(s)', n_rollup, n_import;

  ----------------------------------------------------------------- 4. the au.* tables (no FKs at all)
  update au.canonical_areas set area_code = 'GZ6', area_name = 'Fayoum'    where area_code = 'GZ8';
  update au.canonical_areas set area_code = 'UE9', area_name = 'Beni Suef' where area_code = 'GZ9';
  select count(*) into n_canon from au.canonical_areas where area_code in ('GZ6','UE9');

  update au.line_area_map set area_code = 'GZ6' where area_code = 'GZ8';
  update au.line_area_map set area_code = 'UE9' where area_code = 'GZ9';
  select count(*) into n_lam from au.line_area_map where area_code in ('GZ6','UE9');

  update au.seats set area_code = 'GZ6' where area_code = 'GZ8';
  update au.seats set area_code = 'UE9' where area_code = 'GZ9';
  select count(*) into n_seats from au.seats where area_code in ('GZ6','UE9');

  update au.monthly_targets set area_code = 'GZ6' where area_code = 'GZ8';
  update au.monthly_targets set area_code = 'UE9' where area_code = 'GZ9';
  select count(*) into n_targets from au.monthly_targets where area_code in ('GZ6','UE9');

  raise notice 'converge_gz8_gz9: au.canonical_areas=%, au.line_area_map=%, au.seats=%, au.monthly_targets=%',
    n_canon, n_lam, n_seats, n_targets;
end
$mig$;

-- ─── VERIFY ───────────────────────────────────────────────────────────────────────────────────
do $verify$
declare
  leftovers text;
  fayoum_bricks text;
  beni_bricks text;
begin
  -- On a FRESH REBUILD there is no UE9 and nothing to assert, so skip.
  -- On PRODUCTION, UE9 already exists, so this block does NOT skip — it runs in full and asserts that
  -- production's own split is intact. That is deliberate: applying this file to production is not just
  -- a no-op, it re-proves the canonical state the file converges staging onto.
  if not exists (select 1 from public.source_of_sales_areas where area_code = 'UE9') then
    return;
  end if;

  -- No GZ8/GZ9 may survive anywhere this file touches.
  select string_agg(src, ', ') into leftovers from (
    select 'source_of_sales_areas'  as src where exists (select 1 from public.source_of_sales_areas where area_code in ('GZ8','GZ9'))
    union all select 'source_of_sales_blocks'  where exists (select 1 from public.source_of_sales_blocks where area_code in ('GZ8','GZ9'))
    union all select 'source_of_sales_bricks'  where exists (select 1 from public.source_of_sales_bricks where area_code in ('GZ8','GZ9'))
    union all select 'fact_rollup'             where exists (select 1 from public.source_of_sales_fact_rollup where area_code in ('GZ8','GZ9'))
    union all select 'import_rows'             where exists (select 1 from public.source_of_sales_import_rows where area_code in ('GZ8','GZ9'))
    union all select 'au.canonical_areas'      where exists (select 1 from au.canonical_areas where area_code in ('GZ8','GZ9'))
    union all select 'au.line_area_map'        where exists (select 1 from au.line_area_map where area_code in ('GZ8','GZ9'))
    union all select 'au.seats'                where exists (select 1 from au.seats where area_code in ('GZ8','GZ9'))
    union all select 'au.monthly_targets'      where exists (select 1 from au.monthly_targets where area_code in ('GZ8','GZ9'))
  ) s;
  if leftovers is not null then
    raise exception 'GZ8/GZ9 still present in: % — rolling back.', leftovers;
  end if;

  -- The bricks must be exactly where they were, under the new labels.
  select string_agg(brick_id, ',' order by brick_id) into fayoum_bricks
    from public.source_of_sales_bricks where area_code = 'GZ6';
  select string_agg(brick_id, ',' order by brick_id) into beni_bricks
    from public.source_of_sales_bricks where area_code = 'UE9';
  if fayoum_bricks is distinct from 'B125-10,B125-12,B125-13,B125-M1,B191-3,B191-4' then
    raise exception 'GZ6 bricks wrong after convergence: % — rolling back.', fayoum_bricks;
  end if;
  if beni_bricks is distinct from 'B127-66,B128-2,B128-34,B128-4,B128-M1,B191-1,B191-2,B191-5,B191-6,B191-7' then
    raise exception 'UE9 bricks wrong after convergence: % — rolling back.', beni_bricks;
  end if;

  -- The ims_ratio invariant the split migration documents: the two halves must re-add to the
  -- parent's 0.0258, and match the owner's derivation individually.
  if (select round(ims_ratio, 4) from public.source_of_sales_areas where area_code = 'GZ6') <> 0.0097
     or (select round(ims_ratio, 4) from public.source_of_sales_areas where area_code = 'UE9') <> 0.0161 then
    raise exception 'ims_ratio did not land on 0.0097 / 0.0161 — rolling back.';
  end if;

  raise notice 'verify: GZ8/GZ9 gone, bricks unmoved, ims_ratio 0.0097 + 0.0161 = 0.0258';
end
$verify$;

commit;
