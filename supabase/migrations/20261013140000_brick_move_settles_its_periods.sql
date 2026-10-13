-- Let the brick-move drain settle a period's store-split net, not just its files.
--
-- WHY TWO WRAPPERS AND NOT A DIRECT CALL. PostgREST exposes `public`, `graphql_public` and
-- `analytics` only, so `.schema("au")` answers PGRST106 — the app cannot read
-- `au.monthly_store_split_net` or call `au.f_refresh_monthly_attribution` at all. Every au-schema
-- fact the app needs comes through a public wrapper, and these are the two the drain needs.
--
-- WHAT WENT WRONG, 2026-10-13. `refreshBatchRollups` rebuilds the split net per BATCH, and
-- `writeStoreSplitNetForBatch` is already period-grain inside — so a drain that completes every file
-- through the app converges on its own. What does NOT converge is a file finished any other way:
-- one file of the مدينة قنا move exceeded the 8-second statement timeout
-- (20261013130000 fixes that cause) and had to be completed over a direct SQL connection, where the
-- net step — TypeScript, computed from the closing's own detail rows — cannot run at all. The queue
-- reached zero, every file reported rebuilt, and the stored net for 2026-08 and 2026-09 was still
-- the pre-move one: 2 cells in August and 62 in September, 74,741.23 EGP sitting on the wrong area
-- with every Sales-vs-Target screen reading it and nothing anywhere saying so.
--
-- So the drain needs to ask a question it could not ask before: for a period a brick move touched,
-- was its net computed BEFORE the move? That is what the first function answers. It reports facts
-- only — the period, when it was last moved, when its net was last computed — and leaves every
-- RULE to the caller, deliberately: which periods the city split even applies to is
-- `STORE_CITY_SPLIT_FROM_PERIOD` in TypeScript, and a period before it has an empty net BY DESIGN.
-- Hard-coding that date here would duplicate the rule in a second place and make Jan–Jun 2026 report
-- as permanently unsettled for ever.

create or replace function public.phx_brick_move_period_net_status(p_since_days integer default 30)
  returns table (period text, last_moved_at timestamptz, net_computed_at timestamptz)
  language sql
  stable
  security definer
  set search_path to 'au', 'public'
  set statement_timeout to '60s'
as $$
  with moved as (
    select r.period as period, max(f.moved_at) as last_moved_at
    from public.source_of_sales_brick_move_files f
    join public.source_of_sales_fact_rollup r on r.batch_id = f.batch_id
    where f.moved_at >= now() - make_interval(days => greatest(coalesce(p_since_days, 30), 1))
    group by r.period
  ),
  net as (
    select n.period as period, min(n.computed_at) as net_computed_at
    from au.monthly_store_split_net n
    group by n.period
  )
  select m.period, m.last_moved_at, n.net_computed_at
  from moved m
  left join net n on n.period = m.period
  order by m.period desc;
$$;

revoke execute on function public.phx_brick_move_period_net_status(integer) from public, anon, authenticated;
grant execute on function public.phx_brick_move_period_net_status(integer) to service_role;

-- The second half. Writing the net changes what au.f_monthly_attribution RETURNS, but
-- au.f_monthly_achievement serves the materialised au.monthly_attribution_rollup for as long as its
-- config fingerprint matches — and the fingerprint covers the net. So a net written without a
-- re-stamp leaves every screen falling back to the live computation: correct numbers, slower, and
-- the stored rollup still holding the pre-move split.
--
-- 🔴 NAMED `phx_refresh_attribution_for_period` ON PURPOSE. Do NOT rename it to anything built on
-- the per-batch refresh's name: `tests/sos-import-summaries-refresh.test.ts` treats that identifier
-- as its marker for "this file is a rollup-refresh site" and then insists such a file also refreshes
-- the import summaries. A wrapper whose name contained the marker as a prefix would trip the guard
-- from every file that calls it, for a reason that has nothing to do with the defect it exists to
-- catch. The name here shares no prefix with it, deliberately.
create or replace function public.phx_refresh_attribution_for_period(p_period text)
  returns void
  language plpgsql
  security definer
  set search_path to 'au', 'public'
  set statement_timeout to '120s'
as $$
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_refresh_attribution_for_period: period must be YYYY-MM, got %', p_period;
  end if;
  perform au.f_refresh_monthly_attribution(p_period);
end;
$$;

revoke execute on function public.phx_refresh_attribution_for_period(text) from public, anon, authenticated;
grant execute on function public.phx_refresh_attribution_for_period(text) to service_role;
