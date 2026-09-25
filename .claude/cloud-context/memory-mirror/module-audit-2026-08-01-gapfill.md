---
name: module-audit-2026-08-01-gapfill
description: "Phase 1 of 2 of the 2026-08-01 gap-fill audit (wf_6db2a1ad-d04). Its 7 adversarial verifiers FAILED on the session limit, so everything here is an UNVERIFIED lead - never quote it as a confirmed defect; see module-audit-2026-08-01-verdicts"
metadata: 
  node_type: memory
  type: project
---

# Gap-fill audit results (verify workflow wf_6db2a1ad-d04, phase 1 of 2)
Verify phase (7 adversarial verifiers) FAILED on session limit — resume pending.

========== report-it [partial] ==========
PURPOSE: VigiFlow-inspired adverse-drug-reaction intake: any authenticated employee submits structured ADR reports (patient initials/sex/DOB, reactions, suspected medicines) stored as JSONB in report_it_reports; Super Admin/CEO/Finance Manager (report_it:export) or hr_ids in the report_it_dashboard_access allowlist review all reports via portal/admin dashboards with filters and XLSX export; everyone else sees only their own submissions.
GAPS:
  [HIGH] Audit logging declared but never implemented — report_it_audit_logs has zero writers
    EV: Table exists with index+RLS in supabase/migrations/20260711135352 baseline (line ~19795) but no code references it outside SQL/docs; src/lib/security/access-registry.ts:572 declares /api/report-it/submit audit:{classification:"mutation", required:true} yet app/api/report-it/submit/route.ts writes no audit entry, and list/[id]/XLSX-export views of patient health data log nothing.
    IMPACT: No traceability of who viewed or exported ADR PII in a regulated pharmacovigilance dataset; the access registry's audit claim is false documentation, so compliance reviews relying on it are misled.
  [HIGH] No server-side validation of the report payload
    EV: app/api/report-it/submit/route.ts:49 blind-casts body.payload as ReportItPayload; submitReport (service.ts:36-46) dereferences payload.reactions/.medicines with no shape, size, or enum checks; a payload without reactions throws a raw TypeError surfaced as HTTP 400.
    IMPACT: Any authenticated user can persist arbitrary/oversized JSONB into the regulated dataset, poisoning the dashboard, KPIs, and exports; data integrity of pharmacovigilance records cannot be defended.
  [HIGH] No notification, workflow, or SLA path — serious ADRs sit unseen
    EV: No report_it reference in src/lib/notifications; status is hardcoded 'submitted' (service.ts:63) with no transitions and no workflow-registry module despite the platform convention; the only reviewer surface is a pull-based dashboard gated to 3 roles + one allowlisted hr_id (a-3).
    IMPACT: A report flagged is_serious=true (life-threatening/death) generates zero outreach; regulatory expedited-reporting clocks (~15 days for serious ADRs) can silently lapse if the PV officer doesn't open the page.
  [MEDIUM] Routes skip assertPermission; allowlist outranks the role matrix and is SQL-only
    EV: All three routes check only guest/hrId (e.g. list/route.ts:21), never assertPermission(ctx,'report_it',...) — unlike app/(admin)/admin/report-it/new/page.tsx which does. canViewAllReports (service.ts:8-18) grants full PII visibility to any hr_id row in report_it_dashboard_access regardless of role; no UI/API manages that table (grep: only service.ts reads it) and grants are unaudited.
    IMPACT: Runtime role_permission_overrides revoking report_it have no effect on the API; a stale allowlist row silently keeps company-wide ADR access forever, and nobody can see or revoke grants without raw SQL against production.
  [MEDIUM] Test coverage is matrix-only; self-scope and filter robustness nits; no PII retention path
    EV: tests/report-it-access.test.ts (wired run-tests.ts:939) asserts only static permissionMatrix entries — no tests of canViewAllReports precedence, listReports self-scoping, or route auth. service.ts:106 compares raw access.hrId against submitted_by_hr_id (violates hrIdsMatch convention); listReports:120 interpolates submittedBy unsanitized into a PostgREST .or() string (injection confined to the OR group — no scope escape); list route has no limit clamp; XLSX export only covers the loaded 50-row page; no delete/anonymize/retention mechanism for patient DOB/pregnancy/weight data.
    IMPACT: The scoping logic that actually protects patient data is unverified by any test (the prior coverage claim was false); PII accumulates indefinitely with no lawful-retention story; filter edge cases return confusing 400s.
RECS:
  [high/S] Write audit entries for submit, all-reports view, and export into report_it_audit_logs
    WHY: The table, index, and FK already exist and the access registry already promises this — it is purely wiring in service.ts (submitReport, listReports/getReport when canViewAllReports, plus an export beacon). Closes the biggest compliance hole at minimal cost.
  [high/M] Notify PV reviewers on submission via the existing outbox, escalated when is_serious
    WHY: Reuses the platform's notification outbox; recipients = allowlist rows + export-role holders. Turns a pull-only dashboard into a push flow and protects the ~15-day regulatory clock for serious ADRs — the highest business-risk gap.
  [medium/S] Validate the submit payload server-side and clamp list pagination
    WHY: A small schema guard (required reactions/medicines arrays, enum checks against the constants already exported from types.ts, size caps) plus Math.min on limit prevents garbage rows in a regulated dataset and removes the raw-TypeError 400 path.
  [medium/M] Add assertPermission to the three routes and a permission-gated admin surface for report_it_dashboard_access
    WHY: Brings the module in line with the documented API convention (making runtime permission overrides effective) and makes the allowlist visible, revocable, and audited instead of SQL-only tribal knowledge.
  [medium/M] Add real behavior tests for the access gate and self-scoping using the repo's test-seam pattern
    WHY: Export the scoping decisions as pure functions (never build a real Supabase client — .env.local points at prod) and test: allowlist-vs-matrix precedence, self-only filtering, guest 401s. Replaces the falsely-claimed coverage with coverage of the logic that actually guards patient data.

========== platform-admin-residue [solid] ==========
PURPOSE: Cross-cutting admin plumbing: platform/metrics.ts aggregates 9 domain KPI groups (workforce, payroll, sales, expenses, recruitment, attendance, leave, lifecycle risk, communication) behind per-resource canAccess gates and is LIVE — consumed by the /admin command center (app/(admin)/admin/page.tsx via src/lib/admin/command-center.ts), the CEO command center (src/lib/ceo/command-center.ts), src/lib/overview/service.ts and src/lib/admin/service.ts, with tests wired (tests/platform-metrics.test.ts). The admin trio: modules-control.ts curates per-user/role/position/line sidebar modules (double Super Admin gate at route app/api/admin/modules-control/route.ts and in-service, validation refuses modules the target's permission matrix can't back, audited with old/new values); command-center.ts assembles the /admin dashboard snapshot; system-cleanup.ts is a Super Admin-only hard-delete center for exactly 3 record types (vacation requests, outstation expenses, weekly/monthly plans) with a 25-record bulk cap, write-ahead snapshot into admin_cleanup_events (delete refused if history insert fails), required audit log, payroll-lock block for outstation rows, and CSRF-checked POST. hr-calendar exposes every employee's birth date, work email, hire date and manager via app/(admin)/hr-calendar/page.tsx — gate verified: server-side canAccess(hr_calendar, read) before data load, and the default matrix grants hr_calendar to Super Admin ONLY (src/lib/auth/permissions.ts:406 is the sole grant); the client component makes no API fetch so there is no bypass endpoint, and the birthday cron reusing calendar-logic (app/api/notifications/birthdays/route.ts) is CRON_SECRET-gated. market/egx.ts (Yahoo Finance EGX 30 quote, 5-min Next data cache, 6s timeout, silent-null degradation) is DEAD CODE: getEgxQuote has zero importers — the pill shipped in commit 8ea424bf and its consumer was removed in 0bec34d5, so its silent-null failure is surfaced nowhere because nothing renders it.
GAPS:
  [LOW] market/egx.ts is dead code and the repo's only unauthenticated third-party runtime call
    EV: Grep for getEgxQuote|market/egx matches only src/lib/market/egx.ts itself; git log -S getEgxQuote shows the consumer added in 8ea424bf (keynote hero + EGX 30 pill) and removed in 0bec34d5 (CEO reuses the Admin identity hero card).
    IMPACT: Unreachable code that still advertises an outbound Yahoo Finance dependency; its documented degradation behavior can never be observed, and future readers may assume the CEO hero has a live market feed.
  [MEDIUM] System cleanup has no payroll-lock guard for vacation requests or weekly plans (outstation has one)
    EV: src/lib/admin/system-cleanup.ts: vacationRecord() (line ~381) and weeklyPlanRecord()/employeePlanRecord() hardcode safetyState "safe" / canDelete true, while outstationRecord() blocks via payrollLockState() when imported_payroll_batch_id/imported_to_payroll_at is set.
    IMPACT: A Super Admin can hard-delete an approved vacation request whose paid/unpaid days already fed a payroll batch, leaving payroll figures unexplainable by surviving records; only the admin_cleanup_events snapshot preserves the evidence.
  [MEDIUM] hr_calendar permission does double duty: birth-date/work-email calendar AND field-workforce-compliance APIs
    EV: src/config/system-navigation.ts:363,397,1452 and app/api/admin/field-workforce-compliance/*/route.ts all gate on resource hr_calendar; app/(admin)/hr-calendar/page.tsx gates the full unfiltered directory (birthDate, workEmail per src/lib/hr-calendar/service.ts) on the same resource.
    IMPACT: A role_permission_overrides row widening hr_calendar to give someone the compliance dashboards silently also hands them every employee's birth date and work email (and vice versa) — one override, two unrelated exposures.
  [MEDIUM] command-center.ts hardcodes showFinancialModules=true and carries a ~350-line duplicated fallback aggregation path
    EV: src/lib/admin/command-center.ts:652-654 (const showFinancialModules = true) and the second half of getAdminCommandCenterData (lines ~798-1002) re-implements payroll/sales/HR/expense/risk assembly with its own role gate (canUseCompanyPayrollSummary) instead of the matrix-based canAccess gates used by platform/metrics.ts.
    IMPACT: Two gating vocabularies for the same financial data can drift; the fallback fetchPayrollSummary() reads salary_batches/salary_records with the unscoped admin client guarded only by the role/scope check, and every future KPI must be added twice or silently diverge between paths.
  [LOW] System-cleanup listing full-scans five tables per dashboard load; modules-control save is non-atomic
    EV: src/lib/admin/system-cleanup.ts selectRows() paginates ALL rows of v2_vacation_requests, outstation_expense_requests, employee_plan_headers, weekly_plans (plus batched outstation_expenses probes) on every listCleanupRecords call with no limit; src/lib/admin/modules-control.ts saveModuleControlAssignments() does delete-then-insert as two PostgREST calls with best-effort compensation whose restore failure is only logError'd.
    IMPACT: The cleanup dashboard's cost grows unboundedly with history (same class of scan that caused the ~10s command-center incident); a crash between modules-control delete and insert silently strips a target's curated sidebar back to defaults.
RECS:
  [medium/S] Delete src/lib/market/egx.ts (or consciously rewire the EGX pill)
    WHY: Zero importers since commit 0bec34d5; removing it deletes the repo's only unauthenticated external runtime call surface for free. If the CEO hero should show the market pill again, that's a separate deliberate feature decision, not a reason to keep dead code.
  [high/M] Add a payroll-awareness guard to vacation/weekly-plan cleanup mirroring outstation's payrollLockState
    WHY: The asymmetry is the finding: outstation deletes are blocked once linked to an imported payroll batch, but vacation requests — which drive paid/unpaid day counts — are always 'safe'. Even a soft block (payroll_locked when the request's period overlaps an imported batch) closes the hole with the existing UI states.
  [medium/M] Split the hr_calendar resource (or add an explicit second resource for field-workforce-compliance)
    WHY: One permission currently unlocks two unrelated surfaces: company-wide birth dates/work emails and the compliance dashboards. A dedicated workforce_compliance resource keeps runtime overrides from silently widening PII exposure; the matrix and system-navigation.ts already support adding a resource cheaply.
  [medium/M] Collapse command-center.ts's fallback path onto platform/metrics.ts gating
    WHY: The fallback duplicates the primary aggregation with a different (role-name-based) financial gate; routing the fallback through the same canAccess-gated getters removes ~300 lines and one entire class of gate-drift bugs. Tests already exist (tests/platform-metrics.test.ts, tests/ceo-command-center.test.ts) to pin behavior.
  [medium/M] Bound the system-cleanup dashboard queries (server-side filters/limits instead of full scans)
    WHY: listCleanupRecords loads every row ever created across five tables, then filters in memory. Pushing dateFrom/dateTo/status into the PostgREST query with a hard row cap keeps the Super Admin page fast as history accumulates — same lesson already learned on the command center's sales_records scan.

========== root-pages [solid] ==========
PURPOSE: Page families that sit outside both group layouts and therefore must self-enforce access: the self-scope payslips viewer, legacy outstation redirect stub, role-landing dispatcher (/overview), public recruitment privacy policy, dev-only portal preview fixtures, login, and one-time password-setup links.
GAPS:
  [MEDIUM] No structural auth backstop for out-of-group pages
    EV: proxy.ts:127-133 matcher covers only /api/* and offer accept/reject (CSRF only); root layout has no gate. Safety rests entirely on each page calling resolveAuthenticatedPageAccess (app/payslips/page.tsx:22) or being a redirect stub. Every current page checks out, but nothing enforces the pattern.
    IMPACT: A future page added under app/ outside the route groups that forgets the gate ships publicly with no second line of defense — the exact class of bug this audit was checking for.
  [LOW] Real employee's dev-fixture photo publicly served in production
    EV: public/people/nahed-hattab-reference.png is referenced only by the dev-only page app/dev/identity-preview/page.tsx:19 (which 404s in prod), but public/ assets are always served unauthenticated in production at a guessable URL.
    IMPACT: A named employee's photo is fetchable by anyone without login — minor personal-data exposure with zero product use in production (the CEO photo, by contrast, is legitimately used by app/(admin)/admin/ceo-command-center/page.tsx:81).
  [LOW] Stale docs present the dead /employee/outstation/new stub as the live flow
    EV: app/employee/outstation/new/page.tsx:6-22 is a pure redirect stub (never renders a form), yet docs/system-overview.md:95 and :255 still document 'Employee opens /employee/outstation/new' as step 1 of the outstation workflow. No code links to the route.
    IMPACT: Misleads future sessions/developers into 'fixing' or extending a dead route; the stub itself is safe (no data, redirects into the gated portal).
  [LOW] Login auto-redirect trusts signature-only cookie verification
    EV: app/login/page.tsx:38-45 calls verifySessionToken (signature check) without the session-version/active/role revalidation that resolveSessionAccessContext performs (src/lib/auth/server.ts:474).
    IMPACT: A revoked-but-still-signed cookie bounces the user to a role landing page before the destination layout rejects it — one wasted redirect and a confusing loop risk, but no data exposure.
RECS:
  [high/S] Add a guard test asserting every out-of-group page gates or redirects
    WHY: Wire a unit test into tests/run-tests.ts that globs app/**/page.tsx outside (admin)/, employee-portals/, and the intentional-public allowlist (login, privacy, password-setup, dev), and asserts each source contains resolveAuthenticatedPageAccess or an unconditional redirect. Converts today's per-page discipline into an enforced invariant.
  [medium/S] Remove nahed-hattab-reference.png from public/ or swap for a synthetic image
    WHY: The only consumer is the dev-only identity-preview page; a stock/synthetic placeholder serves the same purpose without shipping a real employee's photo unauthenticated in production.
  [medium/S] Delete the /employee/outstation/new stub or mark it as a legacy redirect, and fix docs/system-overview.md
    WHY: Update docs/system-overview.md:95,255 to describe the real /employee-portals expense flow; either drop the stub (if no old bookmarks/emails depend on it) or add a comment stating it exists solely for legacy links.
  [low/S] Reuse full session validation for the login-page auto-redirect
    WHY: Have app/login/page.tsx resolve via resolveAccessContextFromPage (already request-cached) instead of raw verifySessionToken, so revoked sessions land on the login form directly instead of bouncing through a rejected landing page.

VERIFY RESULTS: []