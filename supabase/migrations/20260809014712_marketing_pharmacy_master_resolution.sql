-- Resolve marketing pharmacy codes against the Source-of-Sales customer master.
--
-- WHY: Marketing is the only side of the house that never resolves its pharmacy codes against the
-- company's customer master. Direct Orders already does — direct_order_pharmacy_distributor_codes
-- carries mapped_brick_id / mapped_area_code / mapped_region_code, populated from
-- source_of_sales_customer_map (see src/lib/direct-orders/service.ts and
-- 20260807000000_direct_orders_pharmacy_rpc.sql). Marketing has nothing equivalent, so today:
--   * marketing_pharmacies holds real geography for only 3 of 289 codes; and
--   * nothing can distinguish "this code IS in the master" from "nobody ever checked".
-- Those two states look identical (both empty), which is precisely the gap this closes.
--
-- WHAT THIS IS NOT: this is deliberately NOT a marketing <-> direct-order cross-link table. That
-- would be a THIRD registry to keep in sync with the other two. Both sides instead resolve against
-- the one master that already exists, independently, and agree because they agree with it.
--
-- WHY THE ROLLUP HOP IS REQUIRED (this is the trap that killed the ROI direct branch):
-- marketing_distributors.distributor_code holds SYNTHETIC surrogates minted by the marketing
-- module — 'DST_IBN_SINA_9DBF268F', 'DST_CHIMIPHARM_D590ED0B', ... — which match NOTHING in
-- Source of Sales. Comparing it directly to a real SoS distributor code yields 0 rows, silently.
-- That exact mistake made phx_marketing_request_roi_actuals_v2's direct_hits branch dead on
-- arrival, and was only fixed on 2026-08-08 by
-- 20260808231742_marketing_roi_direct_branch_routes_through_rollup.sql. The supported hop is:
--     marketing_distributors.normalized_name
--       -> marketing_roi_distributor_rollup.marketing_normalized_name
--       -> marketing_roi_distributor_rollup.sos_distributor_code   (a CODE FAMILY, e.g.
--          'ibn sina' -> IS / IS-S / IS-T)
-- The resolver below uses that hop and only that hop. Never compare
-- marketing_distributors.distributor_code to a Source-of-Sales code.
--
-- WHY NULL IS NOT 'unresolved' — THE WHOLE POINT, DO NOT COLLAPSE THESE:
--   master_match_kind IS NULL      -> the resolver has NEVER RUN for this row. No claim is made.
--   master_match_kind = 'unresolved' -> the resolver DID run and found no candidate in the master.
-- Existing rows keep NULL on purpose, so "not yet checked" stays distinguishable from "checked and
-- genuinely absent". Giving this column a DEFAULT, or backfilling it to 'unresolved', destroys that
-- distinction permanently and must never be done.
--
-- WHY AMBIGUOUS NEVER AUTO-LINKS: when one marketing code matches master rows sitting on MORE THAN
-- ONE brick, there is no way to know which pharmacy is meant. Copying a guess is how one campaign's
-- ROI ends up crediting a different pharmacy's customer. An ambiguous row therefore records the
-- VERDICT ONLY and leaves every mapped_* column NULL — and the update below actively CLEARS them,
-- so a row that was 'exact' and later becomes ambiguous cannot keep a stale identity.
--
-- MEASURED EXPECTATION (read-only replay against production, 2026-08-08, over 289 active codes):
--     exact             269
--     ambiguous           6
--     digit_normalized    0
--     unresolved         14
--                    ------
--                       289
-- and 0 codes whose distributor has no rollup family. If a future run disagrees with these, the
-- DISCREPANCY IS THE FINDING — investigate it, do not tune the resolver until the numbers match.
-- Acceptance fixture: code '432680' (pharmacy '(مصر)حازم', distributor 'Ibn sina', family IS/IS-S/
-- IS-T) must resolve 'exact' with mapped_brick_id = 'B101-10' and mapped_area_code = 'D25'.
--
-- DIGIT NORMALIZATION RESOLVES NOTHING TODAY, ON PURPOSE. Measured: 193 marketing codes and 28,576
-- master codes both carry leading zeros, so plain equality already covers every current row and
-- pass 2 contributes exactly 0. It is kept as a FORWARD GUARD against padding drift, which the
-- Direct Orders module documents as a real hazard. Do not delete it because it "does nothing", and
-- do not claim it fixes anything now.
--
-- master_match_kind IS NOT reference_status. The pre-existing reference_status column tracks a
-- different question (matching against marketing_pharmacy_code_references) and has its own
-- 'ambiguous' value. The two are unrelated; neither is derived from the other.
--
-- NOTHING READS THESE COLUMNS YET. This migration is deliberately data-only: no TypeScript, no UI,
-- no route. No surface changes behaviour when it lands.
--
-- CAUTION for whoever edits this next: CREATE OR REPLACE FUNCTION silently DROPS any setting
-- previously applied via ALTER FUNCTION ... SET. Both search_path and statement_timeout are
-- declared in the CREATE header below on purpose (45s, matching the sibling marketing RPCs).
-- Removing the timeout drops this function to the 8s authenticator default;
-- tests/report-rpc-guardrails.test.ts replays every migration to catch exactly that.
--
-- Re-runnable throughout: add column if not exists, drop-then-add for the constraint, and
-- CREATE OR REPLACE for the function. The resolver itself is idempotent — it recomputes every
-- targeted row from scratch and overwrites, so running it twice yields identical values.

begin;

-- 1. Resolution columns. All additive and NULLABLE with NO default, so an existing row keeps
--    meaning "not resolved yet" (see the NULL-vs-'unresolved' note above). Names mirror the
--    Direct Orders convention on direct_order_pharmacy_distributor_codes.
alter table public.marketing_pharmacy_distributor_codes
  add column if not exists mapped_distributor_code text,
  add column if not exists mapped_customer_code    text,
  add column if not exists mapped_brick_id         text,
  add column if not exists mapped_area_code        text,
  add column if not exists mapped_region_code      text,
  add column if not exists master_match_kind       text,
  add column if not exists master_resolved_at      timestamptz;

alter table public.marketing_pharmacy_distributor_codes
  drop constraint if exists marketing_pharmacy_distributor_codes_master_match_kind_check;

alter table public.marketing_pharmacy_distributor_codes
  add constraint marketing_pharmacy_distributor_codes_master_match_kind_check
  check (
    master_match_kind is null
    or master_match_kind in ('exact', 'digit_normalized', 'ambiguous', 'unresolved')
  );

comment on column public.marketing_pharmacy_distributor_codes.master_match_kind is
  'How this code resolved against source_of_sales_customer_map: exact | digit_normalized | '
  'ambiguous | unresolved. NULL means the resolver has NOT RUN for this row, which is NOT the same '
  'as ''unresolved'' (resolver ran, found nothing in the master) — never collapse the two, never '
  'give this column a default, never backfill NULL to ''unresolved''. ''ambiguous'' (>1 candidate '
  'brick) deliberately leaves every mapped_* column NULL: guessing an identity would credit one '
  'pharmacy''s sales to another. Set only by phx_resolve_marketing_pharmacy_codes().';

comment on column public.marketing_pharmacy_distributor_codes.master_resolved_at is
  'When phx_resolve_marketing_pharmacy_codes() last evaluated this row. Stamped for EVERY verdict '
  'including ambiguous and unresolved, so "checked recently, still no match" is visible. NULL '
  'means never evaluated.';

comment on column public.marketing_pharmacy_distributor_codes.mapped_brick_id is
  'Brick from source_of_sales_customer_map, copied ONLY when the code resolves to exactly one '
  'distinct brick. NULL for ambiguous and unresolved rows by design. The brick is the '
  'authoritative geography — area/region below are carried from the same master row, never '
  'inferred from the requester.';

-- 2. The resolver.
--    Set-based (no row loops): one UPDATE over the whole targeted set, summarised from its own
--    RETURNING clause so the reported counts are provably the rows actually written.
--
--    p_code_ids IS NULL  -> resolve every ACTIVE code (the 289 above).
--    p_code_ids NOT NULL -> resolve exactly those ids, active or not (an explicit id is honoured).
create or replace function public.phx_resolve_marketing_pharmacy_codes(p_code_ids uuid[] default null)
returns table(match_kind text, code_count bigint)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
begin
  return query
  with fam as (
    -- The mandatory rollup hop: marketing distributor -> its SoS code FAMILY.
    select md.id as distributor_id,
           array_agg(distinct ru.sos_distributor_code) as sos_codes
    from public.marketing_distributors md
    join public.marketing_roi_distributor_rollup ru
      on ru.marketing_normalized_name = md.normalized_name
    group by md.id
  ),
  target as (
    -- LEFT join: a distributor with no rollup family must still receive a verdict
    -- ('unresolved'), never be silently dropped from the run.
    select mpdc.id, mpdc.normalized_pharmacy_code, fam.sos_codes
    from public.marketing_pharmacy_distributor_codes mpdc
    left join fam on fam.distributor_id = mpdc.distributor_id
    where (p_code_ids is null or mpdc.id = any(p_code_ids))
      and (p_code_ids is not null or coalesce(mpdc.active, true))
  ),
  exact_c as (
    -- PASS 1 — exact code equality within the distributor's family.
    select t.id, cm.distributor_code, cm.customer_code, cm.brick_id, cm.area_code, cm.region_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and lower(btrim(cm.customer_code)) = t.normalized_pharmacy_code
  ),
  digit_c as (
    -- PASS 2 — digit-normalized (leading zeros stripped), ONLY for codes pass 1 left unmatched,
    -- and only where BOTH sides are purely numeric. Resolves 0 rows today; forward guard only.
    select t.id, cm.distributor_code, cm.customer_code, cm.brick_id, cm.area_code, cm.region_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and t.normalized_pharmacy_code ~ '^[0-9]+$'
     and btrim(cm.customer_code) ~ '^[0-9]+$'
     and ltrim(btrim(cm.customer_code), '0') = ltrim(t.normalized_pharmacy_code, '0')
    where not exists (select 1 from exact_c e where e.id = t.id)
  ),
  cand as (
    select 'exact'::text as kind, id, distributor_code, customer_code, brick_id, area_code, region_code
    from exact_c
    union all
    select 'digit_normalized'::text as kind, id, distributor_code, customer_code, brick_id, area_code, region_code
    from digit_c
  ),
  agg as (
    -- min(kind) is safe: by construction every candidate for one id comes from a single pass
    -- (pass 2 only runs where pass 1 found nothing), so the kind is constant within a group.
    select c.id,
           min(c.kind)              as kind,
           count(distinct c.brick_id) as bricks
    from cand c
    group by c.id
  ),
  pick as (
    -- ONE canonical candidate row per code, so all five copied values come from the SAME master
    -- row and can never be spliced together from two different ones.
    --
    -- A deterministic tie-break is REQUIRED, not cosmetic: 46 of the 269 exact codes match TWO
    -- master rows — same brick/area/region, different family member (e.g. '432680' matches both
    -- 'IS' and 'IS-S'). Without an explicit order, mapped_distributor_code would flip between runs
    -- and the resolver would not be idempotent. Measured on production: where a code matches its
    -- family's parent_distributor_code at all, the lexicographic minimum IS that parent in 100% of
    -- cases, so plain ascending order is also the semantically right pick — and unlike a
    -- parent-preference rule it still decides the 2 codes that match no parent row.
    select distinct on (c.id)
           c.id, c.distributor_code, c.customer_code, c.brick_id, c.area_code, c.region_code
    from cand c
    order by c.id, c.distributor_code, c.customer_code, c.brick_id
  ),
  verdict as (
    select t.id,
           case
             when a.id is null   then 'unresolved'        -- no candidate at all
             when a.bricks = 1   then a.kind              -- 'exact' | 'digit_normalized'
             when a.bricks > 1   then 'ambiguous'         -- >1 distinct brick: never auto-link
             -- bricks = 0: candidates exist but every one carries a NULL brick, so there is no
             -- geography to copy and nothing to be ambiguous between. 0 rows today; treated as
             -- 'unresolved' because no identity can be asserted.
             else 'unresolved'
           end as kind
    from target t
    left join agg a on a.id = t.id
  ),
  upd as (
    update public.marketing_pharmacy_distributor_codes m
    set
      -- Copy identity ONLY on a single-brick verdict. The explicit NULLs are load-bearing: they
      -- CLEAR a previously mapped identity if a row later turns ambiguous or unresolved.
      mapped_distributor_code = case when v.kind in ('exact', 'digit_normalized') then p.distributor_code end,
      mapped_customer_code    = case when v.kind in ('exact', 'digit_normalized') then p.customer_code    end,
      mapped_brick_id         = case when v.kind in ('exact', 'digit_normalized') then p.brick_id         end,
      mapped_area_code        = case when v.kind in ('exact', 'digit_normalized') then p.area_code        end,
      mapped_region_code      = case when v.kind in ('exact', 'digit_normalized') then p.region_code      end,
      master_match_kind       = v.kind,
      master_resolved_at      = now()
      -- updated_at is deliberately NOT bumped: these are derived columns, and updated_at tracks
      -- edits to the code itself. master_resolved_at is this resolver's own audit stamp.
    from verdict v
    left join pick p on p.id = v.id
    where m.id = v.id
    returning m.master_match_kind
  )
  select u.master_match_kind, count(*)::bigint
  from upd u
  group by u.master_match_kind
  order by u.master_match_kind;
end;
$function$;

comment on function public.phx_resolve_marketing_pharmacy_codes(uuid[]) is
  'Resolves marketing pharmacy codes against source_of_sales_customer_map via the marketing_roi_'
  'distributor_rollup code family. Pass 1 exact, pass 2 digit-normalized (0 rows today, forward '
  'guard). Single distinct brick -> copies identity; >1 brick -> ''ambiguous'' with mapped_* left '
  'NULL; none -> ''unresolved''. NULL p_code_ids resolves every active code. Idempotent. Returns '
  'counts per verdict. Expected on production: 269 exact / 6 ambiguous / 0 digit / 14 unresolved.';

-- SECURITY DEFINER in `public` inherits PostgreSQL's default EXECUTE grant to PUBLIC, and both anon
-- and authenticated are members of PUBLIC — so this must be revoked from PUBLIC itself, not just
-- from those two roles. Revoking PUBLIC on a default ACL also strips service_role, hence the
-- explicit re-grant.
revoke execute on function public.phx_resolve_marketing_pharmacy_codes(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_resolve_marketing_pharmacy_codes(uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
