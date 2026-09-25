---
name: how-to-attribute-a-production-write
description: "How to find out WHO changed a production row: updated_by_hr_id lies, postgres logs only capture DDL, and agent SQL is stamped `-- source: POST /mcp`"
metadata:
  node_type: memory
  type: project
---

**Established 2026-08-19** while answering "who is writing to `marketing_customers`?" — the answer turned
out to be another of his own Claude Code sessions, and none of the three obvious signals gave it up on
their own.

**Why:** several sessions run against PROD at once here (12 that night), so "who touched this row" is a
real question that comes up mid-incident. Each signal below is individually misleading; only together do
they attribute a write. See [[guard-every-prod-write-when-another-session-shares-the-queue]].

**How to apply — three signals, in this order:**

1. **`updated_by_hr_id` DOES NOT mean "who last touched this row".** It is set by the app's INSERT and
   never re-stamped by raw SQL. `marketing_customers` in particular has **no app UPDATE path at all** —
   `git grep 'from("marketing_customers")'` finds only an insert and a rollback delete — so *every*
   change to an existing row is agent/manual SQL, while the column still shows whoever created it.
   Two rows read as edited by A-10 and B-10 when neither had done anything for days.
   **Test instead:** `updated_at > created_at + interval '2 seconds'` tells you a row was edited later;
   the identity column does not.

2. **Group by `updated_at` to recover the batches.** A bulk SQL statement stamps every row it touched
   with the *same* `updated_at` to the second, so
   `group by to_char(updated_at at time zone 'Africa/Cairo','HH24:MI:SS')` cleanly separates one agent
   run (27 rows, one timestamp) from real user activity (1 row, its own timestamp).

3. **Postgres logs carry the origin — but only for statements containing DDL.** Supabase logs
   statements, not every query, so a batch that only does `create table … ; update …` is fully visible
   while a **pure UPDATE leaves no log line at all**. Do not read an empty log as "nothing happened" —
   one 64-row backfill was invisible this way and had to be attributed from the notes it wrote onto the
   rows instead.

**The signature that identifies agent SQL** — the Supabase MCP appends this to every statement, so a
write with it came from a Claude session using `mcp__supabase-*__execute_sql`, not from the app, a cron
or a migration:

```
-- source: POST /mcp
-- user: pat:11406716        <- his Supabase personal access token, shared by ALL sessions
```

The PAT is per-machine, **not per-session**, so it proves "an agent did this" and never *which* agent.
To close that last gap, grep the session transcripts under
`C:\Users\satoh\.claude\projects\<project>\<sessionId>.jsonl` for a distinctive string from the
statement (a scratch table name works well) — that names the session outright, and its `--resume=<id>`
appears in the `claude.exe` command line, which is how you match a transcript to a live PID.

**ClickHouse query that finds them** (`query_logs`, max 24h window):
`select event_message, timestamp from logs where source='postgres_logs' and position(event_message,'<table>')>0 order by timestamp desc`
