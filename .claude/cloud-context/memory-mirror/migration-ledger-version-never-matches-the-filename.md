---
name: migration-ledger-version-never-matches-the-filename
description: "In this repo the schema_migrations version NEVER equals the repo filename's timestamp — every migration is applied via apply_migration, which stamps its own clock. The mismatch is the norm, not drift."
metadata:
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-08-21T09:55:20.395Z
---

Migrations here are applied with the Supabase MCP `apply_migration`, which records
`supabase_migrations.schema_migrations.version` as **the moment it ran**, and `name` as the
snake_case name you passed. The repo filename carries a *different*, hand-chosen timestamp. They
have never matched and are not supposed to.

Measured on PRODUCTION (`ozucdzovmcqvepbozvqf`) 2026-08-21 — six consecutive real migrations:

| Repo file | Ledger version | Gap |
| --- | --- | --- |
| `20260819060000_terminal_vacancy_guard_duplicate_code.sql` | `20260819023706` | −3h |
| `20260819210000_marketing_sales_code_sync_is_additive.sql` | `20260819192903` | −1h |
| `20260819220000_sync_retirement_must_not_undo_a_vendor_merge.sql` | `20260819194856` | −2h |
| `20260819234500_resolver_keeps_an_agreed_area.sql` | `20260819202452` | −3h |
| `20260821100000_crm_plan_entries.sql` | `20260821062240` | −4h |
| `20260821140000_pharmacy_search_discoveries.sql` | `20260821095319` | −4h |

The names match exactly, every time. Only the versions differ.

**Why this is a trap:** it looks exactly like migration drift. The instinct is to "correct" it — either by
hand-inserting a ledger row with the filename's version, or by renaming the file to match the
ledger. **Do neither.** A hand-written ledger row is a lie about when the schema changed, and
`migration-drift-check.yml` has been green across all six of the rows above, so it plainly does not
compare versions.

**How to apply:** pass `apply_migration` a `name` that is the repo filename's snake_case tail
(`pharmacy_search_discoveries` for `20260821140000_pharmacy_search_discoveries.sql`) and let the
version fall where it falls. Then verify the *object*, never the ledger —
[[list-migrations-reports-ledger-not-reality]].

Related: [[migration-file-written-is-not-migration-applied]],
[[merged-migration-file-does-not-mean-grants-are-live]],
[[migration-timestamp-collides-across-parallel-branches]] (a different problem — two branches
picking the same *filename* timestamp), [[railway-deploy-applies-no-migrations]].
