-- WHAT: public.phx_preview_marketing_pharmacy_code_matches(uuid[]) also returns the master area's NAME
--   (area_name), beside its code. Same matching, still read-only, still service_role only.
-- WHY: the Marketing Control re-check list (REC-077, 20261114152653) shows a person the master's area
--   by name. Marketing code may neither read `areas` directly (the performance ratchet,
--   tests/performance-phase-3.test.ts, is never raised) nor through the cached reference lists (marketing
--   requests keep their own fresh reads, tests/reference-list-cache.test.ts), so the name comes back with the
--   match. Area codes can repeat across lines, so the name is one scalar read, never a join that could
--   duplicate a match row.
--   The function is new today and has no other caller, so it is dropped and created again: a changed
--   OUT column cannot be made with create or replace.
-- ROLLBACK: re-run the function block of 20261114152653_marketing_pharmacy_code_recheck.sql after
--           drop function if exists public.phx_preview_marketing_pharmacy_code_matches(uuid[]);

drop function if exists public.phx_preview_marketing_pharmacy_code_matches(uuid[]);

create function public.phx_preview_marketing_pharmacy_code_matches(p_code_ids uuid[])
returns table (
  code_id uuid,
  match_kind text,
  distributor_code text,
  customer_code text,
  customer_name text,
  area_code text,
  area_name text
)
language sql
stable
security invoker
set search_path to 'public'
set statement_timeout to '45s'
as $function$
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
    where coalesce(cardinality(p_code_ids), 0) > 0
      and mpdc.id = any(p_code_ids)
  ),
  exact_c as (
    select t.id, cm.distributor_code, cm.customer_code, cm.customer_name, cm.brick_id, cm.area_code
    from target t
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = any(t.sos_codes)
     and coalesce(cm.active, true)
     and lower(btrim(cm.customer_code)) = t.normalized_pharmacy_code
  ),
  digit_c as (
    select t.id, cm.distributor_code, cm.customer_code, cm.customer_name, cm.brick_id, cm.area_code
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
    select 'exact'::text as kind, * from exact_c
    union all
    select 'digit_normalized'::text as kind, * from digit_c
  ),
  agg as (
    select c.id, min(c.kind) as kind, count(distinct c.brick_id) as bricks
    from cand c
    group by c.id
  ),
  pick as (
    select distinct on (c.id) c.id, c.distributor_code, c.customer_code, c.customer_name, c.area_code
    from cand c
    order by c.id, c.distributor_code, c.customer_code, c.brick_id
  )
  -- The same verdict the resolver would write: one brick pins the shop, more than one is ambiguous.
  select a.id,
         case when a.bricks = 1 then a.kind else 'ambiguous' end,
         case when a.bricks = 1 then p.distributor_code end,
         case when a.bricks = 1 then p.customer_code end,
         case when a.bricks = 1 then p.customer_name end,
         case when a.bricks = 1 then p.area_code end,
         case when a.bricks = 1 then (select min(ar.name) from public.areas ar where ar.code = p.area_code) end
  from agg a
  join pick p on p.id = a.id;
$function$;

revoke execute on function public.phx_preview_marketing_pharmacy_code_matches(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_preview_marketing_pharmacy_code_matches(uuid[]) to service_role;
