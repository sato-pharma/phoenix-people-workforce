---
name: portal-nav-registry-one-way-sync-test
description: "The portal bottom-nav sync test only checked registry->sidebar, so 5 sidebar tabs were unreachable on mobile for years; now checks both directions"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3edad962-84d8-49b6-8b66-d46fc9fd9a67
  modified: 2026-07-30T05:45:45.762Z
---

The employee portal has **two independent nav sources** that must agree:
- `buildEmployeePortalSections` (`src/components/employee-portal/employee-portal-layout.tsx`) — the
  desktop sidebar. See [[portal-sidebar-real-source]].
- `PORTAL_NAV_REGISTRY` (`src/components/employee-portal/employee-portal-nav-registry.ts`) — feeds
  the **mobile bottom nav** AND the **profile quick-navigation grid**.

`tests/employee-portal-bottom-nav.test.ts` claimed to "keep the two in sync" but only asserted
**registry → sidebar** (every registry href must exist in the layout — a dead-link guard). The
reverse was never checked, so a sidebar tab with no registry entry was invisible on mobile with no
test failure. Found 2026-07-30: **Weekly Sales, Sales Analytics, Territory & Sales Drilldown, My
Visits, Team Calendar** were all missing. Net effect — a Regional Manager's default mobile bottom
bar contained **zero sales tabs**, and none of those pages could be pinned as a shortcut.

Fixed by adding the entries plus a **sidebar → registry** loop in the same test, with an explicit
`desktopOnlyPortalRoutes` exemption set (Private Calendar + the 8 Talent-Acquisition-only tools) and
`bottomNavAnchors` (Home/Profile, which are fixed and not user-pinnable).

Also note `DEFAULT_BOTTOM_NAV_HREFS` is a fixed priority list (plans, plans/calendar, report-it,
team-performance, marketing-requests, expense-dashboard, expenses, incentive, coaching) filtered by
visibility. It contains **no sales destination at all**, so sales roles still get a weak default bar
even now — the tabs are merely pin-able. Revisit if the owner wants better mobile defaults per role.

**How to apply:** when adding a portal sidebar tab, add a `PORTAL_NAV_REGISTRY` entry in the same
change, or the tab simply will not exist on mobile.
