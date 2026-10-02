---
name: renaming-a-nav-label-changes-its-persisted-moduleid
description: "Renaming a sidebar LABEL is safe now — Modules Control, sidebar_module_assignments and the label-embedding defaultModuleId() were retired 2026-08-28 (#2505). Saved nav layouts key on href and section id: an unknown href is appended to its section, but renaming a section ID orphans every saved arrangement. Never query or pin against the retired table."
metadata: 
  node_type: memory
  type: project
  originSessionId: c094902f-a921-4063-8b86-173c40fde1f7
  modified: 2026-10-02T16:39:25.068Z
---

**Current (since 2026-08-28, PR #2505):** Modules Control and `sidebar_module_assignments` are GONE,
and so are `defaultModuleId()` / `withModuleIds` in `src/config/system-navigation.ts` (no longer
anywhere under `src/`). The replacement is the per-caller personal layout `nav_personal_layout`
(`src/lib/navigation/personal-layout.ts`), which keys on **href** (and on the section id for
per-module rows) — never on a label. **So renaming a nav label orphans nothing.** See
[[admin-shell-sidebar-per-user-curation]] and [[nav-personal-layout-is-per-caller-never-a-targeting-matrix]].
**Superseded 2026-10-02:** previously "`defaultModuleId()` builds `prefix.sectionId.LABEL.href`, and
moduleIds are written to `sidebar_module_assignments` by Modules Control" — retired by PR #2505.

History (2026-08-09 → 2026-08-28): `defaultModuleId()` built a module's id as
`prefix.sectionId.LABEL.href`, so renaming a label changed its `moduleId`; saved curation holding the
OLD id stopped matching, `isEmployeePortalHrefCurated` returned false, and **the item silently
disappeared** from the sidebar of every person/role with an override configured. No error, no log.

**Why it mattered:** the failure was invisible in code review and in CI — it only showed up as "this
module vanished for one manager", long after the rename. The same shape survives in the new model for
an **href** change, not a label change: a saved personal layout that names the old href no longer
emits it (a layout can only rearrange hrefs present in the gated input), and the new href is APPENDED
to its original section — it still shows up, but loses the owner's placement.

**How to apply:** a label rename needs no pre-check. Do NOT run
`select count(*) from public.sidebar_module_assignments` or pin an explicit `moduleId` — that table,
its writer and the `moduleId` field are retired. When changing an **href**, expect the saved
`/admin/sidebar-layout` placement of that page to reset to its original section. 🔴 **Never rename a
SECTION `id`** — saved layouts are keyed by it, so a renamed id silently orphans every saved
arrangement; rename the section's `label` and keep the old `id` (as the "Planning Calendar" section
in `system-navigation.ts` does, with a comment saying so).
**Superseded 2026-10-02:** previously "before renaming any label, check `sidebar_module_assignments`
and pin the OLD id via `item.moduleId`" — PR #2505 (2026-08-28). Dated record: **0 rows in production
on 2026-08-09** before the PR #1954 renames, and still 0 at retirement. A stale comment in
`src/lib/navigation/active-path.ts` still mentions `defaultModuleId`. Related:
[[portal-sidebar-label-width-budget]].
