---
name: renaming-a-nav-label-changes-its-persisted-moduleid
description: "defaultModuleId() embeds the nav LABEL, so renaming a sidebar label changes its moduleId — and moduleIds are persisted in sidebar_module_assignments."
metadata: 
  node_type: memory
  type: project
  originSessionId: c094902f-a921-4063-8b86-173c40fde1f7
  modified: 2026-08-09T12:35:06.082Z
---

`defaultModuleId()` in `src/config/system-navigation.ts` builds a module's id as
`prefix.sectionId.LABEL.href`. **Renaming a nav label therefore changes its `moduleId`** — and
moduleIds are written to the `sidebar_module_assignments` table by Modules Control.

Saved curation holding the OLD id stops matching the newly-computed id, and
`isEmployeePortalHrefCurated` then returns false, so **the item silently disappears** from the
sidebar of every person/role with an override configured. No error, no log.

**Why:** the failure is invisible in code review and in CI — it only shows up as "this module
vanished for one manager", long after the rename.

**How to apply:** before renaming any label in `system-navigation.ts`, check the table:
`select count(*) from public.sidebar_module_assignments;`. If it holds rows for that module, pin the
OLD id via the item's explicit `moduleId` field (`withModuleIds` uses `item.moduleId ?? default`).
Verified **0 rows in production on 2026-08-09** before the PR #1954 renames, so nothing needed
pinning — that emptiness is the current state, not a guarantee; re-check each time. A comment above
`defaultModuleId` now records this. Related: [[portal-sidebar-label-width-budget]].
