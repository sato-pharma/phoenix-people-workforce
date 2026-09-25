---
name: portal-sidebar-real-source
description: "The PM/GPM employee-portal SIDEBAR is hardcoded in employee-portal-layout.tsx (buildEmployeePortalSections), NOT system-navigation.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6ceaecc2-d940-4a0e-9524-7fa7adc6fef0
---

GOTCHA (cost a wrong prod ship, 2026-06-22): the **employee-portal sidebar** (what PM/GPM/MR see) is rendered by `EmployeePortalChrome` from `buildEmployeePortalSections` in `src/components/employee-portal/employee-portal-layout.tsx` — a HARDCODED list of `{ title, items[] }` gated by `show*Tab` flags from `resolveEmployeePortalNavVisibility` (src/lib/employee-portal/navigation.ts). Render path: `app/employee-portals/layout.tsx` → `EmployeePortalServerShell` → `EmployeePortalChrome`.

`src/config/system-navigation.ts` `employeePortalNavigationSectionSeeds` does NOT drive the portal sidebar — it feeds the generic `Sidebar` (sidebar.tsx), the **command palette**, and document-title-sync only. Editing it changes the command palette, not the visible portal sidebar.

**Why:** I restructured the PM/GPM sidebar in system-navigation.ts (PR #395) → owner saw "nothing changed" in prod twice; the real fix was redoing it in employee-portal-layout.tsx (PR #401, prod b05383ae 2026-06-22).
**How to apply:** to change the PORTAL sidebar (sections/labels/order/move items), edit `buildEmployeePortalSections` in employee-portal-layout.tsx. To change the admin/workspace sidebar or the command palette, edit system-navigation.ts. Confirm the render path before shipping a nav change.

Also: module-control (`sidebar_module_assignments`) is an ALLOWLIST applied only by the generic Sidebar (moduleIdAllowed) — empty in prod (0 rows), so it filters nothing today. The portal chrome filters empty sections out automatically. Portal "Fingerprint Report" route = `/employee-portals/fingerprint-analytics` (not /attendance).
