-- ─────────────────────────────────────────────────────────────────────────────
-- phx_sales_vs_target_cache_token — a single-round-trip freshness stamp for the
-- Sales-vs-Target achievement range cache.
--
-- WHY THIS EXISTS
-- au.f_sales_vs_target_range (via phx_sales_vs_target_range) is the field force's #1
-- production query by DB time: ~486 calls / window, ~208 ms of pure plpgsql CPU each,
-- all-buffers-hit (a good plan, just recomputed once per request across 7 surfaces with
-- no cross-request cache). Its output is money-adjacent — it feeds /sales/targets, the
-- incentive surfaces, employee-360 — and it carries the AS-OF seat occupant
-- (rep_hr_id / dm_hr_id), so a stale cache would mis-attribute achievement to the wrong
-- person. That rules out a plain TTL cache and a tag-busted cache: the org/seat write
-- surface (au.occupancy_history, au.line_area_map) has no single invalidation
-- chokepoint, and "today's wiring wins" (au.f_seat_occupant_asof) means one current seat
-- move rewrites the occupant on EVERY historical period.
--
-- The safe answer is a self-invalidating cache: the app reads this cheap token once per
-- request and folds it into the cache key, so any change to an input silently misses the
-- cache and recomputes. No write-path hunting, correct by construction.
--
-- WHAT MOVES THE OUTPUT, AND HOW EACH IS COVERED
--   1. Config surface (line_area_map incl. its dm_seat_id/rep_seat_id/effective dates,
--      sos_area_crosswalk, sos_official_line_map, source_of_sales_products,
--      direct_region_allocation) → au.f_attribution_config_fingerprint() already hashes
--      each whole row (m.*::text). Reused verbatim.
--   2. Seat occupancy (au.occupancy_history) → NOT in the fingerprint. Hashed here.
--   3. Targets (au.monthly_targets) → NOT in the fingerprint. Hashed here.
--   4. Actuals/attribution refresh → au.monthly_attribution_rollup_meta carries a
--      per-period (config_fp, refreshed_at); every import/trio refresh bumps refreshed_at,
--      so hashing it captures every actuals change (covered periods read the rollup; a
--      config drift flips the fingerprint in (1) and forces the live path anyway).
--   5. The AS-OF "today's wiring wins" date boundary → au.f_seat_occupant_asof and
--      au.f_line_area_map_asof both resolve against (now() at Cairo)::date, so the same
--      rows yield a different occupant after midnight Cairo. Folding today's Cairo date in
--      rolls the cache at midnight with no write at all.
--
-- Same sum(hashtextextended(row))||count idiom as f_attribution_config_fingerprint: order
-- independent, and count-aware so inserts/deletes move it, not just value edits. All four
-- input tables are tiny (occupancy 163 rows, line_area_map 150, targets 3,688, meta 8), so
-- the whole stamp measured 27 ms warm on production — an ~87% CPU cut versus recomputing
-- the 208 ms range, paid once per request instead of the full compute on every cache miss.
--
-- Read-only. No table, no data change, additive. STABLE + SECURITY DEFINER so it can read
-- the au.* masters exactly as the range function does; EXECUTE granted only to service_role,
-- mirroring phx_sales_vs_target_range (the app calls both through the service-role client).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.phx_sales_vs_target_cache_token()
returns text
language sql
stable
security definer
set search_path to 'au', 'public'
as $function$
  select md5(concat_ws('|',
    -- (1) config surface — line_area_map (all columns, incl. seat ids/effective dates),
    -- crosswalk, official line map, products, direct region allocation.
    au.f_attribution_config_fingerprint(),
    -- (2) seat occupancy history — the as-of occupant inputs.
    (select coalesce(sum(hashtextextended(o.*::text, 0)), 0)::text || ':' || count(*)::text
       from au.occupancy_history o),
    -- (3) monthly targets — the target half of achievement.
    (select coalesce(sum(hashtextextended(t.*::text, 0)), 0)::text || ':' || count(*)::text
       from au.monthly_targets t),
    -- (4) attribution rollup freshness — bumps on every actuals import/refresh.
    (select coalesce(sum(hashtextextended(m.*::text, 0)), 0)::text || ':' || count(*)::text
       from au.monthly_attribution_rollup_meta m),
    -- (5) as-of "today's wiring wins" date boundary — rolls the cache at Cairo midnight.
    (now() at time zone 'Africa/Cairo')::date::text
  ));
$function$;

revoke execute on function public.phx_sales_vs_target_cache_token() from public;
grant execute on function public.phx_sales_vs_target_cache_token() to service_role;

comment on function public.phx_sales_vs_target_cache_token() is
  'Single-round-trip freshness stamp for the Sales-vs-Target achievement range cache. '
  'Hashes the attribution config fingerprint + occupancy_history + monthly_targets + '
  'monthly_attribution_rollup_meta + today''s Cairo date, so the app can fold it into an '
  'unstable_cache key and get self-invalidating, correct-by-construction caching of '
  'phx_sales_vs_target_range without hunting every org/seat/target write path. Read-only.';
