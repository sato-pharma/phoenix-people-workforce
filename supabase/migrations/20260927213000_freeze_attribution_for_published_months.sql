-- Freeze the attribution engine for a month once it is published
--
-- WHAT THIS CHANGES: two functions gain one guard each, and nothing else. Neither reads or writes a
-- row differently for an unpublished month.
--   1. public.phx_write_monthly_store_split_net(p_period, p_rows) — returns 0 without writing when the
--      period is currently published.
--   2. au.f_refresh_monthly_attribution(p_period) — returns without rebuilding the rollup when the
--      period is currently published.
--
-- WHY (owner, 2026-09-27 — "fix it forward only and leave august as published"):
--   au.f_monthly_attribution feeds Sales vs Target, the Business Review, the achievement surfaces and
--   incentives. It applies the wholesaler / El Qema city split through the stored table
--   au.monthly_store_split_net, which is recomputed on every sales import that touches a period
--   (writeStoreSplitNetForBatch, immediately before phx_refresh_monthly_attribution).
--
--   That recompute reads the CLOSING'S CURRENT split logic. So an import landing AFTER a month was
--   published rebuilds that month's split against logic that may have moved on since publish — and the
--   achievement surfaces then disagree with the frozen, announced closing. Measured on production:
--   August Pedia was published 2026-09-10 17:35; an import rebuilt its store-split net on 2026-09-13
--   20:47, which spread El Qema OUT of Qalubeya (D11 net −6,340 units) while the published closing
--   concentrates it there (Qalubeya EGP 1.84M vs 88K on the achievement engine). The Pedia line then
--   reads 75.3% achievement against a published-closing 71.5%.
--
--   The published closing is the one source of truth (the Monthly-Closing golden rule), and a published
--   and announced month is never corrected. So the fix is not to restate anything: it is to STOP the
--   engine recomputing a month once that month is published. After this, a month's store-split net and
--   attribution rollup are frozen at their state when it was published, and no later import can move
--   them. Unpublishing a month (unpublishClosing, deliberately ungated) lifts the guard, so a month the
--   owner genuinely reopens recomputes as before.
--
--   FORWARD ONLY, by construction. This changes no existing row. August (and every already-published
--   month) keeps exactly the values it has today — the guard only prevents FUTURE recomputes. September
--   and later, still unpublished, are untouched until the day they are published, from when they are
--   frozen and can never drift. Restating August's achievement to match its published closing was
--   considered and declined by the owner (it would move incentive money on an announced month).
--
--   The published test is `unpublished_at is null` on any monthly_closing_publications row for the
--   period — the same "currently published" predicate the closing gate uses — so a month with no
--   publication row, or one that has been unpublished, is not frozen.
--
-- ROLLBACK: re-run 20260907183000 (store-split write) and 20260713* (refresh) bodies, or drop the two
--   guard blocks. No data changes, so a rollback restores behaviour with no cleanup.
--
-- Verification after apply:
--   -- a published period is a no-op:
--   select public.phx_write_monthly_store_split_net('2026-08', '[]'::jsonb);   -- 0, no delete
--   select au.f_refresh_monthly_attribution('2026-08');                        -- returns, rollup unchanged
--   -- an unpublished period still works (row counts unchanged by this migration).

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
begin
  if p_period is null or p_period !~ '^\d{4}-\d{2}$' then
    raise exception 'phx_write_monthly_store_split_net: period must be YYYY-MM, got %', p_period;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'phx_write_monthly_store_split_net: p_rows must be a jsonb array';
  end if;

  -- FROZEN ONCE PUBLISHED (owner, 2026-09-27). A published month's store split is the one that was
  -- announced; a later import must not rebuild it against since-changed logic. Unpublishing lifts this.
  if exists (
    select 1 from public.monthly_closing_publications
    where period = p_period and unpublished_at is null
  ) then
    raise notice 'phx_write_monthly_store_split_net: % is published — leaving its store split frozen', p_period;
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
    group by 1, 2
    having abs(sum((r->>'net_qty')::numeric)) > 1e-9
        or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9
  ) unbalanced;

  if v_bad is not null then
    raise exception
      'phx_write_monthly_store_split_net: net does not balance to zero for % - refusing to write (%)',
      p_period, v_bad;
  end if;

  delete from au.monthly_store_split_net where period = p_period;

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
  group by 1, 2, 3, 4
  having abs(sum((r->>'net_qty')::numeric)) > 1e-9
      or abs(sum((r->>'net_effective_units')::numeric)) > 1e-9;

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- create or replace preserves the ACL, so these only restate the grants the function already had
-- (service_role, plus postgres as owner). Explicit because a public SECURITY DEFINER function must
-- never be reachable through PUBLIC — revoking PUBLIC also strips the two roles, so re-grant follows.
revoke execute on function public.phx_write_monthly_store_split_net(text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_write_monthly_store_split_net(text, jsonb) to service_role;

create or replace function au.f_refresh_monthly_attribution(p_period text)
returns void
language plpgsql
security definer
set search_path to 'au', 'public'
as $function$
begin
  -- FROZEN ONCE PUBLISHED (owner, 2026-09-27). Do not rebuild a published month's rollup from a later
  -- import — it would move the achievement surfaces off the announced closing. Unpublishing lifts this.
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

notify pgrst, 'reload schema';
commit;
