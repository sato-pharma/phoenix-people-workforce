---
name: a-new-phoenix-crm-server-file-trips-five-repo-wide-tests
description: "A new file under src/lib/phoenix-crm/server that reads a new table, the visits or capture provenance trips five repo-wide tests no module test names — register it before the push"
metadata:
  node_type: memory
  type: project
  originSessionId: 69cc291e-284a-4a94-a402-f31715861ec2
  modified: 2026-11-10T17:43:48.357Z
---

On 10 Nov 2026 the far-visit safeguards PR (sato-pharma/phoenix-people-workforce#246) went red in CI on five tests that none of the touched module tests mention. Each one fires on ANY new Phoenix CRM server file of the same shape:

1. `tests/phoenix-crm-boundary.test.ts` — a `phoenix_crm_*` table the services read must be created by a migration in `LATER_MIGRATIONS`; add the new migration file there (it must also pass `assertMigrationHygiene`: `begin;` then `set local lock_timeout = '5s';` first, `notify pgrst` line, `commit;` last).
2. `tests/phoenix-crm-blind-half.test.ts` — any file naming `phoenix_crm_visit_capture_provenance` (or another silent table) must be in `BLIND_READERS` with a reason.
3. `tests/phoenix-crm-imported-history.test.ts` — every `phoenix_crm_visits` read must name `imported_from_ireports360_at` in its own statement, or raise the file's baseline on purpose.
4. `tests/performance-phase-3.test.ts` — a file naming a unified CRM view may not add a `.range(` (the visit-lifecycle detector sits exactly at its cap of 12).
5. `tests/page-change-fewer-waves.test.ts` — `loadVisitDay`'s second `Promise.all` is pinned to exactly names, recordings, dayReads; a new date-only read joins `dayReads`.

Also `tests/phoenix-crm-visit-far-refusal.test.ts` requires the rep-only far guard within 200 characters of `visitAwayFromValidatedPlace(`.

**Why:** the spare laptop was unreachable, so the touched-tests run never happened and CI found them; each red costs a full CI run.

**How to apply:** when adding a Phoenix CRM server file, include these five tests in the targeted run before pushing. Related: [[the-spare-laptop-runs-the-tests]].
