-- freeze_only_the_published_line
--
-- WHAT THIS CHANGES: a published closing freezes ITS OWN LINE for that month, never the whole month.
--   phx_write_monthly_store_split_net, au.f_refresh_monthly_attribution and the stale-period sweep
--   au.f_refresh_stale_attribution_periods used to refuse a PERIOD as soon as ANY line was published
--   in it. They now keep only the published lines' rows untouched and rebuild every other line.
--
-- WHY: Anti Infective October 2026 was published 2026-11-04 19:36 Cairo, which froze the October
--   store split for Pedia and CNS as well, at its 2026-11-04 18:47 state. El Qema's October book
--   landed 2026-11-08 21:37 (4,114 Lacto packs at Al-Forsan Benha, Qalubeya) and was never spread,
--   so the unpublished Pedia October closing put every pack on Qalubeya and read its rep at 648%.
--   Nine CNS books landed after the freeze the same way. September 2026 had the same shape (Qalubeya
--   -624,623.51 EGP, docs/closing-publication-drift.md). The owner chose the per-line freeze on
--   2026-11-10 ("Unfreeze Pedia + CNS only").
--
--   FAILS CLOSED: a publication whose line maps to no line_code freezes the whole period, as before.
--   A period with every mapped line published is frozen exactly as before. Rollup rows with no
--   line_code stay frozen whenever any line of the period is published (they were frozen before too).
--
-- ROLLBACK: re-apply the three bodies from 20261026010000_db_load_sweep_skipscan_and_indexes.sql
--   (the sweep) and 20260929200000_serialize_attribution_refresh.sql /
--   20260927213000_freeze_attribution_for_published_months.sql (the two writers). No row is changed
--   by this file; only what later refreshes are allowed to rewrite.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

create or replace function public.phx_write_monthly_store_split_net(p_period text, p_rows jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_written  integer := 0;
  v_bad      text;
  v_unmapped text;
  v_frozen   text[];
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_write_monthly_store_split_net: period must be YYYY-MM, got %', p_period;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'phx_write_monthly_store_split_net: p_rows must be a jsonb array';
  end if;

  -- 🔒 A PUBLISHED LINE KEEPS ITS NET; THE OTHER LINES OF THE SAME MONTH DO NOT FREEZE WITH IT.
  -- Fails closed: a published line Phoenix cannot map to a line_code freezes the whole period.
  if exists (
    select 1 from public.monthly_closing_publications pub
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(pub.line))
    where pub.period = p_period and pub.unpublished_at is null
      and lm.line_code is null
  ) then
    raise notice 'phx_write_monthly_store_split_net: % has a published line with no line_code — leaving the whole period frozen', p_period;
    return 0;
  end if;

  v_frozen := array(
    select distinct lm.line_code
    from public.monthly_closing_publications pub
    join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(pub.line))
    where pub.period = p_period and pub.unpublished_at is null
  );

  if not exists (select 1 from au.sos_official_line_map lm where lm.line_code <> all (v_frozen)) then
    raise notice 'phx_write_monthly_store_split_net: every line of % is published — leaving its store split frozen', p_period;
    return 0;
  end if;

  select string_agg(distinct r->>'official_line', ', ')
    into v_unmapped
  from jsonb_array_elements(p_rows) r
  left join au.sos_official_line_map lm
    on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
  where lm.line_code is null;

  if v_unmapped is not null then
    raise exception
      'phx_write_monthly_store_split_net: no line_code for % - refusing to write a net that would join to nothing',
      v_unmapped;
  end if;

  select string_agg(format('%s/%s: qty %s, units %s', line_code, product_code, sq, se), '; ')
    into v_bad
  from (
    select lm.line_code,
           upper(btrim(r->>'product_code')) as product_code,
           sum((r->>'net_qty')::numeric)             as sq,
           sum((r->>'net_effective_units')::numeric) as se
    from jsonb_array_elements(p_rows) r
    join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
    where lm.line_code <> all (v_frozen)
    group by 1, 2
    having abs(sum((r->>'net_qty')::numeric)) > 1e-9
        or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9
  ) unbalanced;

  if v_bad is not null then
    raise exception
      'phx_write_monthly_store_split_net: net does not balance to zero for % - refusing to write (%)',
      p_period, v_bad;
  end if;

  delete from au.monthly_store_split_net n
  where n.period = p_period
    and n.line_code <> all (v_frozen);

  insert into au.monthly_store_split_net
    (period, line_code, area_code, product_code, net_qty, net_effective_units, computed_at)
  select p_period,
         lm.line_code,
         upper(btrim(r->>'area_code')),
         upper(btrim(r->>'product_code')),
         sum((r->>'net_qty')::numeric),
         sum((r->>'net_effective_units')::numeric),
         now()
  from jsonb_array_elements(p_rows) r
  join au.sos_official_line_map lm
    on lower(btrim(lm.official_line)) = lower(btrim(r->>'official_line'))
  where lm.line_code <> all (v_frozen)
  group by 1, 2, 3, 4
  having abs(sum((r->>'net_qty')::numeric)) > 1e-9
      or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

create or replace function au.f_refresh_monthly_attribution(p_period text)
 returns void
 language plpgsql
 security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_frozen text[];
  v_any    boolean;
begin
  -- Serialize refreshes of the SAME period: two concurrent runs both delete and both insert, which
  -- doubled 2026-09 on 2026-09-29 (22 rows -> 44, 579,055.85 -> 1,158,111.70). Transaction-scoped on
  -- purpose — the sweep holds one per period to commit, and a crashed caller releases everything.
  perform pg_advisory_xact_lock(hashtext('au.f_refresh_monthly_attribution:' || coalesce(p_period, '')));

  -- 🔒 A PUBLISHED LINE KEEPS ITS ROLLUP; THE OTHER LINES OF THE SAME MONTH DO NOT FREEZE WITH IT.
  -- Fails closed: a published line Phoenix cannot map to a line_code freezes the whole period.
  if exists (
    select 1 from public.monthly_closing_publications pub
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(pub.line))
    where pub.period = p_period and pub.unpublished_at is null
      and lm.line_code is null
  ) then
    raise notice 'f_refresh_monthly_attribution: % has a published line with no line_code — leaving the whole period frozen', p_period;
    return;
  end if;

  v_frozen := array(
    select distinct lm.line_code
    from public.monthly_closing_publications pub
    join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(pub.line))
    where pub.period = p_period and pub.unpublished_at is null
  );
  v_any := cardinality(v_frozen) > 0;

  if not exists (select 1 from au.sos_official_line_map lm where lm.line_code <> all (v_frozen)) then
    raise notice 'f_refresh_monthly_attribution: every line of % is published — leaving its attribution rollup frozen', p_period;
    return;
  end if;

  -- A row with no line_code belongs to no closing, so it stays frozen while ANY line is published.
  delete from au.monthly_attribution_rollup r
  where r.period = p_period
    and (not v_any or (r.line_code is not null and r.line_code <> all (v_frozen)));

  insert into au.monthly_attribution_rollup
    (period, line_code, area_code, region_code, product_code, sales_units, sales_value)
  select a.period, a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
  from au.f_monthly_attribution(p_period) a
  where not v_any or (a.line_code is not null and a.line_code <> all (v_frozen));

  insert into au.monthly_attribution_rollup_meta(period, config_fp, refreshed_at)
  values (p_period, au.f_attribution_config_fingerprint(), now())
  on conflict (period) do update
    set config_fp = excluded.config_fp, refreshed_at = excluded.refreshed_at;
end;
$function$;

create or replace function au.f_refresh_stale_attribution_periods(p_limit integer default 6)
 returns setof text
 language plpgsql
 security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_fp text := au.f_attribution_config_fingerprint();
  v_limit integer := greatest(1, least(24, coalesce(p_limit, 6)));
  r record;
begin
  for r in
    select p.period
    from (
      -- Every distinct period, one index probe per step, instead of a DISTINCT over the whole rollup.
      with recursive periods(period) as (
        (
          select f.period
          from public.source_of_sales_fact_rollup f
          where f.period is not null
          order by f.period
          limit 1
        )
        union all
        select (
          select f.period
          from public.source_of_sales_fact_rollup f
          where f.period > periods.period
          order by f.period
          limit 1
        )
        from periods
        where periods.period is not null
      )
      select periods.period
      from periods
      -- Kept only when a VALIDATED batch holds a row of it, which is what the old join asked. LIMIT 1
      -- stops at the first such row; a plain EXISTS is flattened into a semi-join over the whole table.
      cross join lateral (
        select 1
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
        where f.period = periods.period
        limit 1
      ) validated
      where periods.period is not null
    ) p
    left join au.monthly_attribution_rollup_meta m on m.period = p.period
    where (m.config_fp is null or m.config_fp <> v_fp)
      -- A period f_refresh_monthly_attribution would decline whole is excluded, so it neither takes
      -- a slot nor is reported as refreshed: a published line it cannot map, or every line published.
      -- A period with only SOME lines published is kept — its other lines still refresh.
      and not exists (
        select 1
        from public.monthly_closing_publications pub
        left join au.sos_official_line_map lm
          on lower(btrim(lm.official_line)) = lower(btrim(pub.line))
        where pub.period = p.period and pub.unpublished_at is null
          and lm.line_code is null
      )
      and exists (
        select 1
        from au.sos_official_line_map lm
        where lm.line_code not in (
          select lm2.line_code
          from public.monthly_closing_publications pub
          join au.sos_official_line_map lm2
            on lower(btrim(lm2.official_line)) = lower(btrim(pub.line))
          where pub.period = p.period and pub.unpublished_at is null
        )
      )
    order by p.period desc
    limit v_limit
  loop
    perform au.f_refresh_monthly_attribution(r.period);
    return next r.period;
  end loop;
end;
$function$;

revoke execute on function public.phx_write_monthly_store_split_net(text, jsonb) from public, anon, authenticated;
grant  execute on function public.phx_write_monthly_store_split_net(text, jsonb) to service_role;
revoke execute on function au.f_refresh_monthly_attribution(text) from public, anon, authenticated;
grant  execute on function au.f_refresh_monthly_attribution(text) to service_role;
revoke execute on function au.f_refresh_stale_attribution_periods(integer) from public, anon, authenticated;
grant  execute on function au.f_refresh_stale_attribution_periods(integer) to service_role;

commit;
