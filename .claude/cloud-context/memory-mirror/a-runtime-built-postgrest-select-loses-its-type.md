---
name: a-runtime-built-postgrest-select-loses-its-type
description: "A PostgREST `.select()` string built at RUNTIME resolves to ParserError and takes the whole read's type with it — TS2352 on the cast, invisible to lint and to the test suite, so only a typecheck catches it; spell the select out as one literal and pin it against the list it mirrors."
metadata:
  node_type: memory
  type: project
  originSessionId: 02b15773-349d-45f7-b725-9ffb4deee410
  modified: 2026-10-06T14:05:24.809Z
---

Supabase's generated types parse the select **string** at compile time, so
``.select(`id, ${columns.join(", ")}`)`` resolves to
`ParserError<"Expected identifier at …">[]` and the whole read loses its type. The cast that
follows then fails with **TS2352** ("neither type sufficiently overlaps") — which reads like a
problem with the cast rather than with the select.

**Nothing else sees it.** On `remote-check all` for `draft-store.ts`'s `clearDraftColumns`
(2026-10-06): lint PASS 184s, **typecheck FAIL 131s on that one error**, test PASS 455s, build
PASS 121s. A green suite carries no type signal, and a build passes because the emitted JS is
correct — the string really is valid at runtime. So a change that builds a select dynamically is
exactly the shape that reaches a PR red.

**How to apply:** write the select out as ONE literal constant — it keeps the read narrow (15
columns, not `*`) and typed — and when it mirrors an allow-list, assert in the test that it names
exactly that list, in order. Without that assertion a column added to the list but not the select
reads back as `undefined`, so a "which rows are carrying a figure" pre-read reports nobody while
the write still nulls the column. `as unknown as T` would silence the error and keep the blindness.

See [[verify-the-emitted-artifact-never-the-source]] and
[[a-green-test-run-carries-no-type-signal-at-all]].
