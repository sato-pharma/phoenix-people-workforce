-- Phoenix CRM — the team starts table keeps its planner statistics.
--
-- `public.phoenix_crm_team_starts` had NEVER been analyzed on production: `pg_class.reltuples`
-- read -1 (the "never vacuumed, never analyzed" sentinel), `relpages` 0, `pg_stats` held zero
-- columns for it and `pg_stat_all_tables.analyze_count` was 0. With no statistics the planner
-- falls back to a hard-coded guess of 10 pages / 350 rows for the table — measured inside
-- `crm_visits_unified`:
--
--   Seq Scan on phoenix_crm_team_starts t_1  (cost=0.00..13.50 rows=350 ...) (actual ... rows=21 ...)
--
-- three times in the visits door (aliases t_1, run, s) and twice in `crm_checkins_unified`
-- (t, t_1) — a 16-fold over-estimate of a 21-row table, in a door that then chooses join orders
-- and join strategies from it. After an ANALYZE the same nodes read `rows=21` at
-- `cost=0.00..1.21`. **The estimate being right is the win; the milliseconds are noise at this
-- size** (visits 107.5 → 104.0 ms, check-ins 13.7 → 11.0 ms) — the cost is paid when the door is
-- joined into something larger and the planner sizes it from 350 rows that are not there.
--
-- Why it never healed itself: autovacuum analyzes a table when
-- `n_mod_since_analyze > analyze_threshold + analyze_scale_factor * reltuples`, which with the
-- cluster defaults (50, 0.1) is 50 modifications. A table of 21 seats, one row per team start,
-- cannot reach 50 modifications in any reasonable time — so the hole is PERMANENT without the
-- threshold below. One ANALYZE alone would leave the next restore in the same place.
--
-- So two statements, and both are needed:
--   1. a per-table autovacuum analyze threshold small enough that this table's own traffic
--      reaches it (6 modifications), with the scale factor out of the way;
--   2. one ANALYZE now, to fill the hole this migration is about.
--
-- 🔴 ANALYZE IS ONLY HALF-TRANSACTIONAL — measured on production, 2026-10-24. A rollback undoes
-- the `pg_statistic` rows but NOT `pg_class.reltuples`/`relpages` (an in-place, non-MVCC catalog
-- update) and not the `pg_stat_all_tables` counters. So an ANALYZE rolled back leaves a table
-- reading `reltuples = 21` with zero `pg_stats` columns: a row-count estimate with no column
-- statistics behind it, and `reltuples = -1` no longer detects it. Never probe an ANALYZE inside
-- a transaction you intend to roll back; run the real thing instead.
--
-- Re-runnable: ALTER ... SET is idempotent and ANALYZE can always be run again.

begin;

alter table public.phoenix_crm_team_starts
  set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0);

analyze public.phoenix_crm_team_starts;

commit;
