-- Filename corrected 2026-08-10, no SQL changed. This fix was originally authored and merged
-- (PR #1984, commit b7a3dcd0) under filename timestamp 20260810120000, but production applied it
-- via a direct MCP apply_migration call, whose own clock recorded the ledger row as version
-- 20260809222929 (confirmed live via list_migrations against ozucdzovmcqvepbozvqf -- it is the
-- most recently applied migration on that project). check-migrations-applied.ts already tolerates
-- this exact drift pattern by matching on name as well as version (see its own comment on "the
-- known MCP apply_migration version-drift pattern"), so this rename fixes no CI failure -- the
-- drift check was already green. It closes the one thing name-matching does not cover: a raw
-- `supabase db push` keys strictly on version, so without this rename it would have treated the
-- old filename as unapplied, re-run this (idempotent but redundant), and written a second,
-- duplicate ledger row for the same logical migration.
--
-- sos_backfill_import_rows_from_customer_map has been a silent no-op since it was written
-- (20260703090000): its WHERE clause gates on `r.brick_id is null`, but the normalizer never
-- leaves brick_id NULL for an unresolved row -- it writes '' (empty string). Confirmed at the
-- type level: CodedRow.brickId (src/lib/sales/normalizer/types.ts) is a non-nullable `string`,
-- and engine.ts only ever pushes a CodedRow once `hierarchy` (the resolved brick) exists --
-- unresolved rows go to `exceptions` instead. Confirmed live on both databases (2026-08-10):
--
--            null_brick   empty_brick
--   prod        0(*)          658      (DIRECT 653, RM 2, SF 2, EG 1 -- PS was 219 until an
--                                        owner manual fix on 2026-08-09, batch a4263715-708b-
--                                        4d64-bf3c-74cccc9eb3fd, now 0)
--   staging       0            533      (DIRECT 531, PS 1, EP 1)
--
-- (*) 34 production rows DO have a genuine NULL brick_id, but under distributor_code 'Direct'
--     (mixed case) rather than 'DIRECT' -- a separate, pre-existing casing artifact, not this
--     bug. Direct/Office channel sales carry no customer->brick mapping at all (see the AU
--     attribution engine's own "Direct sales carry no brick and no area" finding,
--     20260801150100_au_direct_counts_toward_achievement.sql), so no active customer_map row
--     will ever match them; broadening the predicate below is harmless for them either way.
--
-- The 20260801120000 migration that last touched this function already documented the intended
-- behaviour precisely: "this function only touches rows where `r.brick_id is null`. It fills
-- gaps, it never re-points an existing brick." That boundary (never overwrite an already-
-- resolved brick_id -- overwriting is sos_reconcile_import_rows_from_customer_map's job) is
-- correct and is NOT changing here. What was wrong is narrower: the definition of "gap" itself.
-- A gap is `brick_id is null OR brick_id = ''`, not just NULL.
--
-- No other RPC in the SoS customer-brick path shares this bug -- sos_reconcile_import_rows_
-- from_customer_map, sos_count_reconcilable_import_rows, phx_sync_sos_restamp_import_rows and
-- phx_sync_sos_run all compare with `is distinct from`, which is null-safe AND treats '' as an
-- ordinary distinct value already (verified by reading each definition).
--
-- Net effect of this fix: the "heal historical rows" backfill checkbox in the Mapping Database
-- UI (Add-by-field, bulk save, and customer-map import, all via backfillCustomerRows in
-- src/lib/sales/normalizer/mapping.ts) starts actually updating rows instead of always
-- returning `backfilled: 0`. This migration only corrects the predicate; it does not run any
-- bulk backfill itself -- the ~1,191 rows above (658 prod + 533 staging) stay exactly as they
-- are until someone re-saves/re-imports the matching customer mapping, or an explicit,
-- owner-approved bulk pass is run afterward.

create or replace function public.sos_backfill_import_rows_from_customer_map(
  p_distributor text,
  p_customer text
)
returns table(updated_rows integer, affected_batch_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_batches uuid[] := '{}';
begin
  with updated as (
    update public.source_of_sales_import_rows r
    set brick_id    = m.brick_id,
        area_code   = b.area_code,
        area_name   = coalesce(a.area_name, r.area_name),
        region_code = b.region_code,
        region_name = coalesce(g.region_name, r.region_name)
    from public.source_of_sales_customer_map m
    join public.source_of_sales_bricks b on b.brick_id = m.brick_id
    left join public.source_of_sales_areas a on a.area_code = b.area_code
    left join public.source_of_sales_regions g on g.region_code = b.region_code
    where m.distributor_code = p_distributor
      and m.customer_code = p_customer
      and m.active
      and m.brick_id is not null
      and r.distributor_code = p_distributor
      and r.client_code = p_customer
      -- Unchanged intent: this fills a MISSING brick, it never re-points an existing one.
      -- Re-pointing is sos_reconcile_import_rows_from_customer_map's job. What changed is
      -- recognizing '' (the normalizer's real "unresolved" sentinel) as missing too, not just
      -- SQL NULL -- see the migration header for why NULL alone never matched real data.
      and (r.brick_id is null or r.brick_id = '')
    returning r.batch_id
  )
  select count(*)::integer, coalesce(array_agg(distinct batch_id), '{}')
  into v_count, v_batches
  from updated;

  updated_rows := v_count;
  affected_batch_ids := v_batches;
  return next;
end;
$function$;

comment on function public.sos_backfill_import_rows_from_customer_map(text, text) is
  'Fills brick/area/region on historical import rows whose brick_id is unresolved (NULL or the normalizer''s '''' sentinel) from an active customer mapping. Never overwrites an already-resolved brick_id -- that is sos_reconcile_import_rows_from_customer_map''s job. Returns the updated row count and the distinct batch_ids touched.';

revoke execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  from public, anon, authenticated;
grant execute on function public.sos_backfill_import_rows_from_customer_map(text, text)
  to service_role;
