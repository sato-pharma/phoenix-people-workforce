-- Write production's `phx_customer_directory` back into the repo.
--
-- THE DEFECT (found 2026-08-05 by auditing all 191 migration files against the live catalog):
-- production's `public.phx_customer_directory` resolves Client Address with a fallback onto
-- `source_of_sales_customer_map.address`, and **no migration in this repo records that**. The
-- only definition the repo carries is the 2026-07-11 snapshot inside
-- 20260711135352_phoenix_production_schema_baseline.sql, which has neither the coalesce nor the
-- join. The change was applied straight to production and never written back.
--
-- WHY NOTHING CAUGHT IT: 20260802022100_fail_closed_exclude_codes_defaults.sql does touch this
-- function, but it is catalog-driven on purpose — it reads pg_get_functiondef() from whatever is
-- live and re-emits it with only the `p_exclude_codes` default substring replaced. That keeps the
-- body byte-identical to whatever it found, which is exactly why it never captured the body into
-- the repo. Object-existence checks cannot see this either: the function exists, it is simply the
-- wrong one.
--
-- PROOF IT BITES (measured the same day on both projects):
--   production ozucdzovmcqvepbozvqf  ->  prosrc contains `source_of_sales_customer_map m`  = TRUE
--   staging    cifwmndunmlxjhyjugxa  ->  prosrc contains `source_of_sales_customer_map m`  = FALSE
-- Staging was built from these migrations, and it already carries the regressed function. It has
-- the fail-closed default and every SET clause — only the address fallback is missing. So any
-- rebuild from supabase/migrations (scripts/staging-safe-rebuild.ts does exactly this) silently
-- ships a Client Address column that reads empty wherever the distributor row carried no address.
-- That is 19k rows filled by code match, per the SoS client-address rule.
--
-- WHAT THIS MIGRATION IS: the current production definition, transcribed verbatim. The body below
-- is byte-identical to production's `prosrc` today, so applying this to production is a genuine
-- no-op on behaviour; it exists to make the repo authoritative again. On a rebuilt database it is
-- the fix, and it runs after 20260802022100 so the fail-closed default is preserved rather than
-- reverted (it is restated explicitly below rather than inherited).
--
-- Deliberately NOT done here: no comment is added inside the function body. Keeping the body
-- character-for-character equal to live `prosrc` is what lets a future audit hash the two and get
-- a match instead of another false "stale function" hit.
--
-- Data impact: none — one function, no DML, no schema change.
-- Rollback: re-run 20260802022100_fail_closed_exclude_codes_defaults.sql, which will re-emit
--           whatever definition is live at that moment; or restore the baseline body from
--           20260711135352_phoenix_production_schema_baseline.sql if the fallback must go.

begin;

create or replace function public.phx_customer_directory(
  p_region_codes      text[] default null::text[],
  p_area_codes        text[] default null::text[],
  p_brick_codes       text[] default null::text[],
  p_distributor_codes text[] default null::text[],
  p_from_period       text   default null::text,
  p_to_period         text   default null::text,
  p_exclude_codes     text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text]
)
returns table (
  client_code      text,
  client_name      text,
  client_address   text,
  distributor_code text,
  brick_id         text,
  area_code        text,
  region_code      text,
  total_units      numeric,
  total_value      numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
set work_mem to '128MB'
as $function$
  with filtered as materialized (
    select
      c.client_code,
      c.client_name,
      c.client_address,
      c.distributor_code,
      c.brick_id,
      c.area_code,
      c.region_code,
      c.latest_row_created_at,
      c.total_qty,
      c.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code,
      distributor_code,
      client_name,
      client_address,
      brick_id,
      area_code,
      region_code
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty) as total_units,
      sum(line_value) as total_value
    from filtered
    group by client_code, distributor_code
  )
  select
    a.client_code,
    l.client_name,
    coalesce(
      nullif(btrim(l.client_address), ''),
      nullif(btrim(m.address), ''),
      ''
    ) as client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code)
  left join public.source_of_sales_customer_map m
    on m.distributor_code = a.distributor_code
   and m.customer_code = a.client_code
   and m.active;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so on production these two statements re-assert
-- what is already live ({postgres=X/postgres,service_role=X/postgres}). They are stated anyway so
-- the migration is self-contained and satisfies the secdef revoke guard: a SECURITY DEFINER
-- function in `public` must never be executable by PUBLIC, because anon and authenticated inherit
-- EXECUTE through PUBLIC membership.
--
-- The GRANT is not optional. Revoking from PUBLIC on a default ACL also strips the implicit
-- EXECUTE that service_role relies on, which would break every server-side caller — the app
-- reaches this RPC exclusively through the service-role client.
revoke execute on function public.phx_customer_directory(
  text[], text[], text[], text[], text, text, text[]
) from public, anon, authenticated;

grant execute on function public.phx_customer_directory(
  text[], text[], text[], text[], text, text, text[]
) to service_role;

-- Fail loudly rather than silently shipping the regressed function again.
do $verify$
declare
  v_oid oid;
  v_src text;
begin
  select p.oid, p.prosrc
    into v_oid, v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'phx_customer_directory';

  if v_oid is null then
    raise exception 'phx_customer_directory is missing after this migration';
  end if;

  if v_src not like '%source_of_sales_customer_map m%' then
    raise exception 'phx_customer_directory has no Client Address fallback join - the regressed body is still live';
  end if;

  if v_src not like '%nullif(btrim(m.address)%' then
    raise exception 'phx_customer_directory does not coalesce onto m.address - Client Address would read empty';
  end if;

  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'service_role lost EXECUTE on phx_customer_directory';
  end if;

  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'phx_customer_directory is SECURITY DEFINER and must not be executable by anon/authenticated';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';

commit;
