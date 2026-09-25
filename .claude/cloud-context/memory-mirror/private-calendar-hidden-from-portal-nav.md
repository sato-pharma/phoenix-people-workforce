---
name: private-calendar-hidden-from-portal-nav
description: "Private Calendar hidden from ALL portal nav surfaces for every role; and the system-navigation seed → buildModuleCatalog coupling that ripples into the module-curation test"
metadata: 
  node_type: memory
  type: project
  originSessionId: a3462417-ba97-44f1-b5eb-ec7c49d18237
---

Owner asked (2026-07-17) to hide the personal **Private Calendar** (`/employee-portals/private-calendar`) module from the sidebar for ALL roles. Done in worktree `_wt-hide-private-calendar` / branch `codex/hide-private-calendar` (off origin/main). The module had THREE nav surfaces + one audit map — all must be handled to fully hide it:

1. Desktop portal sidebar — `buildEmployeePortalSections` in `employee-portal-layout.tsx` (gated by `showPrivateCalendarTab`, set `!isMedicalRep` in `src/lib/employee-portal/navigation.ts`). Removed the item + the flag (type field + assignment + destructure default). See [[portal-sidebar-real-source]].
2. Mobile bottom-nav / profile quick-grid — `PORTAL_NAV_REGISTRY` + `DEFAULT_BOTTOM_NAV_HREFS` in `employee-portal-nav-registry.ts` (its entry had NO flags → showed for everyone, incl. med reps the desktop flag excluded). Removed both.
3. ⌘K command palette / generic sidebar seed — `employeePortalNavigationSectionSeeds` in `system-navigation.ts`. Removed the seed item.

NOT touched (feature/route stays, only nav hidden): the page `app/employee-portals/private-calendar/page.tsx`, the `/admin/private-calendars` executive management page, the access-registry entries, and `src/lib/activity/modules.ts` (route→label audit map — kept so direct-URL visits still label correctly).

**GOTCHA (the non-obvious coupling):** removing a `system-navigation.ts` employee-portal SEED item also drops it from `buildModuleCatalog()` (`src/lib/admin/modules-control.ts`) and from `isEmployeePortalHrefCurated`'s href→moduleId map (`module-curation.ts`) — both derive from `getNavigationSections("employee-portal")`. So `tests/employee-portal-module-curation.test.ts`, which used Private Calendar as its `findModule(...)` fixture, broke. Re-pointed that fixture to **Deductions** (`/employee-portals/deductions`, label "Deductions") — it exists in both the seed AND the bottom-nav registry with no flags (med-rep-visible), mirroring exactly what Private Calendar provided. `moduleId` is content-derived (`portal.<sectionId>.<label>.<href>`, not array index), so removing one seed item never shifts other modules' IDs.

Also updated `tests/private-calendar.test.ts`: the two nav-presence asserts (portalLayoutSource / navRegistrySource) flipped `assert.match`→`assert.doesNotMatch`.

Validated in the worktree: typecheck ✓, full test suite ✓ (391 files; `private calendar` + `employee portal module curation` both PASS), lint ✓ (0 errors), build ✓. Did NOT run a live browser preview — `preview_start` ignores worktree cwd (would boot the OTHER session's shared checkout on the wrong branch) and local `.env.local` points at prod; the tests assert the removal at source level. Delivered (owner-approved): commit `9b426b6c` → pushed → **PR #1110 MERGED** into main (merge commit `19d5a572`, 2026-07-17; all CI green — lint-typecheck/validate/preview-smoke/Seer pass, full-e2e skipped). Merge auto-triggers GCP Cloud Run prod deploy (no-traffic→smoke→promote). Repo remote is `Phoenix-HR/phoenix-people-workforce`. Cleaned up (owner-approved): worktree `_wt-hide-private-calendar` removed + folder deleted, local branch deleted, remote branch auto-deleted on merge. Prod domain to verify after deploy: phoenix-hr.satopharma.com.
