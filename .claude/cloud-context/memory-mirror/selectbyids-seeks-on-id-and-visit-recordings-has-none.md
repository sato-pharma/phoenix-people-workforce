---
name: selectbyids-seeks-on-id-and-visit-recordings-has-none
description: "Phoenix CRM's selectByIds keyset-pages on `id` by default, and phoenix_crm_visit_recordings has NO id column (its key is `path`) — reading it without naming \"path\" 42703s and every day holding a visit showed \"Could not load the visits.\"; it surfaced first in the test accounts because real reps log nothing on a Friday."
metadata:
  node_type: memory
  type: project
  originSessionId: 1665afc1-5cf8-4b21-b5a2-db1cafb1deed
  modified: 2026-10-16T16:38:14.036Z
---

`selectByIds` in `src/lib/phoenix-crm/server/db.ts` keyset-pages each chunk on a cursor column that defaults to `id`. Of the 13 tables read through it on 2026-10-16, `phoenix_crm_visit_recordings` was the ONLY one without an `id` — its key is `path` (15 columns, none named id). From #5999 (17:00 Cairo, 16 Oct 2026) `loadVisitDay` read the recordings for EVERY viewer, so every day with at least one visit failed with "Could not load the visits." — the rep's own day, the manager's full-day page (`day-detail.ts`), every past day. Fixed by PR 6009 (merged 19:31 Cairo): `selectByIds` takes a 6th parameter `cursorColumn = "id"` and the recordings read passes `"path"`; pinned in `tests/phoenix-crm-place-checks-in-overflow.test.ts`.

**Why:** a select is a string, so neither the compiler nor lint sees a missing column; and the break first showed only in the TEST accounts because real reps had 0 visits that Friday (78 on Thursday) — "only the test accounts are broken" was a calendar artefact, not a scope.

**How to apply:** any new `selectByIds` call on a table with no `id` passes its own key as the cursor column. When a Phoenix CRM screen fails "only for test accounts", check whether real reps simply have no rows that day before narrowing the cause to test data. Related: [[postgrest-in-with-hundreds-of-ids-silently-returns-nothing]], [[a-field-that-does-not-exist-is-a-silently-dead-branch]].
