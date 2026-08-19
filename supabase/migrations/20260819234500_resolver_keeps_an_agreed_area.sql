-- Marketing master resolution: an ambiguous IDENTITY must not throw away an agreed TERRITORY.
--
-- WHAT WAS WRONG. `phx_resolve_marketing_pharmacy_codes` decides its verdict from ONE number --
-- `count(distinct brick_id)` across the candidate rows in `source_of_sales_customer_map`. Two
-- candidates, two bricks, verdict `ambiguous`; and the UPDATE then fills `mapped_*` only for
-- `exact` / `digit_normalized`, so an ambiguous row is written back with EVERY mapped column null.
-- The area is discarded even when every candidate agrees on it.
--
-- That is not a hypothetical. Measured on production 2026-08-19 over every active marketing
-- pharmacy code: 8 ambiguous, and SIX OF THE EIGHT had all their candidates inside ONE area -- only
-- 2 genuinely disagreed. The six were not unknowable; the function knew and dropped the answer.
--
-- WHAT IT COST. A marketing customer's territory is derived from its pharmacy's `mapped_area_code`,
-- and since PR #2223 the area is what decides who can SEE that customer -- the owner's rule of
-- 2026-08-19: "they must be assigned to areas... the employee resigns and another one is hired in
-- his place, he finds his customers automatically." So a discarded area is not a cosmetic gap in a
-- mapping column. It is a customer nobody in the field can see. One marketing customer sat
-- unassigned for exactly this reason: its Ibn Sina code 357887 exists under distributor `IS`
-- (brick B177-1, sheet-verified, with an exactly matching customer name) and under `IS-S`
-- (brick B108-73) -- different bricks, and BOTH in area AB2, Alex Center.
--
-- WHAT CHANGES. The verdict vocabulary does not: `master_match_kind` stays one of
-- exact / digit_normalized / ambiguous / unresolved, so the CHECK constraint, every consumer and
-- every report keep their current meaning, and `ambiguous` still means "the shop identity is not
-- pinned" -- because it genuinely is not. What changes is that an ambiguous row now KEEPS the
-- columns its candidates agree on:
--
--   mapped_area_code / mapped_region_code     filled when every candidate carries the same one
--   mapped_brick_id                           still null -- the bricks are what disagreed
--   mapped_distributor_code / _customer_code  still null -- the identity is what is ambiguous
--
-- A row is therefore self-describing: an area with no brick and no customer code reads as "we know
-- the territory, we do not know which shop row", which is exactly true. Nothing infers identity
-- from an area being present, and nothing may start to.
--
-- The agreement test is deliberately strict. `count(distinct x)` ignores NULLs, so a candidate with
-- no area would otherwise let a single other candidate speak for the whole set. Agreement therefore
-- requires BOTH that the distinct count is 1 AND that no candidate is missing the value.
--
-- exact / digit_normalized behaviour is untouched, on purpose: their branch is written out
-- separately rather than folded into the new one, so this migration cannot regress the 294 rows
-- that already resolve.
--
-- Re-running the resolver over the existing rows is NOT done here. This migration ships the rule;
-- the backfill is a separate, explicit call to the RPC with the ambiguous ids, so that the repair
-- runs through the shipped code path and proves it.

create or replace function public.phx_resolve_marketing_pharmacy_codes(p_code_ids uuid[] default null::uuid[])
returns table(match_kind text, code_count bigint)
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
begin
  return query
  with fam as (
    select md.id as distributor_id,
           array_agg(distinct ru.sos_distributor_code) as sos_codes
    from public.marketing_distributors md
    join public.marketing_roi_distributor_rollup ru
      on ru.marketing_normalized_name = md.normalized_name
    group by md.id
  ),
  target as (
    select mpdc.id, mpdc.normalized_pharmacy_code, fam.sos_codes
    from public.marketing_pharmacy_distributor_codes mpdc
    left join fam on fam.distributor_id = mpdc.distributor_id
    where (p_code_ids is null or mpdc.id = any(p_code_ids))
      and (p_code_ids is not null or coalesce(mpdc.active, true))
  ),
  exact_c as (
    select t.id, cm.distributor_code, cm.customer_code, cm.brick_id, cm.area_code, cm.region_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and lower(btrim(cm.customer_code)) = t.normalized_pharmacy_code
  ),
  digit_c as (
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
    select c.id,
           min(c.kind)                as kind,
           count(distinct c.brick_id) as bricks,
           -- The territory columns get their own agreement test, independent of the brick.
           count(distinct c.area_code)                   as areas,
           count(*) filter (where c.area_code is null)   as areas_missing,
           count(distinct c.region_code)                 as regions,
           count(*) filter (where c.region_code is null) as regions_missing
    from cand c
    group by c.id
  ),
  pick as (
    select distinct on (c.id)
           c.id, c.distributor_code, c.customer_code, c.brick_id, c.area_code, c.region_code
    from cand c
    order by c.id, c.distributor_code, c.customer_code, c.brick_id
  ),
  verdict as (
    select t.id,
           case
             when a.id is null   then 'unresolved'
             when a.bricks = 1   then a.kind
             when a.bricks > 1   then 'ambiguous'
             else 'unresolved'
           end as kind,
           -- Agreed = every candidate carries the value, and they all carry the same one. Any
           -- candidate missing it means the set does not speak with one voice, so we say nothing.
           coalesce(a.areas = 1 and a.areas_missing = 0, false)     as area_agreed,
           coalesce(a.regions = 1 and a.regions_missing = 0, false) as region_agreed
    from target t
    left join agg a on a.id = t.id
  ),
  upd as (
    update public.marketing_pharmacy_distributor_codes m
    set
      -- Identity: only ever written for a pinned match. Unchanged.
      mapped_distributor_code = case when v.kind in ('exact', 'digit_normalized') then p.distributor_code end,
      mapped_customer_code    = case when v.kind in ('exact', 'digit_normalized') then p.customer_code    end,
      mapped_brick_id         = case when v.kind in ('exact', 'digit_normalized') then p.brick_id         end,
      -- Territory: written for a pinned match exactly as before, and ALSO for an ambiguous one
      -- whose candidates all agree. `pick` is safe to read here precisely because they agree --
      -- whichever candidate it chose carries the same value as the rest.
      mapped_area_code        = case
                                  when v.kind in ('exact', 'digit_normalized') then p.area_code
                                  when v.kind = 'ambiguous' and v.area_agreed  then p.area_code
                                end,
      mapped_region_code      = case
                                  when v.kind in ('exact', 'digit_normalized') then p.region_code
                                  when v.kind = 'ambiguous' and v.region_agreed then p.region_code
                                end,
      master_match_kind       = v.kind,
      master_resolved_at      = now()
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

-- Re-stated because this file must stand on its own. CREATE OR REPLACE preserves the existing ACL,
-- so on a live database these are a no-op — but a function created fresh from this migration would
-- otherwise inherit PostgreSQL's default EXECUTE grant to PUBLIC, and both anon and authenticated
-- are members of PUBLIC. Revoking only those two is a no-op; PUBLIC itself has to go, and because
-- revoking PUBLIC on a default ACL also strips service_role, the re-grant must be explicit.
revoke execute on function public.phx_resolve_marketing_pharmacy_codes(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_resolve_marketing_pharmacy_codes(uuid[]) to service_role;
