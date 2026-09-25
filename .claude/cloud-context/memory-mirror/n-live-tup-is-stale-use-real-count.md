---
name: n-live-tup-is-stale-use-real-count
description: "In prod Supabase, pg_stat_user_tables.n_live_tup is stale and reports live tables as empty — always use a real count(*) sweep"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 75a0c0fe-3f17-469a-aca9-812ef437e71b
  modified: 2026-08-13T03:26:58.244Z
---

**Never decide a table is dead from `pg_stat_user_tables.n_live_tup` in Phoenix production.** Verified 2026-08-13 (`pg_stat_database.stats_reset` is NULL; planner stats are simply stale):

| Table | `n_live_tup` said | real `count(*)` |
| --- | --- | --- |
| `sales_records` | 0 | **11,267** |
| `field_workforce_compliance_days` | 0 | **4,030** |
| `email_templates` | 0 | **22** |
| `salary_records` | 105 | **796** |
| `attendance_raw_punches` | 292 | **4,039** |

The write counters (`n_tup_ins/upd/del`) are equally untrustworthy — they only cover activity since the last stats file reset (a PG major-version upgrade wipes them).

**Why:** an audit using `n_live_tup` would have declared `sales_records` and the whole Field Workforce Compliance module dead. Both are live.

**How to apply:** sweep every table with a real count instead —
`select t.table_name, (xpath('/row/cnt/text()', x))[1]::text::bigint from (select table_name, query_to_xml(format('select count(*) as cnt from public.%I', table_name), false, true, '') x from information_schema.tables where table_schema='public' and table_type='BASE TABLE') t order by 2 desc;`
Runs in seconds over all 309 tables. Same spirit as [[list-migrations-reports-ledger-not-reality]] — query reality, not a ledger or a statistic.
