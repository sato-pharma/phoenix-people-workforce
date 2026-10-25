# The team starts table had no planner statistics

Account for `supabase/migrations/20261024190000_phoenix_crm_team_starts_keeps_its_planner_statistics.sql`,
pinned by `tests/phoenix-crm-team-starts-statistics.test.ts`. Measured on production and staging on
**2026-10-24**.

## What was wrong

`public.phoenix_crm_team_starts` is the table that decides, for every team, the day Phoenix CRM took
over from iReports360 — 21 rows on production, one per team seat, read by `crm_visits_unified`,
`crm_checkins_unified`, `phoenix_crm_rep_entry_days_calc()`, `phoenix_crm_set_team_start()`,
`phoenix_crm_started_team_reps()` and `phoenix_crm_started_team_seats()`.

It had **never been analyzed**. The catalog read, before anything was changed:

| | production | staging |
| --- | --- | --- |
| `pg_class.reltuples` | **-1** (the "never vacuumed, never analyzed" sentinel) | **-1** |
| `pg_class.relpages` | 0 | 0 |
| columns in `pg_stats` | **0** | **0** |
| `pg_stat_all_tables.analyze_count` / `autoanalyze_count` | 0 / 0 | 0 / 0 |
| live rows | 21 | 9 |

With no statistics the planner does not guess from the table — it falls back to a hard-coded
10 pages and **350 rows**. Both doors paid it, five times between them:

```
->  Seq Scan on phoenix_crm_team_starts t_1  (cost=0.00..13.50 rows=350 width=8) (actual ... rows=21 ...)
```

three nodes in `crm_visits_unified` (aliases `t_1`, `run`, `s`) and two in `crm_checkins_unified`
(`t`, `t_1`). A **16-fold over-estimate** of the table the doors use to split a rep's days between
two sources, in a plan that then chooses join orders and join strategies from that number.

## Why it never healed itself

Autovacuum analyzes a table when

```
n_mod_since_analyze > autovacuum_analyze_threshold + autovacuum_analyze_scale_factor * reltuples
```

which at the cluster defaults (50 and 0.1) means **50 modifications**. One row per team start cannot
reach 50 modifications in any reasonable time — staging sat at `n_mod_since_analyze = 15` after
months. So this was not a table that was slow to be analyzed; it was a table that was never going to
be. An ANALYZE on its own would have fixed the day and left the next restore in the same place,
which is why the migration carries two statements:

```sql
alter table public.phoenix_crm_team_starts
  set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0);

analyze public.phoenix_crm_team_starts;
```

The threshold alone changes nothing today either — it only decides when autovacuum next looks, and a
table at `n_mod_since_analyze = 0` is never looked at. **Both statements, or the fix is half a fix.**

## After

Applied through the Supabase MCP, so each project holds a normal ledger row
(`phoenix_crm_team_starts_keeps_its_planner_statistics`, version `20261024140312` on production,
`20261024140308` on staging — no `ACKNOWLEDGED_EXCEPTIONS` entry needed).

| | production | staging |
| --- | --- | --- |
| `reltuples` / `relpages` | 21 / 1 | 9 / 1 |
| columns in `pg_stats` | **11** | **11** |
| `reloptions` | `autovacuum_analyze_threshold=5`, `autovacuum_analyze_scale_factor=0.0` | same |
| `analyze_count` | 2 | 1 |

And the live plans, read again on production after the migration committed:

```
crm_visits_unified:   Seq Scan on phoenix_crm_team_starts t_1 / s / run  (cost=0.00..1.21 rows=21 ...)
crm_checkins_unified: Seq Scan on phoenix_crm_team_starts t / t_1        (cost=0.00..1.21 rows=21 ...)
```

🔴 **The estimate being right is the win; the milliseconds are noise at this size.** Measured warm
either side of an ANALYZE on the same session, the visits door moved 107.5 → 104.0 ms and the
check-ins door 13.7 → 11.0 ms — inside this box's own variance. What the fix buys is a planner that
sizes a 21-row relation as 21 rows wherever these doors are joined into something larger, instead of
as 350 rows that are not there.

## 🔴 The trap: ANALYZE is only half-transactional

Proved by accident on production while measuring the before-and-after. `analyze` inside a
transaction that is then **rolled back** leaves behind:

- `pg_statistic` rows — **gone**, correctly rolled back (`pg_stats` columns back to 0);
- `pg_class.reltuples` and `relpages` — **kept**, because that is an in-place, non-MVCC catalog
  update (the table read `reltuples = 21`, `relpages = 1` after the rollback);
- `pg_stat_all_tables.analyze_count` and `last_analyze` — **kept**, counters are not transactional.

So a rolled-back probe leaves a table holding a row-count estimate with **no column statistics
behind it**, and `reltuples = -1` no longer detects it — any sweep keyed on that sentinel reports the
table as healthy while `pg_stats` is still empty. Never probe an ANALYZE inside a transaction you
intend to roll back: run the real thing, and read `pg_stats` rather than `reltuples` when asking
whether a table has statistics.

## The rest of the class — the sweep that followed

The first reading of the rest of the schema was **wrong, and wrong in the direction of comfort**: it
asked `pg_class.reltuples = -1` and reported 185 tables, then — after the rolled-back probe above —
0. Both numbers were artefacts of the trap. Re-read against `pg_stats`, which is the only honest
signal, production held:

| | tables |
| --- | --- |
| ordinary `public` tables | **532** |
| with zero columns in `pg_stats` | **237** |
| … of those, `relpages = 0`, i.e. EMPTY | **208** — left alone, deliberately |
| … of those, holding data with no statistics at all | **29** (256 kB of table data, 2,328 kB with indexes and TOAST; 26 a single page, 3 two pages) |

An empty table that **has** been analyzed holds no `pg_stats` rows either, so those 208 are
indistinguishable from never-analyzed ones and equally harmless — a planner estimate of a table with
no pages is right whatever it reads. Analyzing them would also put them straight back into the same
set, and the migration would re-do the same work on every run for ever.

The other 29 were each being planned from the same hard-coded 10-page / 350-row guess this table
was. The owner's decision on 2026-10-24 was **analyze all of them, and override the threshold only
on the small ones**, which is
`supabase/migrations/20261024200000_every_table_with_data_and_no_statistics_gets_them.sql`:

- `alter table … set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0)` on
  the three CRM door tables that stay small for ever — `phoenix_crm_day_starts` (one row per rep per
  working day), `phoenix_crm_manager_visits` (one per accompaniment) and `phoenix_crm_visit_edits`
  (one per correction). **The other 26 do not get it**, deliberately: a table that later grows into
  the thousands would then re-analyze itself after every 5 modifications, which costs more than the
  bad estimate it buys, and any table that grows reaches the cluster default of 50 on its own.
- one `do $$` loop that analyzes every ordinary `public` table with `relpages > 0`,
  `reltuples <> 0` and no row in `pg_stats`. `analyze` inside a `DO` block was probed on staging
  first — it is allowed.

Applied through the MCP with the refs resolved live by `list_projects`, one ordinary ledger row each
(`every_table_with_data_and_no_statistics_gets_them`), so again no `ACKNOWLEDGED_EXCEPTIONS` entry.

| after the sweep | production | staging |
| --- | --- | --- |
| tables with data and no statistics | 29 → **9** | **0** |
| tables with statistics | 315 | 168 |
| door tables carrying both `reloptions` | 4 of 4 | 4 of 4 |

🔴 **The nine left on production all read `reltuples = 0`** — pages written and their rows later
deleted, the pages not yet reclaimed: `employee_plan_item_return_notes`, `employee_probation`,
`leave_notification_attempts`, `leave_request_events`, `report_it_reports`,
`sidebar_module_assignments`, `source_of_sales_region_aliases`, `v2_vacation_email_tokens`,
`weekly_sales_distributor_column_profile`. ANALYZE on one of those produces **no `pg_stats` rows at
all** — there is nothing to describe — so without the `reltuples <> 0` clause they would match the
loop again on every single run, for ever. That clause is why a second run of the file picks up **0
tables**, measured, and why its re-runnable claim is true rather than hoped for.

## The sweep runs nightly (2026-10-25)

The sweep above ran once, at apply time, so a table created, restored or refilled after that day was
planned from the 350-row guess again. `supabase/migrations/20261025230153_analyze_tables_with_no_statistics_nightly.sql`
moves it into `public.phx_analyze_tables_without_statistics()`, run every night at 02:20 UTC by the
pg_cron job `phoenix-analyze-tables-without-statistics` through a `_run()` wrapper that reports to
the job heartbeat register (declared in `JOB_SCHEDULES` at `20 4 * * *` Cairo, grace 2 hours). Three
things in the selection were corrected on the way:

- it reads `pg_catalog.pg_statistic`, not the `pg_stats` view, which hides rows by column privilege
  and row security — a table that has statistics could read as one with none;
- it keeps only tables the running role may analyze (`has_table_privilege(…, 'MAINTAIN')`), so the
  count it reports is of analyzes that really ran;
- an emptied table comes back as soon as it is written to: `reltuples <> 0` OR
  `n_mod_since_analyze > 0`. An INSERT does not move `reltuples`, so the old clause kept the nine
  above out until autovacuum's 50 modifications. ANALYZE resets the counter, so a table still empty
  afterwards is not picked again the next night.

Read on production before it was applied: **0** tables match, so most nights it analyzes nothing,
which is correct.
