---
name: a-narrowed-select-disarms-every-gate-downstream-of-it
description: "A .select() that omits a column makes it `undefined`, so any gate reading it silently stops firing — no error, no row, green tests."
metadata: 
  node_type: memory
  type: project
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-08-23T06:45:54.502Z
---

Marketing's `not_found` capture gate — the one `tests/marketing-submission-capture-gates.test.ts`
pins the existence of — **had never once fired in production.** `fetchPharmacyCodes` in
`src/lib/marketing-requests/service.ts` selected only `id, pharmacy_id, active`, so
`code.reference_status` was `undefined` on every row and `=== "not_found"` could never be true.
Fixed 2026-08-23 in [PR #2320](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2320).

**Why:** PostgREST does not error on a column you did not ask for — it simply is not there. The
TypeScript row type is usually cast (`as SomeDbRow`), so `tsc` does not object either. The gate
still exists, still reads well, and still has a test asserting the *rule* is in the source. Every
signal says "guarded". Only the data says otherwise. A source-pinned test that greps for
`reference_status === "not_found"` passes on a codebase where that branch is dead.

Nothing was mis-written this time: all 22 production request targets were `matched`, and the single
offerable `not_found` target was the fabricated nursery code `0000`. That was luck, not design.

**How to apply:** when a gate reads a field, check the `.select()` that loaded it — the two are
often hundreds of lines apart. Test it at the *select*, not at the branch:
`tests/nursery-venue-type.test.ts` asserts the select list itself contains `reference_status`, and
was verified by deleting the column and confirming that exact assertion fires. Prefer a
behavioural probe against production ("does any row reach this branch?") over reading the code —
that is what found it. Related: [[marketing-system-validated-means-no-human-looked]],
[[never-silent-drop-count-and-flag-instead]].
