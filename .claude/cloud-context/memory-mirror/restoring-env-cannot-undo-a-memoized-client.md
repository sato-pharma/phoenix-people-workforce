---
name: restoring-env-cannot-undo-a-memoized-client
description: "CI's unit suite tripled (145s→419s) on 2026-10-04 because one test set a stand-in NEXT_PUBLIC_SUPABASE_URL, built the memoized admin client, and restored process.env in a finally — which cannot rebuild an object that already exists, so every later canAccess spent a ~7s request abort against example.supabase.co and the fail-observable matrix load never caches a failure"
metadata:
  node_type: memory
  type: project
  originSessionId: d624580c-c45e-48b1-b4e7-ff702337a5cc
  modified: 2026-10-06T19:41:49.096Z
---

**A `finally` that restores `process.env` is not a rollback when the code it touched MEMOIZES a
client.** `getSupabaseAdmin()` caches its client in a module-level variable, and the cache was
keyed on nothing while its own comment claimed it was "keyed on the fixed service-role key". All
~2,200 tests share ONE node process, so when
`tests/phoenix-crm-refused-readings-board.test.ts` (#5295, 2026-10-04) set
`https://example.supabase.co` plus a stand-in key, built the client, and dutifully restored both
variables, the memo kept the stand-in client for the rest of the suite.

**Why that cost minutes rather than milliseconds, and the half that makes it non-obvious:**
`resolvePermissionMatrix()` deliberately does NOT cache a FAILED load (fail-observable, so a
transient DB error cannot quietly widen access). Before the leak, a `canAccess()` on a machine
with no service key threw instantly. After it, each call spent a full request abort failing
against the stand-in host — **14.2s locally, ~7s on the GitHub runner** — and paid it again every
call. Three permission-heavy tests went from **64ms combined to 252s** (canEdit reach 16ms→70s,
Google Calendar outage 3ms→49s, interview calendar CV screen 45ms→133s).

**How it was found, which is the reusable part.** Queue time was **3 seconds** and `checks` never
moved, so it was never GitHub, the runners or billing. The jump was a step change on one day, not
growth: sample the `Test` step per day from
`actions/runs/<id>/jobs` (`steps[].started_at/completed_at`), bisect to the run where it jumps,
then rank the log's own `PASS <name> (<ms>)` lines — the runner prints every test's duration. The
log's timestamps then date the leak precisely: last instant failure 18:46:56, the leaking test
passes 18:47:06, first 7-second failure 18:47:35.

**Fixed in #5407** by keying the memo on the URL + key it was built from (production behaviour
identical — neither ever changes there), pinned by
`tests/supabase-admin-client-env-cache.test.ts`. The fix belongs in the client, not the test that
tripped it: that test did everything right.

Related: [[verify-the-emitted-artifact-never-the-source]], [[a-green-test-run-carries-no-type-signal-at-all]].
