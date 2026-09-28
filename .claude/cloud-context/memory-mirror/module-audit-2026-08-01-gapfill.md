---
name: module-audit-2026-08-01-gapfill
description: "Phase 1 of the 2026-08-01 gap-fill audit (report-it, platform-admin plumbing, root-pages). Its adversarial VERIFY phase FAILED on the session limit, so every finding here is an UNVERIFIED lead — never quote one as a confirmed defect, and line numbers have rotted since. Kept for the durable module-architecture facts and the sharpest leads worth re-checking against live code; the verified calls live in module-audit-2026-08-01-verdicts."
metadata:
  node_type: memory
  type: project
  originSessionId: 40984f77-33d2-45f9-94fe-bf7b1b13be9d
  modified: 2026-09-26T05:49:02.421Z
---

🔴 **UNVERIFIED — the 7 adversarial verifiers never ran (session limit).** Treat everything below as a LEAD,
re-checked against live code before acting; the repo does ~46 commits/day so line numbers are stale and some
of these are likely fixed. The adversarially-verified calls from the same audit are in
[[module-audit-2026-08-01-verdicts]]. What survives here is the module ARCHITECTURE (durable) plus the leads
that still look most real.

## report-it (adverse-drug-reaction intake — patient PII)

**Architecture:** VigiFlow-inspired ADR intake — any authenticated employee submits structured reports
(patient initials/sex/DOB, reactions, suspected medicines) stored as JSONB in `report_it_reports`; reviewers
are Super Admin / CEO / Finance Manager (`report_it:export`) OR any hr_id in the `report_it_dashboard_access`
allowlist; everyone else sees only their own submissions. This is regulated pharmacovigilance data, NOT HR
data — [[report-it-sounds-like-hr-and-is-patient-data]].

**Leads:** (1) `report_it_audit_logs` has ZERO writers though the table exists and the access registry
declares `/api/report-it/submit` audit `required:true` — no traceability of who viewed/exported ADR PII.
(2) The submit route blind-casts `body.payload` with no server-side shape/size/enum validation — any user can
persist arbitrary/oversized JSONB into the regulated dataset. (3) No notification/workflow/SLA path — status
is hardcoded `'submitted'`, so an `is_serious=true` report generates zero outreach and the ~15-day regulatory
expedited-reporting clock can silently lapse (pull-only dashboard). (4) The three routes skip
`assertPermission` (guest/hrId check only), so runtime permission overrides don't reach the API; and the
`report_it_dashboard_access` allowlist OUTRANKS the role matrix, is SQL-only (no UI manages it), and is
unaudited — a stale row keeps company-wide ADR access forever.

## platform-admin plumbing

**Architecture:** `platform/metrics.ts` aggregates 9 domain KPI groups behind per-resource `canAccess` gates
(LIVE — feeds the admin and CEO command centers). `system-cleanup.ts` is a Super-Admin-only hard-delete
center for exactly 3 record types (vacation requests, outstation expenses, weekly/monthly plans) with a
25-record bulk cap, a write-ahead snapshot into `admin_cleanup_events` (delete refused if the snapshot insert
fails), required audit log, and CSRF-checked POST. `hr_calendar` is granted to **Super Admin only** by
default.

**Leads:** (1) 🔴 **system-cleanup blocks a payroll-linked OUTSTATION delete (`payrollLockState`) but NOT a
vacation-request or weekly-plan delete** — both hardcode "safe", so a Super Admin can hard-delete an approved
vacation whose paid/unpaid days already fed a payroll batch, leaving payroll unexplainable by surviving rows.
(2) 🔴 **`hr_calendar` does double duty** — it gates BOTH the birth-date/work-email calendar AND the
field-workforce-compliance APIs, so one `role_permission_overrides` row widening it silently hands over two
unrelated exposures. (3) `command-center.ts` hardcodes `showFinancialModules=true` and carries a ~350-line
DUPLICATED fallback aggregation gated by a role-name check (`canUseCompanyPayrollSummary`) instead of the
matrix `canAccess` gates — two gating vocabularies for the same financial data can drift. (4) `market/egx.ts`
(Yahoo Finance EGX 30) is DEAD CODE — zero importers since its consumer was removed — and is the repo's only
unauthenticated third-party runtime call. (5) system-cleanup's listing full-scans five tables per dashboard
load (unbounded), and modules-control's save is a non-atomic delete-then-insert (a crash between strips the
target's sidebar back to defaults).

## root-pages (outside both route-group layouts)

**Architecture:** pages that sit outside the `(admin)` and `employee-portals` layouts must SELF-ENFORCE
access (the self-scope payslips viewer, the `/overview` role dispatcher, login, one-time password-setup, the
public recruitment privacy policy, dev-only fixtures).

**Leads:** (1) 🔴 **No structural auth backstop** — `proxy.ts`'s matcher covers only `/api/*` and offer
accept/reject (CSRF), and the root layout has no gate, so a future out-of-group page that forgets to call
`resolveAuthenticatedPageAccess` ships PUBLIC with no second line of defense. A guard test globbing
`app/**/page.tsx` outside the groups (minus an intentional-public allowlist) would convert today's per-page
discipline into an enforced invariant. (2) A real employee's dev-fixture photo
(`public/people/nahed-hattab-reference.png`) is served unauthenticated in production though its only consumer
is a dev-only page. (3) `/employee/outstation/new` is a pure redirect stub that docs still present as the live
flow. (4) The login-page auto-redirect trusts signature-only cookie verification (`verifySessionToken`)
without the session-version/active/role revalidation the real access resolver does — one wasted redirect for
a revoked-but-signed cookie, no data exposure.
