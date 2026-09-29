---
name: pg-stat-statements-times-precisely-and-attributes-never
description: "On production (PG 17.6) pg_stat_statements can date a statement EXACTLY when its calls = 1, via stats_since — but it carries only userid and dbid, no pid or application_name, so it can never say WHICH session ran something; the precise timestamp is what makes adjacency look like proof"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T20:09:38.790Z
---

Measured on production `ozucdzovmcqvepbozvqf`, 2026-09-29:

```
pg_version              17.6
has stats_since         yes          has last_exec   NO (it does not exist)
identity/time columns   calls, dbid, minmax_stats_since, queryid, stats_since, userid
log_statement           ddl
```

**The timing half is REAL.** PostgreSQL 17 added `stats_since` per entry. For an entry whose
`calls = 1`, `stats_since` can neither predate nor postdate its only execution, so it **is** that
statement's execution time — not a first sighting. For `calls > 1` it degrades to when the entry
started collecting and is useless for dating. `minmax_stats_since` is not an execution time at all.
🔴 **There is no `last_exec` column here** — do not reach for one.

**The authorship half does not exist.** The only identity columns are `userid` and `dbid`. No pid,
no connection, no `application_name`. Every session on this database writes into ONE shared table,
so two sessions' statements interleave with nothing distinguishing them.

🔴 **That combination is the trap: a precise timestamp is exactly what makes adjacency persuasive.**
On 2026-09-29 a peer session read three `drop table public.*_preimage_20260929` at 20:14:13 Cairo
and this session's marketing GPS audit at 20:13:01–20:13:32, and concluded the drops were probably
this session's. The times were right to the second; the attribution was wrong. Nothing in the view
could have settled it.

**How to apply:**

- Use `stats_since` to date a `calls = 1` statement with confidence. **Never use proximity in
  `pg_stat_statements` to say WHO ran something** — it cannot carry that, at any precision.
- To attribute, ask the session directly, or read its transcript. That is what settled this one:
  this session's production writes were 135 `marketing_*` UPDATEs and no DDL at all.
- **`pgaudit` is NOT installed.** `log_statement = ddl`, so DDL does reach the Postgres log — but
  every Supabase MCP connection reports `application_name = mgmt-api`, so the log carries a pid and
  no author either, and `query_logs` rejects `postgres_logs`, `edge_logs` and `auth_logs` here
  (*does not exist*), making that log dashboard-only.
- Companion: [[a-mismatch-query-hides-the-row-that-matches]] — both are the same failure, a query
  that cannot say "I did not look at this" being read as "I looked and it was fine".
