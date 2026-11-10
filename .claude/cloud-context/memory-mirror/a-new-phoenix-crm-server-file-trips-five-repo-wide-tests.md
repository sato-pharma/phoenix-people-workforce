---
name: a-new-phoenix-crm-server-file-trips-five-repo-wide-tests
description: "A new file under src/lib/phoenix-crm/server that reads a new table, the visits or capture provenance trips five repo-wide tests no module test names — register it before the push"
metadata:
  node_type: memory
  type: project
  originSessionId: 69cc291e-284a-4a94-a402-f31715861ec2
  modified: 2026-11-10T20:08:18.731Z
---

On 10 Nov 2026 the far-visit safeguards PR (sato-pharma/phoenix-people-workforce#246) went red in CI on five tests that none of the touched module tests mention. Each one fires on ANY new Phoenix CRM server file of the same shape:

1. `tests/phoenix-crm-boundary.test.ts` — a `phoenix_crm_*` table the services read must be created by a migration in `LATER_MIGRATIONS`; add the new migration file there (it must also pass `assertMigrationHygiene`: `begin;` then `set local lock_timeout = '5s';` first, `notify pgrst` line, `commit;` last).
2. `tests/phoenix-crm-blind-half.test.ts` — any file naming `phoenix_crm_visit_capture_provenance` (or another silent table) must be in `BLIND_READERS` with a reason.
3. `tests/phoenix-crm-imported-history.test.ts` — every `phoenix_crm_visits` read must name `imported_from_ireports360_at` in its own statement, or raise the file's baseline on purpose.
4. `tests/performance-phase-3.test.ts` — a file naming a unified CRM view may not add a `.range(` (the visit-lifecycle detector sits exactly at its cap of 12).
5. `tests/page-change-fewer-waves.test.ts` — `loadVisitDay`'s second `Promise.all` is pinned to exactly names, recordings, dayReads; a new date-only read joins `dayReads`.

Also `tests/phoenix-crm-visit-far-refusal.test.ts` requires the rep-only far guard within 200 characters of `visitAwayFromValidatedPlace(`.

The trusted-point PR (sato-pharma/phoenix-people-workforce#254, 10 Nov 2026) tripped four MORE of the same kind:
- A new `src/lib/crm/*` file reading `CRM_CHECKINS_UNIFIED_VIEW` must join `CRM_OTHER_MIRROR_ALLOW_LIST` in `tests/crm-single-source.test.ts` AND the `direct` list in `tests/phoenix-crm-visits-everywhere.test.ts` ("who reads the check-in view directly").
- Naming a `phoenix_crm_visits` column that contains `ireports360_` (e.g. `ireports360_checkin_id`) trips the `/ireports360_/i` isolation scan in `tests/phoenix-crm-boundary.test.ts`; Phoenix's own columns are exempted with a `replaceAll` there.
- Any filter added to the signboard backlog query must sit ABOVE `.is("shared_place_id", null)`: `tests/phoenix-crm-signboard-check.test.ts` allows only 400 characters between it and `.limit(limit)`.

A file-scan test runs locally in seconds with a throwaway runner that imports just those `run…Tests` functions.

**Why:** the spare laptop was unreachable, so the touched-tests run never happened and CI found them; each red costs a full CI run.

**How to apply:** when adding a Phoenix CRM server file, include these five tests in the targeted run before pushing. Related: [[the-spare-laptop-runs-the-tests]].
