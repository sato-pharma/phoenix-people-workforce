---
name: portal-admin-shared-component-redirect
description: "BUG CLASS — a component shared by (admin) routes and /employee-portals that hardcodes an admin nav path bounces portal users to the landing page (the (admin) layout redirects them). Fix = derive base from usePathname()."
metadata:
  node_type: memory
  type: reference
  originSessionId: 77d1b67e-6071-4e33-b292-07ab1e57d207
---

**Symptom:** a portal user clicks something (a tab, a row link, a submit button) and gets redirected to the landing page (`/employee-portals`).

**Root cause:** many components in `src/components/**` are rendered on BOTH the admin surface (routes under `app/(admin)/…` e.g. `/leave-management`, `/coaching`, `/sales`, `/workspace`) and the employee portal (`/employee-portals/…`). `app/(admin)/layout.tsx` (lines ~22-24) does `if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals")`. So ANY client navigation (`router.push`/`router.replace`/`<Link href>`/`window.location`) to a **hardcoded (admin)-group path** sends a portal user through that layout → bounced to the landing page.

**Fix pattern:** derive the navigation base from `usePathname()` (the component already knows which surface it's mounted on) — `pathname?.startsWith("/employee-portals") ? "<portal base>" : "<admin base>"` — instead of hardcoding the admin path. Equivalent alternative: pass an explicit `hrefBase`/`redirectTo` prop from each page.

**Fixed in PR #574** (3 instances, found via a 6-auditor portal-wide sweep + adversarial verify across all 50 `app/employee-portals/**/page.tsx`):
- `src/components/vacation/vacation-report.tsx` `buildReportUrl` (tab toggle / filter / pagination) — was `/leave-management/vacation-report`.
- `src/components/coaching/coaching-analytics-dashboard.tsx` per-rep link (line ~1188) — was `/coaching/<id>`; portal detail route is `/employee-portals/coaching/<id>`.
- `src/components/vacation/vacation-request-form.tsx` post-submit `router.push` — was `/leave-management/vacation-report`.

**When adding/reviewing any shared admin+portal component:** never hardcode an absolute app path for client nav; base it on `usePathname()`. Tests pin these (source-grep in `coaching-analytics.test.ts`, `workforce-hierarchy-continuity.test.ts`). See [[company-org-structure-head-office]], [[admin-route-group-shell]].
