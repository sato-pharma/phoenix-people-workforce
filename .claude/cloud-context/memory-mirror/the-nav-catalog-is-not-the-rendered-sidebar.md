---
name: the-nav-catalog-is-not-the-rendered-sidebar
description: "`system-navigation.ts` drives the ADMIN rail but NOT the employee portal, which is hand-built in buildEmployeePortalSections() — and the catalog's hrefs and labels DIFFER from the rendered ones (payslips, vacation request/report, Command Center, Request Support). A row rendering also does not mean the action is permitted: the Financial Advisor's three approval rows open and 403"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T04:31:10.779Z
---

Two traps, both measured on 2026-10-06 while building the *Inside Phoenix* shot lists. The first
had already produced a wrong route table.

## 1. The two shells have OPPOSITE sources of truth

- **Admin rail: `src/config/system-navigation.ts` IS authoritative.** There is no
  `buildAdminSections()`. Chain: `app-shell.tsx:161` → `sidebar.tsx:849-862` →
  `getNavigationSections("admin")` → `adminNavigationSections` (`system-navigation.ts:5315`)
  → `getSections` (`active-path.ts:229-274`) → `groupAdminSections` (11 domains).
  🔴 **`adminNavigationSectionSeeds` is NOT what renders** — `promoteHubRows` replaces each hub-door
  row with that hub's `*PageItems` cards, so a rendered row may be declared in a `*PageItems` array,
  not in the seed block.
- **Employee portal: `system-navigation.ts` is a CATALOG ONLY.** It drives ⌘K and tab titles. The
  rendered rail is hand-built in `buildEmployeePortalSections()`
  (`src/components/employee-portal/employee-portal-layout.tsx:324-633`), fed by
  `resolveEmployeePortalNavVisibility()` (`src/lib/employee-portal/navigation.ts:520-1117`). The file
  says so at `system-navigation.ts:1756-1759` and `:1990-1991`.

🔴 **So the catalog's href and label can both be wrong for the portal.** Measured differences:
`/payslips` (catalog) vs **`/employee-portals/payslips`** (rendered); `/leave-management/vacation-request`
and `/leave-management/vacation-report` vs **`/employee-portals/vacation-request`** and
**`/employee-portals/vacation-report`**; "Overview" vs **"Command Center"**; "HR Support" vs
**"Request Support"**. Both pages exist in each pair, so nothing errors — you just document or
automate the wrong one. **Read the rendered source for the portal, the catalog for admin.**

## 2. A rendered nav row is NOT a permission

`Financial Advisor` renders **Leave Approvals**, **Excuse Approvals** and **Other Approvals** —
those rows gate on `leave:read` plus the nav-only list `leaveExcuseApproverAdminNavigationRoles`
(`system-navigation.ts:195-200`). Its matrix (`permissions.ts:1228-1236`) holds
`leave: ["read","create"]` and **no `approve` action anywhere**, while the decision calls
`assertPermission(access, "leave", "approve")` (`src/lib/vacation/service.ts:3805`, `:4562`, `:5733`).
**The page opens and the act 403s.** Never infer a capability from a visible row — read the matrix.
Same shape as `a-matrix-grant-is-only-gate-one-of-two`.

## Other measured facts worth not re-deriving

- **`SFE Manager` has a FLAT rail** — `flatSidebarRoles` (`active-path.ts:112`): no domains, no
  headings, 72 rows in 29 blocks. Every other admin role gets 11 collapsible domains.
- **`Finance Manager` has 18 rows and NO expenses, outstation or audit log** — the
  `expenses-outstation` section is Super Admin/CEO only and carries the owner's 2026-08-10
  instruction verbatim; `/admin/logs` needs an `admin` grant he lacks. His only approvals surface is
  one button, `/admin/finance-leave-management`.
- **No `Financial Advisor` login exists** on production or staging (0 rows); the role string is
  permitted by `app_auth_users_role_check` (the comment at
  `src/lib/workspace/admin-shell-employee-roles.ts:21` saying otherwise is stale).
- **There is no cron/background-jobs admin screen.** `/admin/cron-control` was retired 2026-08-30 to
  a redirect stub and its row deleted. `/admin/workflow-control` is approval-workflow config, not cron.
- **`/employee-portals/my-team` does not exist.** A DM's team surfaces are five separate routes.
- **`nav_personal_layout` (admin mode only) rewrites the rail per user.** `B-10` has one: CEO Command
  Center hidden, 9 items promoted to the **top horizontal bar**, 51 section orderings — so his rail
  never matches the documented default. `A-2`, `B-185` and `admin-HR` have none.
- **A `user_module_locks` row does not hide a tile — it draws a padlock** and swaps the page body
  for `ModuleLockedNotice`.
- **Reproduce any role's admin rail** without guessing:
  `node --experimental-strip-types --experimental-loader ./tests/alias-loader.mjs` over
  `getSections(getNavigationSections('admin'), 'admin', buildPermissionLookup(permissionMatrix, role), role)`.
