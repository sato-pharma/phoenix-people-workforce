-- Marketing ROI & Customer dashboard — server-side confidential-product exclusion.
--
-- Adds p_exclude_codes (text[]) to phx_marketing_roi_customer_dashboard so the confidential
-- products (LA003 / LA004 "Lacto Basic 1 & 2" and SS001 "Satoslim") are stripped INSIDE the RPC
-- for every role except a CEO / Super Admin caller (who passes '{}'). The filter is injected into
-- the materialized `req_products` CTE, so every downstream aggregate — summary, customer / region /
-- distributor / product / line ROI, request report, ROI trend and attribution health — inherits the
-- exclusion at source. Previously only the per-product rows were stripped in app code, leaving the
-- aggregates inflated for Marketing Manager / SFE Manager.
--
-- This RPC is volatile and dynamically assembled by sibling migrations (they pg_get_functiondef →
-- string-replace → execute on the SAME 10-arg signature). To ADD a parameter we must DROP the
-- 10-arg function and CREATE an 11-arg version. We build the new body FROM THE LIVE DEFINITION via
-- pg_get_functiondef so this composes on top of whatever the latest body is (line-from-requester,
-- region rollups, …) instead of reverting it. Both anchors are guarded: if the RPC shape has
-- drifted so an anchor is missing, we RAISE rather than silently mis-apply. statement_timeout and
-- the service_role-only grants are re-applied because DROP/CREATE resets them (PUBLIC would
-- otherwise regain EXECUTE). The exclusion idiom mirrors 20260611120000_sales_intelligence_rpcs.sql.

do $mig$
declare
  def text;
  v_new oid := to_regprocedure('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])');
  v_old oid := to_regprocedure('public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)');
begin
  if v_new is not null then
    raise notice 'phx_marketing_roi_customer_dashboard already has p_exclude_codes; skipping body rebuild.';
    return;
  end if;
  if v_old is null then
    raise exception 'phx_marketing_roi_customer_dashboard(10-arg) not found; base RPC missing, cannot add p_exclude_codes.';
  end if;

  def := pg_get_functiondef(v_old);

  -- 1) Signature: append p_exclude_codes after p_limit.
  if position('p_limit integer DEFAULT 100)' in def) = 0 then
    raise exception 'signature anchor "p_limit integer DEFAULT 100)" not found; RPC signature drifted, aborting.';
  end if;
  def := replace(
    def,
    'p_limit integer DEFAULT 100)',
    $s$p_limit integer DEFAULT 100, p_exclude_codes text[] DEFAULT '{}'::text[])$s$
  );

  -- 2) Body: filter the materialized req_products CTE by p_exclude_codes. Anchor on the WHOLE CTE
  --    so a drifted body fails the guard instead of partially matching.
  if position($a$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
  ),$a$ in def) = 0 then
    raise exception 'req_products CTE anchor not found; RPC body drifted, aborting to avoid silent mis-apply.';
  end if;
  def := replace(
    def,
    $a$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
  ),$a$,
    $r$  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(coalesce(rpa.product_code, ''))) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
  ),$r$
  );

  -- 3) Swap the 10-arg function for the 11-arg version built above.
  execute 'drop function if exists public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)';
  execute def;
end
$mig$;

-- Re-assert hardening that a DROP/CREATE resets (on the new 11-arg signature).
alter function public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])
  set statement_timeout to '45s';
revoke all on function public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])
  from public, anon, authenticated;
grant execute on function public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer,text[])
  to service_role;

notify pgrst, 'reload schema';
