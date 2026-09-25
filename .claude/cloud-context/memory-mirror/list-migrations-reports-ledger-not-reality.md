---
name: list-migrations-reports-ledger-not-reality
description: "Supabase list_migrations reports the migration LEDGER, not what exists — staging claims 4 deductions_module migrations whose tables are absent"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd6c2994-f622-4563-b891-87464fa64cea
  modified: 2026-08-05T20:10:03.722Z
---

**`list_migrations` is not evidence that an object exists.** It reads
`supabase_migrations.schema_migrations`, which is an append-only log of what was
*run*, not a reflection of current schema. A project rebuilt/restored from a
dump keeps the ledger rows while losing the objects.

**Confirmed 2026-08-01 on staging (`cifwmndunmlxjhyjugxa`):** the ledger lists
all four `deductions_module` / `_publish` / `_comments` / `_safety_constraints`
migrations as applied — yet `deductions_*` tables = **0** and
`phx_publish_deductions` = **0**. Only the 7 legacy `deduction_*` (singular)
governance tables exist. This is fallout from the skeleton-restore recorded in
[[staging-is-a-schema-skeleton-not-a-clone]].

I asserted "staging has the tables, prod doesn't" to the owner off the back of
`list_migrations` alone. It was backwards. After applying the 4 to production on
2026-08-01, the true state is **PRODUCTION has the module schema, STAGING does
not** — the mirror of what the ledger implies.

**Why:** a ledger row proves an `apply_migration` call once succeeded. It
survives a restore that drops the objects, and nothing reconciles the two.

**How to apply:** to answer "does X exist in this project", query the catalog —
`pg_class` / `pg_proc` / `pg_policies` / `pg_constraint` — never
`list_migrations`. Use the ledger only to decide whether re-running a migration
would be a duplicate. Any "staging already has this, so it's verified" claim
built on `list_migrations` is unfounded until a catalog query confirms it.
Related: [[migration-drift-check-was-staging-only]].

**Re-confirmed 2026-08-05 by a full 191-file audit.** Staging is STILL missing
the whole module — 7 tables (`deductions_categories/_candidates/_decisions/
_publications/_publication_lines/_audit/_comments`), 4 functions
(`phx_publish_deductions`, the 3 `deductions_*` trigger fns), plus
`marketing_request_report_share_links`. Production has all of them. Un-run on
staging: `20260725115137`, `20260725130500`, `20260725141943`, `20260725161204`,
`20260801140000`, `20260802094500`, `20260805120000`.

**Two more traps the same audit exposed — the ledger DIFF is also noise here.**
Production's ledger holds 637 rows against 191 repo files, and 157 of those files
have no matching ledger row, yet every one of their objects exists. Migrations in
this repo are applied by hand, so the recorded version never matches the filename.
Worse for text comparison: whatever applies them **strips SQL comments and
cosmetically rewords the body** (`coalesce(x, '')` -> `coalesce(x,'')`, em-dash ->
hyphen, dropped column aliases). Comparing `prosrc` to the migration file
verbatim reported 34 false "stale function" hits; after stripping comments and
all whitespace and lowercasing both sides, 233/233 matched. **Normalize hard
before believing a body mismatch.**
