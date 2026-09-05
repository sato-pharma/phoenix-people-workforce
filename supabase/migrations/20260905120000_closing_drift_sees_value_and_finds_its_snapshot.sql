-- A factory-price edit restates every closed month, and NOTHING could see it. Now something can.
--
-- SoS audit finding `supabase/migrations/20260801120000_sos_rollup_and_closing_sql_truth.sql:186`
-- — "Distributor value is never stored, so a factory_price edit silently restates every closed
-- month". Re-verified on production 2026-09-05.
--
-- ── The finding's implied remedy is FORBIDDEN, so this does the other half ───────────────────
-- "Store the value" means period-scoped prices, and the owner has ruled that out explicitly.
-- 2026-08-14, while training on monthly closings: every pre-July closing is valued at Phoenix's
-- CURRENT factory price for BOTH sales and target units — "our factory price / our known policy" —
-- and he "rejected both matching the manual's value and adding period-scoped prices". The
-- 2026-08-11 Saginko realignment (126.72 -> 111.15) deliberately "stands for all months".
--
-- So live re-valuation is INTENDED. What is not intended is that it happens invisibly. This makes
-- the restatement DETECTABLE and changes no number anywhere.
--
-- Nothing here touches the July 2026 Anti Infective publication. Owner decision 2026-09-04: it
-- stays exactly as published, is not to be corrected, and is not to be offered as correctable.
--
-- ── Why nothing detected it: three failures in a row, each enough on its own ─────────────────
-- Measured on production 2026-09-05:
--
--   1. NO SNAPSHOT IS EVER TAKEN AT PUBLISH. `monthly_closing_publications` carries all four
--      snapshot columns and all 3 published rows (Anti Infective / CNS / Pedia 2026-07) have them
--      NULL. No database function inserts into that table at all — the publish path writes it from
--      the app and never fills them.
--   2. THE DRIFT CHECK READS THE EMPTY TABLE. `phx_closing_publication_drift` looks in
--      `monthly_closing_publications`, so it returns its "(no snapshot)" sentinel for every line
--      and period. Meanwhile `phx_lock_monthly_closing` DOES snapshot, into a sibling table —
--      `monthly_closing_locks`, 14 rows, all 14 populated, covering all three published lines.
--      The detector and the data are in different tables.
--   3. EVEN WITH A SNAPSHOT IT COMPARES UNITS ONLY. Both the snapshot (`'u'`) and the comparison
--      are units. A price move changes value and never units, so it is invisible by construction.
--
-- Measured cost of that blindness, 2026-09-04: Royafloxacin RO001 went 60.75 -> 60.70 and eight
-- periods moved, 1,017.10 EGP in total (July -80.75, August -91.40), with nothing raised anywhere.
--
-- Proven on staging 2026-09-05 before this reached production: locked CNS 2026-06, moved TE003
-- 81.00 -> 80.95, and the check reported 49 cells and -558.80 EGP with units_delta = 0 on every
-- one of them — i.e. exactly the restatement the units-only version could not see. Price restored
-- and the test lock deleted.
--
-- ── What this changes ───────────────────────────────────────────────────────────────────────
--   A. The snapshot records VALUE per cell, on the same basis the rest of the module uses:
--      `case when is_direct then direct_value else effective_units * factory_price end`. That is
--      the house pattern (phx_exec_distributor_product, phx_exec_sos_trend, phx_exec_customers)
--      and it honours the direct-order rule: a direct row's value is its source value, never
--      units x factory price.
--   B. `phx_lock_monthly_closing` writes that value into the snapshot it already takes.
--   C. `phx_closing_publication_drift` compares value AND units, and FINDS a snapshot: the
--      publication's own if it has one, otherwise the lock snapshot in force when the closing was
--      published. It reports value drift only where the snapshot actually carries a value, so the
--      14 pre-existing snapshots (which have none) report units honestly rather than a fabricated
--      100% value drift.
--
-- Existing snapshots are deliberately NOT back-filled. A snapshot taken today would record the
-- CURRENT, already-restated figures as though they were what was published — cementing a false
-- baseline, and doing it to the one publication the owner has ruled untouchable.

-- ── A. the current shape, now including value ────────────────────────────────────────────────
-- Additive keys only ('v' per cell, 'value' total); every existing reader ignores what it does not
-- know, so the jsonb contract does not break.
CREATE OR REPLACE FUNCTION public.phx_closing_publication_snapshot(p_line text, p_period text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cells as (
    select f.area_code, f.product_code, coalesce(f.is_direct, false) as is_direct,
           sum(f.total_qty) as units,
           sum(case when coalesce(f.is_direct, false)
                    then coalesce(f.direct_value, 0)
                    else f.effective_units * coalesce(p.factory_price, 0)
               end) as value
    from source_of_sales_fact_rollup f
    left join source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(regexp_replace(f.official_line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
    group by 1, 2, 3
    having sum(f.total_qty) <> 0
  )
  select jsonb_build_object(
    'units', coalesce((select sum(units) from cells), 0),
    'value', coalesce((select sum(value) from cells), 0),
    'cells', (select count(*) from cells),
    'breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('a', area_code, 'p', product_code, 'd', is_direct,
                                          'u', units, 'v', value)
                       order by area_code, product_code, is_direct)
      from cells
    ), '[]'::jsonb)
  );
$function$;

-- ── B. the lock snapshot carries value too ───────────────────────────────────────────────────
-- This is the writer that actually runs today — 14 of 14 lock rows are populated, against 0 of 3
-- publication rows. Value goes into the existing jsonb; no column is added and the function's
-- return type (the monthly_closing_locks row) is untouched.
CREATE OR REPLACE FUNCTION public.phx_lock_monthly_closing(p_line text, p_period text, p_actor text DEFAULT NULL::text)
 RETURNS monthly_closing_locks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_norm text := lower(btrim(coalesce(p_line, '')));
  v_row  public.monthly_closing_locks;
  v_units numeric;
  v_cells integer;
begin
  if v_norm = '' or btrim(coalesce(p_period, '')) = '' then
    raise exception 'A line and a period are required to lock a closing.';
  end if;

  select coalesce(sum(total_qty), 0), count(*)
    into v_units, v_cells
    from public.source_of_sales_fact_rollup
   where period = p_period and lower(btrim(coalesce(official_line, ''))) = v_norm;

  insert into public.monthly_closing_locks
    (line, normalized_line, period, locked_by, snapshot_units, snapshot_cells, snapshot_breakdown)
  values
    (btrim(p_line), v_norm, btrim(p_period), p_actor, v_units, v_cells,
     (select jsonb_agg(jsonb_build_object('a', f.area_code, 'p', f.product_code, 'd', f.is_direct,
                                          'u', f.total_qty,
                                          'v', case when coalesce(f.is_direct, false)
                                                    then coalesce(f.direct_value, 0)
                                                    else f.effective_units * coalesce(pr.factory_price, 0)
                                               end))
        from public.source_of_sales_fact_rollup f
        left join public.source_of_sales_products pr
          on upper(btrim(pr.product_code)) = upper(btrim(f.product_code))
       where f.period = p_period and lower(btrim(coalesce(f.official_line, ''))) = v_norm))
  returning * into v_row;

  return v_row;
end;
$function$;

-- ── C. the drift check sees value, and finds a snapshot to compare against ───────────────────
-- The return type gains columns, which CREATE OR REPLACE cannot do — hence DROP first. Safe:
-- nothing in src/ or app/ calls this function (checked), it is a DB-side diagnostic.
drop function if exists public.phx_closing_publication_drift(text, text);

CREATE OR REPLACE FUNCTION public.phx_closing_publication_drift(p_line text, p_period text)
 RETURNS TABLE(area_code text, product_code text, is_direct boolean,
               published_units numeric, current_units numeric, units_delta numeric,
               published_value numeric, current_value numeric, value_delta numeric,
               snapshot_source text)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_published jsonb;
  v_source text;
  v_has_value boolean;
begin
  -- 1. the publication's own snapshot, if the publish path ever wrote one
  select snapshot_breakdown, 'publication'
    into v_published, v_source
  from monthly_closing_publications
  where lower(btrim(regexp_replace(line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
    and period = p_period
    and snapshot_taken_at is not null
    and snapshot_breakdown is not null
  limit 1;

  -- 2. otherwise the LOCK snapshot in force when it was published. `phx_lock_monthly_closing` is
  --    the writer that actually runs, and its rows are the only real baseline this system holds.
  --    Prefer the newest lock at or before publication; fall back to the earliest lock overall so
  --    a closing locked only after publishing still has something to compare.
  if v_published is null then
    select l.snapshot_breakdown, 'lock ' || to_char(l.locked_at, 'YYYY-MM-DD HH24:MI')
      into v_published, v_source
    from monthly_closing_locks l
    left join monthly_closing_publications pub
      on lower(btrim(regexp_replace(pub.line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
     and pub.period = p_period
    where lower(btrim(regexp_replace(l.line, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_line, '\s+', ' ', 'g')))
      and l.period = p_period
      and l.snapshot_breakdown is not null
    order by (l.locked_at <= coalesce(pub.published_at, 'infinity'::timestamptz)) desc,
             l.locked_at desc
    limit 1;
  end if;

  if v_published is null then
    return query select '(no snapshot)'::text, '(nothing has ever snapshotted this line/period)'::text,
                        null::boolean, null::numeric, null::numeric, null::numeric,
                        null::numeric, null::numeric, null::numeric, '(none)'::text;
    return;
  end if;

  -- Snapshots taken before value existed carry no 'v'. Report their value columns as NULL rather
  -- than 0, which would read as "the whole month's value appeared out of nowhere".
  -- jsonb_exists(), not the `?` operator: `?` is a bind placeholder to several Postgres clients
  -- and this function is reached through one.
  select bool_or(jsonb_exists(e, 'v')) into v_has_value from jsonb_array_elements(v_published) e;
  v_has_value := coalesce(v_has_value, false);

  -- BOTH sides are aggregated by cell, and the `published` one MUST be. The two snapshot writers
  -- disagree on shape: phx_closing_publication_snapshot GROUPS by cell, while
  -- phx_lock_monthly_closing dumps raw rollup ROWS. Measured on production 2026-09-05: 7,201
  -- cells hold more than one rollup row and the worst holds 546. Joining a lock snapshot raw
  -- against the grouped current shape would fan out to 546 rows for that single cell, every one
  -- reported as drift that does not exist. Summing per cell is a no-op on an already-grouped
  -- snapshot, and is the thing that makes a lock snapshot comparable at all.
  return query
  with published as (
    select e->>'a' as area_code, e->>'p' as product_code, (e->>'d')::boolean as is_direct,
           sum((e->>'u')::numeric) as units,
           case when v_has_value then sum((e->>'v')::numeric) else null end as value
    from jsonb_array_elements(v_published) e
    group by 1, 2, 3
  ),
  current_shape as (
    select c->>'a' as area_code, c->>'p' as product_code, (c->>'d')::boolean as is_direct,
           sum((c->>'u')::numeric) as units, sum((c->>'v')::numeric) as value
    from jsonb_array_elements(
      (phx_closing_publication_snapshot(p_line, p_period))->'breakdown'
    ) c
    group by 1, 2, 3
  )
  select coalesce(p.area_code, n.area_code),
         coalesce(p.product_code, n.product_code),
         coalesce(p.is_direct, n.is_direct),
         coalesce(p.units, 0),
         coalesce(n.units, 0),
         coalesce(n.units, 0) - coalesce(p.units, 0),
         p.value,
         case when v_has_value then coalesce(n.value, 0) else null end,
         case when v_has_value then coalesce(n.value, 0) - coalesce(p.value, 0) else null end,
         v_source || case when v_has_value then '' else ' (units only — snapshot predates value)' end
  from published p
  full outer join current_shape n
    on n.area_code = p.area_code and n.product_code = p.product_code and n.is_direct = p.is_direct
  where coalesce(n.units, 0) <> coalesce(p.units, 0)
     or (v_has_value and round(coalesce(n.value, 0), 2) <> round(coalesce(p.value, 0), 2))
  order by abs(coalesce(n.units, 0) - coalesce(p.units, 0)) desc,
           abs(coalesce(n.value, 0) - coalesce(p.value, 0)) desc;
end;
$function$;

-- ── grants: DROP discarded the ACL on the drift function, so re-state all three ──────────────
-- anon/authenticated inherit EXECUTE through PUBLIC, and revoking PUBLIC on a default ACL also
-- strips service_role — hence the explicit re-grant. These are SECURITY DEFINER functions over
-- the whole fact rollup.
revoke execute on function public.phx_closing_publication_drift(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_publication_drift(text, text) to service_role;

revoke execute on function public.phx_closing_publication_snapshot(text, text) from public, anon, authenticated;
grant  execute on function public.phx_closing_publication_snapshot(text, text) to service_role;

revoke execute on function public.phx_lock_monthly_closing(text, text, text) from public, anon, authenticated;
grant  execute on function public.phx_lock_monthly_closing(text, text, text) to service_role;
