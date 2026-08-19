-- Make phx_sync_sales_pharmacy_codes_into_marketing() safe to re-run.
--
-- WHAT WENT WRONG (production, 2026-08-19)
-- The function blind-inserted one marketing_pharmacy_code_references row per
-- source_of_sales_customer_map row. It resolves the target vendor through
-- `md.normalized_name = sd.normalized_distributor_name`, so the Sales rows for POS, Ibn sina,
-- EGD, ramco, sofico, mec and epda landed on the SAME distributor_id as the rows already loaded
-- from the two spreadsheet imports. Both sources store the code in the same zero-padded form, so
-- the duplicate landed on `normalized_pharmacy_code` — the exact column PASS 1 of
-- `resolvePharmacyCodeReference` matches on (src/lib/marketing-requests/service.ts). Two rows for
-- one code makes `buildPharmacyCodeReferenceResult` return 'ambiguous', and PASS 2 cannot rescue
-- it because pass 2 only runs when pass 1 finds nothing.
--
-- One run turned 44,244 codes from 'matched' into 'ambiguous':
--     POS 27,590 · Ibn sina 12,913 · EGD 1,807 · ramco 1,045 · sofico 692 · mec 141 · epda 56
-- The comment at service.ts:4363 had already predicted this exact failure. The duplicates were
-- deleted by hand; this migration is what stops them coming back on the next run.
--
-- FOUR THINGS ARE FIXED HERE
--
-- 1. THE INSERT IS NOW ADDITIVE. It carries a `not exists` guard on
--    (distributor_id, normalized_pharmacy_code) that looks at the WHOLE table, not just at rows
--    this sync owns — a code already present under that distributor from a spreadsheet import is
--    left alone. It also guards on `compact_pharmacy_code`, because PASS 2 of the resolver leans
--    on "zero-stripping collapses nothing inside a distributor" (migration 20260816050358);
--    importing the same pharmacy a second time under different padding would quietly break that
--    invariant and produce a differently-shaped ambiguity. Measured on production 2026-08-19,
--    both guards select exactly the same rows, so the compact guard costs nothing today and
--    closes the door for later.
--
--    The source set is also de-duplicated against ITSELF, with `distinct on`, in the view below.
--    A single INSERT ... SELECT cannot see its own new rows, so a `not exists` guard alone would
--    happily insert the same pair twice from two source rows. Nothing in the schema forbids that
--    (source_of_sales_customer_map is unique per distributor+client_code, but two Sales
--    distributors could normalize onto one marketing vendor). It is zero rows today. It is one
--    import away from not being zero.
--
-- 2. THE BLANKET DELETE IS GONE. The old body opened with
--        delete from public.marketing_pharmacy_code_references
--        where source_file = 'source_of_sales_customer_map';
--    which reads as harmless "refresh my own rows". It is not:
--    marketing_pharmacy_distributor_codes.reference_id is a FOREIGN KEY to this table with
--    ON DELETE SET NULL. Every validated customer code that had matched a Sales-sourced row would
--    silently lose its reference_id on the next sync, while `reference_status` stayed 'matched' —
--    no error, no cascade, just provenance quietly detached. Zero rows are affected today only
--    because the Sales-sourced rows are new; the whole purpose of this sync is to make those codes
--    matchable, so it would not have stayed zero.
--
--    In its place: a targeted RETIREMENT delete. A Sales-sourced row is dropped only when the live
--    customer map no longer produces its (distributor, code) pair AND no customer-code link points
--    at it. A stale row that IS still linked is kept and counted, so the number is visible instead
--    of being a silent unlink.
--
-- 3. source_row IS WIDENED TO bigint. The old body cast source_of_sales_customer_map.id (bigint,
--    max 736,844 today) to `integer`. Hashing is NOT an option here: there is a UNIQUE index
--    marketing_pharmacy_code_refs_source_row_uidx on (source_file, source_row), so a hash
--    collision would abort the whole sync. The map's id is unique by construction, so widening the
--    column keeps that guarantee exactly and removes the overflow.
--
-- 4. THE INSERT SKIPS HIDDEN VENDORS. On 2026-08-19 the owner pruned the vendor list to 12 and
--    merged two of this sync's own vendors into their parents: Ibn Sina-Sato into Ibn sina (3,949
--    codes) and EPDA-Pharmacies into epda (1,571). A merge re-points codes onto a DIFFERENT
--    distributor_id, which the guards in (1) cannot see — so measured on production, a run without
--    an `active` check would rebuild all 5,520 rows under the two hidden vendors and quietly undo
--    both merges. Retirement deliberately does NOT apply the check, so the 423 rows the owner chose
--    to keep behind hidden vendors are left alone. The count is returned as
--    references_held_hidden_vendor rather than silently dropped.
--
-- Also tightened: the baseline granted EXECUTE on this function to `authenticated`. Nothing in
-- src/ calls it — the only caller is scripts/sync-sales-pharmacy-codes-into-marketing.ts over a
-- direct service-role connection — so a signed-in user being able to fire a bulk rewrite of the
-- reference database is exposure with no upside. It is now service_role only.
--
-- Pinned by tests/marketing-sales-code-sync-rerun.test.ts.

-- ── 1. source_row must hold a bigint map id ──────────────────────────────────────────────────
alter table public.marketing_pharmacy_code_references
  alter column source_row type bigint;

comment on column public.marketing_pharmacy_code_references.source_row is
  'Row this reference came from: the spreadsheet row number for a file import, or '
  'source_of_sales_customer_map.id for the Sales sync. bigint, not integer — the map id passed '
  '736,844 in Aug 2026 and a hash is not substitutable because (source_file, source_row) is UNIQUE.';

-- ── 2. The candidate set, as a view ──────────────────────────────────────────────────────────
-- One row per (marketing distributor, normalized code) that the live Sales customer map justifies.
-- A view rather than a repeated CTE so the retirement pass and the insert pass can never drift
-- apart, and so coverage can be audited without running anything that writes.
-- Dropped first, not CREATE OR REPLACEd: replace cannot add or reorder a column in the middle of
-- the select list, so a later edit to this view would fail with "cannot change name of view column"
-- on any database that already has it. Nothing holds a stored dependency on it — the function's
-- plpgsql body is not a tracked reference.
drop view if exists public.phx_v_sales_pharmacy_code_candidates;

create view public.phx_v_sales_pharmacy_code_candidates
with (security_invoker = true) as
with candidates as (
  select
    md.id                                                                              as distributor_id,
    md.active                                                                          as distributor_active,
    sd.distributor_name                                                                as raw_distributor_name,
    sd.normalized_distributor_name                                                     as normalized_distributor_name,
    btrim(m.customer_code)                                                             as raw_pharmacy_code,
    lower(btrim(regexp_replace(btrim(m.customer_code), '\s+', ' ', 'g')))              as normalized_pharmacy_code,
    m.address                                                                          as raw_pharmacy_address,
    m.region_code                                                                      as raw_region,
    m.area_code                                                                        as raw_area,
    m.id                                                                               as source_row
  from public.source_of_sales_customer_map m
  join public.source_of_sales_distributors sd
    on sd.distributor_code = m.distributor_code
  join public.marketing_distributors md
    on md.normalized_name = sd.normalized_distributor_name
  where m.active
    and coalesce(btrim(m.customer_code), '') <> ''
    and btrim(sd.distributor_name) <> ''
    and sd.normalized_distributor_name is not null
)
-- `distinct on` is the intra-source guard: a `not exists` subquery cannot see rows the same
-- statement is inserting, so without this two map rows collapsing onto one vendor would recreate
-- the ambiguity the guard exists to prevent. Lowest map id wins, so the pick is deterministic.
select distinct on (c.distributor_id, c.normalized_pharmacy_code)
  c.distributor_id,
  -- Carried, not filtered on, and the difference matters. The INSERT skips inactive vendors (see
  -- below); RETIREMENT deliberately ignores this flag, so the 423 rows the owner chose to keep
  -- behind hidden vendors on 2026-08-19 stay exactly where they are.
  c.distributor_active,
  c.raw_distributor_name,
  c.normalized_distributor_name,
  c.raw_pharmacy_code,
  c.normalized_pharmacy_code,
  -- Mirrors the generated column marketing_pharmacy_code_references.compact_pharmacy_code
  -- (migration 20260816050358) so the compact guard below compares like with like.
  case
    when c.normalized_pharmacy_code ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(c.normalized_pharmacy_code, '0'), ''), '0')
    else c.normalized_pharmacy_code
  end as compact_pharmacy_code,
  c.raw_pharmacy_address,
  c.raw_region,
  c.raw_area,
  c.source_row
from candidates c
order by c.distributor_id, c.normalized_pharmacy_code, c.source_row;

comment on view public.phx_v_sales_pharmacy_code_candidates is
  'One row per (marketing distributor, normalized pharmacy code) justified by the live Sales '
  'customer map. Read-only input to phx_sync_sales_pharmacy_codes_into_marketing(); safe to query '
  'to see what a sync would add without running it.';

revoke all on public.phx_v_sales_pharmacy_code_candidates from public;
grant select on public.phx_v_sales_pharmacy_code_candidates to service_role;

-- ── 3. The sync itself ───────────────────────────────────────────────────────────────────────
-- Dropped rather than replaced because the OUT columns change; CREATE OR REPLACE cannot do that.
drop function if exists public.phx_sync_sales_pharmacy_codes_into_marketing();

create function public.phx_sync_sales_pharmacy_codes_into_marketing()
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
  -- distributor (matched by normalized name; created only when missing) so the synced
  -- pharmacy codes can attach to a selectable vendor. Unchanged.
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

  -- RETIREMENT. Drop only the sales-sourced rows the live map no longer justifies, and only when
  -- nothing points at them. This is deliberately NOT the old
  -- `delete ... where source_file = 'source_of_sales_customer_map'` — that unlinked live customer
  -- codes through the ON DELETE SET NULL foreign key without saying so.
  with retired as (
    delete from public.marketing_pharmacy_code_references r
    where r.source_file = 'source_of_sales_customer_map'
      and not exists (
        select 1 from public.phx_v_sales_pharmacy_code_candidates c
        where c.distributor_id = r.distributor_id
          and c.normalized_pharmacy_code = r.normalized_pharmacy_code
      )
      and not exists (
        select 1 from public.marketing_pharmacy_distributor_codes dc
        where dc.reference_id = r.id
      )
    returning 1
  )
  select count(*) into v_references_retired from retired;

  -- Stale but still referenced: kept on purpose, reported so it is never a silent surprise.
  select count(*) into v_references_retained_linked
  from public.marketing_pharmacy_code_references r
  where r.source_file = 'source_of_sales_customer_map'
    and not exists (
      select 1 from public.phx_v_sales_pharmacy_code_candidates c
      where c.distributor_id = r.distributor_id
        and c.normalized_pharmacy_code = r.normalized_pharmacy_code
    );

  -- ADDITIVE INSERT. A pair already present under this distributor is skipped no matter which
  -- source_file owns it — that is the whole fix. Two separate `not exists` clauses rather than one
  -- OR so each is an index probe (marketing_pharmacy_code_refs_norm_lookup_idx and
  -- marketing_pharmacy_code_refs_compact_lookup_idx); an OR here degrades to a sequential scan.
  --
  -- compact_pharmacy_code is derived FROM normalized_pharmacy_code, so the compact clause already
  -- implies the normalized one and no query can tell them apart. Keep both anyway: the normalized
  -- clause is the one that mirrors what PASS 1 of resolvePharmacyCodeReference matches on, and the
  -- one that still holds if compact_pharmacy_code is ever dropped or redefined.
  --
  -- `c.distributor_active` is the second thing that stops a re-run undoing owner decisions. On
  -- 2026-08-19 the owner pruned the vendor list to 12 and MERGED two of the sync's own vendors into
  -- their parents — Ibn Sina-Sato into Ibn sina (3,949 codes) and EPDA-Pharmacies into epda (1,571).
  -- The merge re-pointed those codes onto a DIFFERENT distributor_id, so the guards above cannot see
  -- them: measured on production, a run without this clause would rebuild all 5,520 rows under the
  -- two hidden vendors and quietly undo both merges. A hidden vendor is unreachable from the Vendor
  -- picker by design, so a code created under one is invisible work at best.
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

revoke all on function public.phx_sync_sales_pharmacy_codes_into_marketing() from public;
revoke all on function public.phx_sync_sales_pharmacy_codes_into_marketing() from authenticated;
grant execute on function public.phx_sync_sales_pharmacy_codes_into_marketing() to service_role;

comment on function public.phx_sync_sales_pharmacy_codes_into_marketing() is
  'Idempotent: copies source_of_sales_customer_map into marketing_pharmacy_code_references, '
  'bridged to a marketing distributor by normalized name. Additive — never inserts a '
  '(distributor_id, normalized_pharmacy_code) pair that already exists under ANY source_file, '
  'because a duplicate makes the Customer Validation lookup report ambiguous. Retires only its '
  'own rows that the live map no longer justifies and that nothing references. Server-only '
  '(service_role).';
