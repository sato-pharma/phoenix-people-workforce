-- Stop the sync's retirement pass deleting codes that were MERGED onto another vendor.
--
-- WHAT THIS FIXES, and why 20260819210000 did not catch it
-- That migration replaced the old blanket `delete ... where source_file =
-- 'source_of_sales_customer_map'` with a targeted retirement: drop a sales-sourced row only when
-- the live customer map no longer produces its (distributor_id, normalized_pharmacy_code) pair and
-- nothing links to it. On a database whose vendors map 1:1 onto Sales distributors that is exactly
-- right, and it is what the staging rehearsal exercised.
--
-- Production is not that database. On 2026-08-19 the owner MERGED two of the sync's own vendors
-- into their parents — Ibn Sina-Sato into `Ibn sina` and EPDA-Pharmacies into `epda` — by
-- re-pointing the surviving codes onto the parent's distributor_id (and rewriting
-- raw_distributor_name to match, so a merged row is indistinguishable from a native one).
--
-- The candidate view can only ever justify those codes under the vendor whose normalized_name
-- equals the SALES distributor name — that is, under the hidden CHILD, never under the parent they
-- now live on. So retirement saw 2,671 perfectly live codes as unjustified:
--
--     epda      1,556 rows   (the EPDA-Pharmacies merge)
--     Ibn sina  1,115 rows   (the Ibn Sina-Sato merge)
--
-- and none of them was link-protected, so the very first production run of the "safe" sync would
-- have deleted all 2,671 and undone both merges. 20260819210000 guarded the INSERT against
-- rebuilding rows under a hidden vendor; this guards the DELETE against removing the rows that
-- merge produced. They are the same owner decision seen from the two opposite directions.
--
-- THE RULE
-- A sales-sourced row is retired only when its code is absent from the live customer map
-- ENTIRELY — not merely absent under the vendor the row currently sits on. A code that still
-- exists anywhere in the map is live data that some vendor legitimately carries, whether it got
-- there by import or by merge, and this sync has no way to tell those apart and no business
-- guessing. Measured on production the day this was written, the conservative rule retires 0 rows
-- where the previous one would have destroyed 2,671.
--
-- The cost is deliberate and worth naming: a code that genuinely moves from vendor A to vendor B
-- in the Sales map now leaves its stale row under A instead of being cleaned up. That is a
-- duplicate across DIFFERENT distributor_ids, which the Customer Validation lookup does not treat
-- as ambiguous (matching is scoped by distributor_id — see resolvePharmacyCodeReference), so it
-- costs a redundant row and nothing else. Deleting a real customer code to save that row is not a
-- trade worth making. Per the owner's standing rule: never silent-drop a row — leave it and let a
-- human decide.
--
-- Pinned by tests/marketing-sales-code-sync-rerun.test.ts.

create or replace function public.phx_sync_sales_pharmacy_codes_into_marketing()
returns table (
  distributors_created        integer,
  references_synced           integer,
  references_skipped_existing integer,
  references_retired          integer,
  references_retained_linked  integer,
  references_held_hidden_vendor integer
)
language plpgsql
set search_path = public
as $func$
declare
  v_distributors_created       integer := 0;
  v_source_pairs               integer := 0;
  v_references_synced          integer := 0;
  v_references_retired         integer := 0;
  v_references_retained_linked integer := 0;
  v_references_held_hidden_vendor integer := 0;
  v_batch uuid := gen_random_uuid();
begin
  -- Ensure every sales distributor that has customer-map rows has a matching marketing
  -- distributor (matched by normalized name; created only when missing). Unchanged.
  with sales_distributors as (
    select d.distributor_code, d.distributor_name, d.normalized_distributor_name
    from public.source_of_sales_distributors d
    where d.normalized_distributor_name is not null
      and btrim(d.distributor_name) <> ''
      and exists (
        select 1
        from public.source_of_sales_customer_map m
        where m.distributor_code = d.distributor_code and m.active
      )
  ), created as (
    insert into public.marketing_distributors (distributor_code, display_name, normalized_name, source_name, active)
    select
      'SOS_' || sd.distributor_code,
      sd.distributor_name,
      sd.normalized_distributor_name,
      sd.distributor_name,
      true
    from sales_distributors sd
    where not exists (
      select 1 from public.marketing_distributors md
      where md.normalized_name = sd.normalized_distributor_name
    )
    returning 1
  )
  select count(*) into v_distributors_created from created;

  -- RETIREMENT. Three conditions now, all required:
  --   1. the row is one of ours (source_file);
  --   2. the live map does not justify it under THIS vendor;
  --   3. the live map does not carry the code under ANY vendor  <-- the merge guard, new here;
  --   4. nothing links to it.
  -- Condition 3 is what keeps a merged code alive. Without it this pass deletes the 2,671 rows
  -- the owner's two vendor merges produced, because the map can only ever justify them under the
  -- hidden child vendor they were merged away from.
  with retired as (
    delete from public.marketing_pharmacy_code_references r
    where r.source_file = 'source_of_sales_customer_map'
      and not exists (
        select 1 from public.phx_v_sales_pharmacy_code_candidates c
        where c.distributor_id = r.distributor_id
          and c.normalized_pharmacy_code = r.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.phx_v_sales_pharmacy_code_candidates c2
        where c2.normalized_pharmacy_code = r.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.marketing_pharmacy_distributor_codes dc
        where dc.reference_id = r.id
      )
    returning 1
  )
  select count(*) into v_references_retired from retired;

  -- Stale under this vendor but kept: either something links it, or the code is still live
  -- somewhere in the map (the merge case). Reported so the number is never a silent surprise.
  select count(*) into v_references_retained_linked
  from public.marketing_pharmacy_code_references r
  where r.source_file = 'source_of_sales_customer_map'
    and not exists (
      select 1 from public.phx_v_sales_pharmacy_code_candidates c
      where c.distributor_id = r.distributor_id
        and c.normalized_pharmacy_code = r.normalized_pharmacy_code
    );

  -- ADDITIVE INSERT. Unchanged from 20260819210000.
  with inserted as (
    insert into public.marketing_pharmacy_code_references (
      distributor_id,
      raw_distributor_name,
      normalized_distributor_name,
      raw_pharmacy_code,
      raw_pharmacy_address,
      raw_region,
      raw_area,
      source_file,
      source_row,
      import_batch_id
    )
    select
      c.distributor_id,
      c.raw_distributor_name,
      c.normalized_distributor_name,
      c.raw_pharmacy_code,
      c.raw_pharmacy_address,
      c.raw_region,
      c.raw_area,
      'source_of_sales_customer_map',
      c.source_row,
      v_batch
    from public.phx_v_sales_pharmacy_code_candidates c
    where c.distributor_active
      and not exists (
        select 1 from public.marketing_pharmacy_code_references r
        where r.distributor_id = c.distributor_id
          and r.normalized_pharmacy_code = c.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.marketing_pharmacy_code_references r
        where r.distributor_id = c.distributor_id
          and r.compact_pharmacy_code = c.compact_pharmacy_code
      )
    returning 1
  )
  select count(*) into v_references_synced from inserted;

  select
    count(*) filter (where c.distributor_active),
    count(*) filter (where not c.distributor_active)
  into v_source_pairs, v_references_held_hidden_vendor
  from public.phx_v_sales_pharmacy_code_candidates c;

  return query select
    v_distributors_created,
    v_references_synced,
    greatest(v_source_pairs - v_references_synced, 0),
    v_references_retired,
    v_references_retained_linked,
    v_references_held_hidden_vendor;
end;
$func$;

comment on function public.phx_sync_sales_pharmacy_codes_into_marketing() is
  'Idempotent: copies source_of_sales_customer_map into marketing_pharmacy_code_references, '
  'bridged to a marketing distributor by normalized name. Additive — never inserts a '
  '(distributor_id, normalized_pharmacy_code) pair that already exists under ANY source_file, and '
  'never inserts under an inactive vendor. Retires only its own rows whose code has left the live '
  'map ENTIRELY and that nothing references, so a code merged onto another vendor is never '
  'deleted. Server-only (service_role).';
