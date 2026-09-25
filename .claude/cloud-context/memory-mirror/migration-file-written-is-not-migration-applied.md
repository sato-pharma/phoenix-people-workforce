---
name: migration-file-written-is-not-migration-applied
description: "A migration FILE committed in a session may never have been applied — a task marked 'done' can mean 'file written'. Caught 2026-08-14 when closing_fact still returned the legacy total."
metadata: 
  node_type: memory
  type: project
  originSessionId: b999e9ef-030a-4843-87cb-dfb024f13c09
  modified: 2026-08-13T23:23:25.832Z
---

**Writing the migration file and applying it are two separate acts, and a task marked
"completed" often only covers the first.** Nothing in the repo distinguishes them.

Caught live 2026-08-14 during the Rule #1 migration. Phase 4b
(`supabase/migrations/20260814090000_closing_fact_reads_source_of_sales.sql`, 12.5 KB,
carefully written) was marked complete and its task closed. Two phases later a routine
smoke query on staging returned:

```
select count(*), round(sum(sales_value),2) from analytics.closing_fact;
-- 11267 rows, 54,922,998.84
```

That is the **legacy** total, and 11,267 is exactly `sales_records`' row count — the view
had never been repointed. `supabase_migrations.schema_migrations` confirmed the version was
absent entirely. The file existed; the change did not.

**What nearly hid it:** the earlier dependency check I ran was
`pg_get_viewdef('analytics.closing_fact') ~ 'closing_fact_all_statuses'` → `false`. True, and
irrelevant — it proved the view didn't read *that* sibling, not that it had been repointed.
A narrowly-scoped check that passes reads like broad confirmation.

**Why:** an unapplied migration is invisible to every code-level check — grep, typecheck,
lint and CI all pass, because the SQL file is syntactically fine and nothing imports it.
Only the database knows. In this repo that gap can ship: Railway deploy applies **no**
migrations ([[railway-deploy-applies-no-migrations]]), so a merged PR carrying an unapplied
migration puts code live against the old schema.

**How to apply:** before calling any migration-backed phase done, query the object's real
behaviour — `count(*)`/`sum()` against the view, or `pg_get_viewdef`/`pg_proc.prosrc` for the
body — and check the value is the NEW one, not merely that the object exists. Assert on a
number you can tell apart: here, canonical vs legacy totals differ by ~8%, so the wrong
engine was obvious the moment the sum was printed. Cross-check
`supabase_migrations.schema_migrations` for the version too, remembering the MCP
`apply_migration` stamps its own clock, so the ledger version will not match the filename
([[mcp-apply-migration-versions-drift-from-filename]], [[list-migrations-reports-ledger-not-reality]]).
