-- Honour manually-placed direct-order areas in the monthly closing.
--
-- Owner ruling, 2026-09-01: "honour the manual areas". Where a direct row carries a
-- hand-placed area, the closing places the money on that area. The blanket pre-August
-- floor that discarded them is retired and replaced by ONE named exception: July 2026,
-- whose placement is owned by the overlay in src/lib/sales/july-2026-direct-orders.ts.
-- The TypeScript half of this ruling is OVERLAY_OWNED_DIRECT_PERIODS in
-- src/lib/sales/closing-direct-area.ts; the two must stay in step.
--
-- Blast radius, measured on production before writing this (direct rollup rows carrying
-- a non-blank area code, by period and line):
--   2026-01  Anti Infective  17 rows / 10 areas / 189,319.95 EGP  <- STARTS being honoured
--   2026-01  Pedia           15 rows / no area at all            <- unchanged
--   2026-02 .. 2026-06       no direct rows carrying an area     <- unchanged
--   2026-07  Pedia           35 rows / 21 areas                  <- overlay-owned, unchanged
--   2026-07  Anti Infective   8 rows / 11 areas                  <- overlay-owned, unchanged
--   CNS                      no direct rows in ANY pre-August month
-- No direct rows exist before 2026-01. January was never published (it has no
-- monthly_closing_publications row), so no published closing changes. The floor sits
-- inside the `direct` CTE only, so indirect and retail rows are untouched.

-- 1,543 bytes, so it is restated in full rather than patched.
CREATE OR REPLACE FUNCTION public.phx_monthly_closing_direct(p_line text, p_period text)
 RETURNS TABLE(region_code text, area_code text, product_code text, sales_units numeric, sales_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  select
    f.region_code,
    -- Same period rule as phx_closing_channel_breakdown, and for the same reason: a direct
    -- row's own area is honoured, EXCEPT in July 2026, whose placement belongs to the
    -- owner's overlay in july-2026-direct-orders.ts. Blank means "this month has no area",
    -- which is what the retired 2026-08 floor returned for every earlier month.
    case when p_period <> '2026-07'
         then coalesce(nullif(btrim(f.area_code), ''), '') else '' end as area_code,
    f.product_code,
    sum(f.total_qty)    as sales_units,
    sum(f.direct_value) as sales_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b
    on b.id = f.batch_id and b.status = 'validated'
  where f.period = p_period
    and lower(btrim(f.official_line)) = lower(btrim(p_line))
    and f.is_direct
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.region_code,
           case when p_period <> '2026-07'
                then coalesce(nullif(btrim(f.area_code), ''), '') else '' end,
           f.product_code;
$function$;

-- phx_closing_channel_breakdown is ~12KB and guards two columns (area_code, brick_id).
-- Patched in place with assertions rather than restated, so a drifted definition aborts
-- the migration instead of being silently overwritten by a stale copy.
do $mig$
declare
  v_def text;
  v_old_pred text := $old$case when p_period >= '2026-08'$old$;
  v_new_pred text := $new$case when p_period <> '2026-07'$new$;
  v_old_note text := $oldn$so older months are untouched
      -- end to end. Mirrors DIRECT_AREA_STAMPED_FROM_PERIOD in src/lib/sales/closing-direct-area.ts.$oldn$;
  v_new_note text := $newn$so July is untouched
      -- end to end. Mirrors OVERLAY_OWNED_DIRECT_PERIODS in src/lib/sales/closing-direct-area.ts
      -- (owner ruling 2026-09-01: honour the manual areas; July alone is overlay-owned).$newn$;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname = 'phx_closing_channel_breakdown';

  if v_def is null then
    raise exception 'public.phx_closing_channel_breakdown not found - refusing to guess at its definition';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_old_pred, ''))) / length(v_old_pred);

  -- Idempotent: already rewritten is a clean no-op, not a failure. Anything else still aborts,
  -- so a genuinely drifted definition cannot slip through as "already done".
  if v_hits = 0
     and (length(v_def) - length(replace(v_def, v_new_pred, ''))) / length(v_new_pred) = 2 then
    raise notice 'phx_closing_channel_breakdown already carries the overlay rule - nothing to rewrite';
    return;
  end if;

  if v_hits <> 2 then
    raise exception 'phx_closing_channel_breakdown: expected 2 occurrences of the period floor (area_code, brick_id), found % - the definition has drifted, aborting', v_hits;
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_old_note, ''))) / length(v_old_note);
  if v_hits <> 1 then
    raise exception 'phx_closing_channel_breakdown: expected 1 occurrence of the floor comment, found % - the definition has drifted, aborting', v_hits;
  end if;

  v_def := replace(v_def, v_old_pred, v_new_pred);
  v_def := replace(v_def, v_old_note, v_new_note);

  if position(v_old_pred in v_def) > 0 then
    raise exception 'phx_closing_channel_breakdown: the old floor survived the rewrite';
  end if;
  v_hits := (length(v_def) - length(replace(v_def, v_new_pred, ''))) / length(v_new_pred);
  if v_hits <> 2 then
    raise exception 'phx_closing_channel_breakdown: expected 2 rewritten predicates, found %', v_hits;
  end if;

  execute v_def;
end
$mig$;

-- Re-read both functions from the live catalogue and refuse to leave the floor behind.
do $verify$
declare
  v_fn  text;
  v_def text;
begin
  foreach v_fn in array array['phx_monthly_closing_direct', 'phx_closing_channel_breakdown'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname = v_fn;

    if v_def is null then
      raise exception 'public.% is missing after the rewrite', v_fn;
    end if;
    if position($chk$case when p_period >= '2026-08'$chk$ in v_def) > 0 then
      raise exception 'public.%: the installed function still carries the retired 2026-08 floor', v_fn;
    end if;
    if position($chk2$case when p_period <> '2026-07'$chk2$ in v_def) = 0 then
      raise exception 'public.%: the overlay rule is absent from the installed function', v_fn;
    end if;
  end loop;
end
$verify$;

-- Reassert the ACL these two functions already carry, so the migration is self-sufficient.
--
-- CREATE OR REPLACE does not reset a function's ACL, so against production this is a no-op —
-- both functions already sit at `postgres, service_role` (plus analytics_readonly on the direct
-- one) with no PUBLIC entry. It matters on a fresh replay, where the function would otherwise be
-- created with the default PUBLIC EXECUTE. anon and authenticated inherit EXECUTE *through*
-- PUBLIC, so revoking only those two would be a no-op: PUBLIC is the operative grantee.
revoke execute on function public.phx_monthly_closing_direct(text, text) from public;
grant  execute on function public.phx_monthly_closing_direct(text, text) to service_role;

revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) from public;
grant  execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[]) to service_role;

-- analytics_readonly is a production-only role; a fresh local or staging database may not have it.
do $acl$
begin
  if exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    execute 'grant execute on function public.phx_monthly_closing_direct(text, text) to analytics_readonly';
  end if;
end
$acl$;
