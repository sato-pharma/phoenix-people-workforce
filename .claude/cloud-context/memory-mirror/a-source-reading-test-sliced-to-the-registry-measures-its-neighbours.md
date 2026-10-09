---
name: a-source-reading-test-sliced-to-the-registry-measures-its-neighbours
description: A test that slices a file from its own subject to a far-off landmark silently grows to cover every later addition — tests/phoenix-crm-needs-you-source counted 7 guards instead of 6 the moment an unrelated adapter was appended.
metadata:
  type: project
---

`tests/phoenix-crm-needs-you-source.test.ts` sliced `src/lib/needs-you/sources.ts` from
`const phoenixCrmDecisions:` to `export const needsYouAdapters` — the registry at the end of the file
— and counted `> 0) {` inside it, asserting 6. Adding an unrelated adapter after it on 2026-10-09
(`closing-publication-drift`, whose own `cells > 0` guard matched) made it read 7, and the failure
named the Phoenix CRM adapter, which nobody had touched.

**Why:** the window was right only by luck — the adapters already sitting between the two anchors
happened not to use that spelling. The assertion means "this adapter's own guards", so the slice has
to be this adapter's own.

**How to apply:** bound a source-reading slice by the NEXT instance of the same kind of thing
(`/\nconst \w+: NeedsYouAdapter = \{/`), never by a landmark further down the file, and assert the
window holds exactly one of them — otherwise every assertion in it is quietly reading its neighbours.
A failing count that names code you did not change is this shape. Related:
[[verify-the-emitted-artifact-never-the-source]].
