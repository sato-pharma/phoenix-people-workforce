-- =====================================================================================================
-- Attribution freshness sweep — refresh every period whose stored rollup the gate can no longer use.
--
-- WHY THIS EXISTS. `au.f_monthly_achievement` serves the precomputed rollup only while the period was
-- refreshed AND `au.f_attribution_config_fingerprint()` still matches what was stored with it. That
-- fingerprint hashes the CONFIG surface, so an ordinary mapping change — a customer moved between
-- areas, a brick repointed, an alias corrected — drifts it. The gate then falls back to the exact live
-- computation on every read.
--
-- THE FAILURE IS NOT A WRONG NUMBER, AND THAT IS WHY IT WENT UNNOTICED. Falling back is the safe half
-- of the design: a drifted fingerprint means slower reads, never stale money. Measured on production
-- 2026-09-11, all nine periods of 2026 had drifted and every achievement screen was recomputing from
-- `source_of_sales_fact_rollup` on every request, with nothing anywhere reporting it. The only cure in
-- place was the 03:20 nightly re-stamp, so a mapping change made at 09:00 left the rollup unusable for
-- eighteen hours.
--
-- WHAT IT IS SAFE TO SWEEP, INCLUDING A PUBLISHED MONTH. This writes to `au.monthly_attribution_rollup`
-- and its meta row only — never to `source_of_sales_import_rows` or `source_of_sales_fact_rollup`, so
-- `monthly_closing_locks` is not in the path and a locked month is not being corrected. Nor can a
-- published figure move: while the fingerprint is stale the screens are ALREADY serving the live
-- computation, and the refresh stores exactly that. Verified by hand on 2026-09-11 against the
-- published 2026-07 and 2026-08 — stored equalled live across all 49 areas in each, both before and
-- after. Do NOT read this sweep as a restatement path for a published month; it has no way to be one.
--
-- BOUNDED ON PURPOSE. The caller is the ten-minute mapping-guard clock, in front of cron-job.org's
-- unraisable 30-second cut. Newest period first, a handful per run: a big config change leaves a
-- backlog that drains over the following runs instead of one long transaction, and a period stops
-- being a candidate the moment it is refreshed, so nothing starves.
-- =====================================================================================================

create or replace function au.f_refresh_stale_attribution_periods(p_limit integer default 6)
  returns setof text
  language plpgsql
  security definer
  set search_path to 'au', 'public'
as $function$
declare
  -- Read ONCE. Calling the fingerprint per period would compare each candidate against a surface that
  -- another session may have moved mid-loop, which is how a sweep refreshes a period and still leaves
  -- it looking stale.
  v_fp text := au.f_attribution_config_fingerprint();
  v_limit integer := greatest(1, least(24, coalesce(p_limit, 6)));
  r record;
begin
  for r in
    -- Same period source as au.f_rebuild_monthly_attribution_all, so the two can never disagree about
    -- which periods exist. A period with no meta row has never been refreshed and is stale by
    -- definition — absent is not fresh.
    select p.period
    from (
      select distinct f.period
      from public.source_of_sales_fact_rollup f
      join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
      where f.period is not null
    ) p
    left join au.monthly_attribution_rollup_meta m on m.period = p.period
    where m.config_fp is null or m.config_fp <> v_fp
    order by p.period desc
    limit v_limit
  loop
    perform au.f_refresh_monthly_attribution(r.period);
    return next r.period;
  end loop;
end;
$function$;

-- PostgREST reaches `public` only, so the sweep needs a wrapper there to be callable over RPC.
create or replace function public.phx_refresh_stale_attribution_periods(p_limit integer default 6)
  returns setof text
  language sql
  security definer
  set search_path to 'au', 'public'
as $function$
  select au.f_refresh_stale_attribution_periods(p_limit);
$function$;

-- A new SECURITY DEFINER function inherits EXECUTE for PUBLIC, and anon and authenticated are members
-- of it, so both are revoked and service_role re-granted — the shape its public siblings in
-- 20260814160000_monthly_attribution_rollup.sql already use.
revoke execute on function public.phx_refresh_stale_attribution_periods(integer) from public, anon, authenticated;
grant execute on function public.phx_refresh_stale_attribution_periods(integer) to service_role;

-- The au.* half is locked down TOO, which is deliberately tighter than its neighbours. Measured on
-- staging 2026-09-12: anon and authenticated hold EXECUTE on au.f_refresh_monthly_attribution and
-- au.f_rebuild_monthly_attribution_all today. That is not reachable — PostgREST exposes `public` and
-- `au` is not in its schema list — but "unreachable through the door we know about" is a weaker
-- property than "not granted", and this function rewrites the rollup every achievement figure is read
-- from. au.f_monthly_achievement is already revoked this way, so the precedent is here rather than in
-- the looser siblings.
revoke execute on function au.f_refresh_stale_attribution_periods(integer) from public, anon, authenticated;
grant execute on function au.f_refresh_stale_attribution_periods(integer) to service_role;
