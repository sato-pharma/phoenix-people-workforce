---
name: admin-shell-role-page-gate-bug
description: "New admin-shell report page for SFE Manager/Finance Manager/Financial Advisor must widen its own role gate, not just mirror another report's narrow nav-link role list — these roles have zero employee-portal fallback."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a690cf8-8dbf-4601-bf7e-146ef126e8f8
---

When building a NEW page/report that SFE Manager, Finance Manager, Financial
Advisor, or Talent Acquisition (the `adminShellEmployeeRoles` set in
`src/lib/auth/permissions.ts`) are supposed to be able to view, the page's
ADMIN-SHELL gate must explicitly include those roles — do not narrow it to
just CEO+Super Admin by copying another report's admin-nav SIDEBAR LINK role
list (e.g. `roles: ["Super Admin", "CEO"]` in `system-navigation.ts`).

**Why:** `resolveNavigationMode()` puts these four roles in `"admin"` mode
(they're in `adminShellEmployeeRoles`, not `portalNavigationRoles`). The
shared `assertEmployeePortalMarketingPageAccess`-style guard unconditionally
redirects any non-`"employee-portal"`-navigationMode role away from EVERY
`/employee-portals/**` page, with no exception. So for these four roles, the
admin-shell page is their ONLY possible route — there is no portal fallback.
Shipped this exact bug in the Marketing Coverage Report (PR #770): copied
ROI Tracking's narrow admin-NAV role list (`Super Admin`, `CEO`) into the
admin-shell PAGE gate, not realizing ROI Tracking's actual page gate
(`assertMarketingAdminPageAccess({allowCompanyOversight: true})`) is far
broader (8 roles) specifically to cover this. Result: SFE Manager/Finance
Manager/Financial Advisor bounced between the admin page (redirects to the
portal page) and the portal page (redirects to `/overview`) with zero working
route, live in production, caught only by manual role-by-role browser
verification — the pinned unit test encoded the same wrong assumption as the
code, so it didn't catch it. Fixed in PR #778 by widening
`coverageReportAdminShellRoles` in
`src/lib/marketing-requests/coverage-report-access.ts` to 5 roles (CEO, Super
Admin, SFE Manager, Finance Manager, Financial Advisor) and adding a
regression test (`runMarketingCoverageReportReachabilityTests`) that checks
reachability using the real `resolveNavigationMode()` function directly
rather than a second hand-maintained role list.

**How to apply:** Before shipping any new page gate for a role outside
`portalNavigationRoles`, check whether that role can ACTUALLY reach the page
via any shell — don't assume "narrow nav link precedent" implies "narrow page
gate is fine." A nav link and a page gate answer different questions:
nav-link role lists can stay narrow (Modules Control can grant a visible link
per-user), but the page gate for any `adminShellEmployeeRoles` viewer must be
inclusive or that role has no route at all. When adding a viewer role to a
page's intended-access set, prefer a reachability test built on the real
`resolveNavigationMode()` over a second pinned role list, so the two can't
silently drift apart the way they did here. See
marketing-coverage-report-build for the feature this bug shipped in.

**Confirmed fixed and live** (2026-07-04): PR #778 merged to `main`, deployed
to production (`https://phoenix-workforce.vercel.app`, deployment
`dpl_DxVNEYxLFqfUyNbHGWchkHiTENVR`, commit `fd7d0da1`), and all 5 relevant
roles browser-verified post-fix on the local dev server against production
Supabase data:
- **SFE Manager** — reaches `/admin/marketing-requests/coverage-report`
  cleanly (previously bounced), sees 217/company-wide requests (correctly
  unrestricted — it's in `coverageReportCompanyWideRoles`).
- **Finance Manager** and **Financial Advisor** — both reach the page cleanly
  (previously bounced), both show 0 requests in scope (correct fail-closed
  scoping for a synthetic dev-auth account with no resolvable hierarchy
  placement — NOT a bug; these two roles are deliberately scoped, not
  company-wide, unlike SFE Manager).
- **CEO** and **Super Admin** re-verified unaffected by the fix: both still
  show 217/74-filtered company-wide requests with identical KPI math to the
  pre-fix baseline; Super Admin still sees the "Full sales history" link per
  pharmacy, CEO still correctly does not.
No further action needed on this bug — closed.
