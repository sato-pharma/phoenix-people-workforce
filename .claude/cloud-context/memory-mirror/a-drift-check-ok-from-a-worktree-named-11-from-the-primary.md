---
name: a-drift-check-ok-from-a-worktree-named-11-from-the-primary
description: "the migration drift check named 11 unrecorded migrations from a checkout 18 commits behind and said OK from a tree at origin/main — the 11 were in main's ACKNOWLEDGED_EXCEPTIONS, so run it from a CURRENT tree, and answer a missing ledger row with an md5(prosrc) digest and an evidenced exception entry, never a catalog probe and never a ledger write"
metadata:
  node_type: memory
  type: project
  originSessionId: cf6beb56-5d9d-4a36-9dfa-de4f82b5dd7a
  modified: 2026-10-13T05:17:37.779Z
---

Measured 2026-10-13 Cairo, same command against production `ozucdzovmcqvepbozvqf`
(`node … scripts/check-migrations-applied.ts`): from a worktree at `origin/main` it printed
**"OK — every migration outside the grace window is accounted for"**; an hour later from the primary
checkout, **18 commits behind**, it named **11 migrations merged to main but not found, by version or
by name**, 58–150h old.

**The cause is the STALE CHECKOUT, not the worktree.** Those exact 11 filenames had been added to
`ACKNOWLEDGED_EXCEPTIONS` in `scripts/lib/migration-inventory.ts` on `origin/main` that same morning,
in a commit the primary did not have. `selectMissingMigrations` filters the exception list FIRST, so
the current tree excluded them and the stale tree judged them unacknowledged. Ruled out by
measurement before this was found: the grace window (each file's `git log -1 --format=%ct` is
identical from both trees, nothing sheltered in either), a changed ledger (`xmin` ordering shows the
newest non-mine row predates both of my inserts, so no row was deleted in the window), and the wrong
project (staging's ledger is a different size and the run printed production's ref). The check reads
`public.phx_ci_migration_versions()`, which is exactly `select version, name from
supabase_migrations.schema_migrations`.

**So: run the drift check from a tree at `origin/main`** — `git fetch` and compare — and treat its
output from a lagging checkout as a question, never a finding.

**And the documented answer to a missing ledger row is NOT a ledger write.** `docs/security/migration-ledger-reconciliation-2026-10-13.md`
(and the 2026-10-08 round before it), both on the owner's instruction: prove the file is applied with
**`md5(pg_proc.prosrc)` against the file's own dollar-quoted body**, check the file is that function's
LAST definer in `supabase/migrations/`, then record an evidenced `ACKNOWLEDGED_EXCEPTIONS` entry —
*"None needed applying, and nothing was written to production."* 🔴 **A catalog-presence probe proves
nothing here**, because `create or replace function` / `create table if not exists` / `add constraint`
leave an OLDER generation of the object satisfying the probe exactly as well as the current one; two
functions among those 11 are in fact SUPERSEDED, and re-applying their file would revert production.
See [[verify-the-emitted-artifact-never-the-source]].
