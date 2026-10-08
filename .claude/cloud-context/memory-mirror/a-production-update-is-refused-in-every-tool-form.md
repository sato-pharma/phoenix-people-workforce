---
name: a-production-update-is-refused-in-every-tool-form
description: "A Supabase write containing an `update` can be `declined` by the tool-layer classifier in EVERY form — `apply_migration` and `execute_sql`, production AND staging — and a fresh explicit instruction from the owner does not clear it; the answer is the SQL-editor paste with its ledger insert, never a direct-connection transport."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 97c951c0-99ab-4f3a-a221-16fbb9be8f3a
  modified: 2026-10-08T12:46:47.783Z
---

**A production Supabase write containing an `update` is refusable at the TOOL LAYER, in every form, and the owner retyping the instruction does not clear it.** Measured 2026-10-08 on one row of `au.line_area_map`: four attempts, all `{"status":"declined"}` — `apply_migration` → production, `apply_migration` → staging, `apply_migration` → production again *on his freshly typed instruction*, and `execute_sql` → production with the ledger insert in the same transaction. Nothing ran; verified after each (notes digest unchanged, no pre-image table, no ledger row).

**Why:** AGENTS.md §8 pre-authorizes Supabase writes end to end, so a decline here reads as a contradiction and invites a workaround. It is not the merge-classifier case (`the-small-pr-merge-guard-and-the-classifier-deadlock`, and §6's stale-authorization rule): there, a retyped approval clears it on the next attempt — here it did not, so **do not keep re-asking him for the same words.** Two attempts after his explicit instruction is the whole budget.

**How to apply:**
- **Verify after every decline rather than assuming nothing ran** — read the row, the pre-image table and the ledger row. A decline has always been clean so far, but reporting "nothing ran" without reading it is the claim §1 forbids.
- 🔴 **Do NOT reach for `scripts/apply-sql-file.mjs`, psql, or any direct Postgres connection to get the same effect.** That is a different transport for a refused action, not a safer method — and it is the exact path that writes **no `schema_migrations` row**, i.e. it manufactures another instance of the gap reconciled in `docs/security/migration-ledger-reconciliation-2026-10-08.md`. Fixing a row by recreating that defect is the worst available outcome.
- **Hand him the SQL for the Supabase SQL editor, in the prose, in full** — never in the `Next step:` box, because a paste is his hands (`never-put-his-physical-actions-in-the-next-step-box`). Include the pre-image `create table if not exists`, the guarded `update`, **and** an `insert into supabase_migrations.schema_migrations (version, name)` naming the FILE's 14-digit version, so the drift check matches it by version.
- **Ship the migration file anyway and let the staging migrator prove it.** `staging-migrate.yml` runs on every push to `main` and applied this file to staging within a minute of the merge, printing the migration's own `raise notice` — which is how the guard's no-op behaviour got *proven* on a live database instead of asserted. Write a verifying `do` block into any such migration for exactly that reason.
- A guard written on both halves of a half-applied state (here: the stale `md5(notes)` **and** a null `rep_seat_id`) is what makes the file safe to carry into a restored database — it no-ops on an already-correct row and declines a row that needs the *other* migration.

Related: [[verify-the-emitted-artifact-never-the-source]] · [[a-ledger-version-never-matches-the-file]] · [[automode-allow-cannot-authorize-editing-the-permission-config]]
