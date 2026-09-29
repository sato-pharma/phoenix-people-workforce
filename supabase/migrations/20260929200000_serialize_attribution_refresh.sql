-- ---------------------------------------------------------------------------
-- Two concurrent refreshes of the same period silently DOUBLE it.
--
-- WHAT HAPPENED, 2026-09-29. A new hire (AI-0024) flipped the attribution config fingerprint, so
-- every period went stale and the stale-period sweep was run by hand. The scheduler's own cron run
-- overlapped it, and 2026-09 came out DOUBLED: 22 rows -> 44, every key twice, 579,055.85 ->
-- 1,158,111.70. Re-running that one period restored it exactly.
--
-- WHY IT IS POSSIBLE. `f_refresh_monthly_attribution` is `delete where period = X` followed by
-- `insert`. Run twice at once, both delete, then both insert:
--
--     T1 delete(2026-09)      -- 22 rows gone
--     T2 delete(2026-09)      -- nothing left to delete
--     T1 insert 22
--     T2 insert 22            -- 44
--
-- 🔴 AND NOTHING IN THE SCHEMA STOPS IT. `au.monthly_attribution_rollup` carries one non-unique
-- index on `period` and no constraint at all.
--
-- 🔴 A UNIQUE INDEX IS THE OBVIOUS FIX AND IT IS WRONG. The function emits an `indirect` row AND a
-- `direct` row, and the rollup stores no channel column — so two rows per
-- (period, line_code, area_code, product_code) are LEGITIMATE and carry different values. Measured
-- on 2026-08: anti_infective / CA4 / RO001 holds 3,450.00 and 4,188.30, two real numbers. A unique
-- index there would reject the second and silently halve a line.
--
-- So the fix is to stop the overlap rather than to constrain the rows: a transaction-scoped advisory
-- lock keyed on the period. The second caller waits for the first to finish and then does its own
-- delete-and-insert over a settled table, which is the intended behaviour. The lock is released when
-- the transaction ends, so a crashed caller cannot hold it.
--
-- Everything else in this function is byte-identical to what is live, INCLUDING the guard that makes
-- it refuse a published period outright — that guard is what kept 2026-07 and 2026-08 frozen through
-- the incident, and it must not be disturbed.
-- ---------------------------------------------------------------------------

create or replace function au.f_refresh_monthly_attribution(p_period text)
returns void
language plpgsql
security definer
set search_path to 'au', 'public'
as $function$
begin
  -- Serialize refreshes of the SAME period. Different periods do not block each other, and the
  -- sweep takes them in a stable order (period desc), so two sweeps cannot deadlock.
  --
  -- 🔴 IT IS TRANSACTION-SCOPED ON PURPOSE — do not "fix" this to a session lock with an explicit
  -- unlock. au.f_refresh_stale_attribution_periods loops over up to 24 periods INSIDE one
  -- transaction, so it accumulates one lock per period and holds them all until it commits. That is
  -- correct: releasing early would reopen the window this closes, and a crashed caller releases
  -- everything automatically, which a session lock would not.
  perform pg_advisory_xact_lock(hashtext('au.f_refresh_monthly_attribution:' || coalesce(p_period, '')));

  if exists (
    select 1 from public.monthly_closing_publications
    where period = p_period and unpublished_at is null
  ) then
    raise notice 'f_refresh_monthly_attribution: % is published — leaving its attribution rollup frozen', p_period;
    return;
  end if;

  delete from au.monthly_attribution_rollup where period = p_period;
  insert into au.monthly_attribution_rollup
    (period, line_code, area_code, region_code, product_code, sales_units, sales_value)
  select a.period, a.line_code, a.area_code, a.region_code, a.product_code, a.sales_units, a.sales_value
  from au.f_monthly_attribution(p_period) a;

  insert into au.monthly_attribution_rollup_meta(period, config_fp, refreshed_at)
  values (p_period, au.f_attribution_config_fingerprint(), now())
  on conflict (period) do update
    set config_fp = excluded.config_fp, refreshed_at = excluded.refreshed_at;
end;
$function$;

comment on function au.f_refresh_monthly_attribution(text) is
  'Rebuilds one period of au.monthly_attribution_rollup. Takes a transaction-scoped advisory lock on the period: two concurrent refreshes would otherwise both delete and both insert, doubling the month (measured 2026-09-29 on 2026-09). Refuses a published period, leaving its rollup frozen.';

-- ---------------------------------------------------------------------------
-- The sweep re-attempts published periods FOREVER, and reports them as refreshed.
--
-- The guard above does `raise notice ...; return;` — and that return sits ABOVE both the delete and
-- the `config_fp` meta upsert. So a published period is never stamped and is stale BY CONSTRUCTION,
-- permanently. Measured on production 2026-09-29: 2026-07 and 2026-08 both still read
-- `refreshed_at 2026-09-24 10:05` with a fingerprint that will never match again.
--
-- Three consequences, none of them money:
--   1. the sweep re-attempts both on every single call, for ever;
--   2. they permanently occupy 2 of p_limit's 6 default slots (clamped 1..24) — harmless today, not
--      harmless the moment five other periods go stale at once, which ONE fingerprint change does;
--   3. 🔴 `return next r.period` fires unconditionally, so the sweep REPORTS them as refreshed when
--      the inner function only raised a notice. That is a false green: a signal with no way to say
--      "I declined" gets read as "I did it", and the next reader trusts the output.
--
-- Fixing it in the INNER function would mean stamping a published period's fingerprint, which would
-- be a lie of its own — the rollup genuinely does not match the current config, it is deliberately
-- frozen. So the filter belongs in the OUTER loop: a published period is not a candidate at all,
-- and is therefore neither attempted nor reported. If it is ever unpublished it becomes eligible
-- again by itself.
--
-- 🔴 CARRY THIS IF YOU RE-CHECK IT: `monthly_closing_locks` and `monthly_closing_publications` are
-- DIFFERENT gates, and only publications is what the guard reads. Measured the same day, 2026-09 has
-- ZERO open publication rows and ONE lock row — so a check written against locks concludes September
-- is gated when it is not, and September refreshed normally all evening. Read publications.
--
-- CREATE OR REPLACE preserves ownership and privileges, so this function keeps the
-- postgres/service_role ACL it already has; the grants below are restated for the same reason the
-- others are — so the intended shape is visible in one place.
-- ---------------------------------------------------------------------------

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
      select distinct f.period
      from public.source_of_sales_fact_rollup f
      join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
      where f.period is not null
    ) p
    left join au.monthly_attribution_rollup_meta m on m.period = p.period
    where (m.config_fp is null or m.config_fp <> v_fp)
      -- A published period would be refused by f_refresh_monthly_attribution anyway. Excluding it
      -- here means it does not consume a slot and is not reported as refreshed.
      and not exists (
        select 1
        from public.monthly_closing_publications pub
        where pub.period = p.period and pub.unpublished_at is null
      )
    order by p.period desc
    limit v_limit
  loop
    perform au.f_refresh_monthly_attribution(r.period);
    return next r.period;
  end loop;
end;
$function$;

comment on function au.f_refresh_stale_attribution_periods(integer) is
  'Refreshes up to p_limit stale attribution periods, newest first. Published periods are excluded: their rollup is deliberately frozen and never stamped, so before 2026-09-29 they were re-attempted on every call, occupied slots, and were REPORTED as refreshed when nothing happened. Reads monthly_closing_publications, not monthly_closing_locks.';

-- ---------------------------------------------------------------------------
-- 🔴 AND THE TWO FUNCTIONS THAT WRITE THE ROLLUP WERE EXECUTABLE BY PUBLIC.
--
-- Measured on production 2026-09-29, `proacl` on the au attribution family:
--
--   f_monthly_attribution                postgres=X/postgres | service_role=X/postgres   LOCKED
--   f_refresh_stale_attribution_periods  postgres=X/postgres | service_role=X/postgres   LOCKED
--   f_refresh_monthly_attribution        NULL -> PUBLIC has EXECUTE                      OPEN
--   f_rebuild_monthly_attribution_all    NULL -> PUBLIC has EXECUTE                      OPEN
--   f_attribution_config_fingerprint     NULL -> PUBLIC has EXECUTE                      OPEN
--
-- `has_function_privilege` confirms it directly: anon and authenticated can execute all three of the
-- open ones, while the two locked siblings refuse them. So the two functions in the family that
-- WRITE — one rebuilding a period, one rebuilding EVERY period — are exactly the ones anybody could
-- execute, and they are SECURITY DEFINER, so they would run with the owner's rights.
--
-- Reachability is probably limited: PostgREST exposes `public`, and these live in `au`, so the app's
-- own path is the `public.phx_*` wrappers called with the service-role key (verified in the code:
-- every caller is `supabase.rpc("phx_refresh_monthly_attribution", ...)` server-side, never au.*).
-- That is a mitigation, not a grant — and it was NOT tested by calling a mutating function, which is
-- not a thing to probe on production. The two locked siblings show what the intended shape is.
-- ---------------------------------------------------------------------------

revoke execute on function au.f_refresh_monthly_attribution(text) from public, anon, authenticated;
grant  execute on function au.f_refresh_monthly_attribution(text) to service_role;

revoke execute on function au.f_rebuild_monthly_attribution_all() from public, anon, authenticated;
grant  execute on function au.f_rebuild_monthly_attribution_all() to service_role;

revoke execute on function au.f_attribution_config_fingerprint() from public, anon, authenticated;
grant  execute on function au.f_attribution_config_fingerprint() to service_role;

-- Already locked, and CREATE OR REPLACE above preserved it. Restated so the whole family's intended
-- shape reads from one place rather than from two different migrations.
revoke execute on function au.f_refresh_stale_attribution_periods(integer) from public, anon, authenticated;
grant  execute on function au.f_refresh_stale_attribution_periods(integer) to service_role;

-- 🔴 AND ONE MORE, WHICH A LIST OF NAMES MISSED AND A REHEARSAL CAUGHT.
-- The revokes above were written against five functions named by hand. Rehearsing this migration in
-- a rolled-back transaction and then counting `has_function_privilege('anon', ...)` across the whole
-- `au.%attribution%` family still returned 1 — because the family has SEVEN members, not five.
--
-- The straggler is `f_monthly_attribution_pre_split`: SECURITY DEFINER, null proacl, anon and
-- authenticated able to execute. It is STABLE rather than volatile, so it writes nothing — but it
-- RETURNS attribution by area and product, which is the same commercial detail its identical sibling
-- `f_monthly_attribution` is already locked against. That sibling is the proof of intent.
--
-- The lesson worth keeping: enumerate the family with a pattern and assert the COUNT is zero. A
-- hand-written list of names cannot tell you what it left out.
revoke execute on function au.f_monthly_attribution_pre_split(text) from public, anon, authenticated;
grant  execute on function au.f_monthly_attribution_pre_split(text) to service_role;
