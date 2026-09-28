---
name: module-audit-2026-08-01-digest
description: "Compressed map from the 2026-08-01 full module audit (workflow wf_6db2a1ad-d04): a one-line PURPOSE per module for all 21 groups plus the audit's own CRITIQUE (what went unaudited, which raw findings are unverified, and three systemic cross-cutting themes). This was RAW finder output — the VERIFIED findings live in module-audit-2026-08-01-verdicts, and the raw per-module TESTS/GAPS/RECS have been dropped as unverified and 56-days stale. Read the cross-cutting themes: nav-vs-gate drift, tested-engine != production-path, and fail-open guards on service-role infra."
metadata:
  node_type: memory
  type: project
  originSessionId: 40984f77-33d2-45f9-94fe-bf7b1b13be9d
  modified: 2026-09-26T02:06:50.248Z
---

This is the **compressed** form of the 2026-08-01 module audit's raw finder digest. The exhaustive
per-module TESTS / STRENGTHS / GAPS / OPEN / RECS were raw, partly truncated, unverified finder output and
have been dropped — **the VERIFIED, adversarially-checked findings are in
[[module-audit-2026-08-01-verdicts]]**, and specific code claims are 56 days stale (verify against current
code). What is kept is the durable system map and the audit's own meta-critique.

## The system map — one line per module (21 groups)

- **sales-data** [mature] — distributor sell-out ingestion via two pipelines (modern raw-sheet
  recognizer + pure strict validator run identically at analyze & commit, `sales-upload.ts`; legacy
  coded-template/Direct/Office, `monthly-distributor-import.ts` + `office-allocation.ts`) into
  `source_of_sales_*`; atomic `phx_finalize_sos_batch` supersedes the prior batch per distributor+period;
  builds the Monthly Closing matrix + guided closing run with a Super-Admin period lock + per-line
  publication gating; master-data imports with FK cascade validation.
- **sos-analytics** [solid] — two mounts: the heavy SoS dashboard engine (`sos-dashboard.ts`, per-viewer
  line/region/area/product lockdown, MoM/YoY pure layer, BI workbook/email) and the newer `analytics/`
  module (13 shared components at `/admin/analytics` + portal via `analytics_*` RPCs). Confidential locks
  (LA003/LA004/SS001 + Head Office) centralize in `access-scope.ts`, fail-closed at SQL/loader/row-guard.
- **marketing-roi** [solid] — marketing-spend lifecycle (`phx_decide_marketing_request_step`) measured
  against a flat 10x required return through ONE attribution engine
  (`getMarketingRoiReport`→`phx_marketing_request_roi_actuals_v2`) that all views compose, not
  re-implement; SMI executive BI over the same data; direct-orders is a parallel money path (deal caps,
  manager→CEO ladder, atomic SoS injection `phx_apply_direct_order_decision` + reversal).
- **payroll** [solid] — three coexisting generation surfaces all writing `salary_batches`/`salary_records`:
  legacy manual xlsx (9-state), CEO/Super-Admin Payroll Copilot, and the Automated Payroll wizard (Part 1/
  Part 2, Super-Admin publish-to-payslips, live since July 2026); + owner-locked incentive scheme, Egypt
  tax/SI calculator, bank exports, owner-locked Deductions Governance, self-scoped portal payslips.
- **leave-calendar** [solid] — full leave lifecycle (`src/lib/vacation`: balance math, evidence, SLA,
  retention, exports) + HO 2-hour excuses (`src/lib/excuses`, direct-manager only); three calendars
  (events, hr-calendar birthdays, private-calendar fusing fingerprint+leave+DV+holidays → No-Activity-Days
  feeding real deductions). The `api/vacation` (singular, Super-Admin Company Vacation Report) vs
  `api/vacations` (plural, employee workflow) split is INTENTIONAL, not drift.
- **attendance-fwc** [solid] — ZKTeco fingerprint punches via an on-prem agent
  (`POST /api/attendance/raw-punches`), a flexible-hours engine → day statuses (Fingerprint Report, Monthly
  Summary, Day-by-Day deduction candidates); FWC builds a parallel monthly matrix from the iReports360
  visits mirror, cross-checked against physical punches.
- **recruitment-cv** [mature] — full ATS (requisitions wrap organogram vacancies, registry-validated stage
  machine, dedupe National ID > email > phone); durable inbound-CV pipeline (WhatsApp webhook + email
  poller enqueue refs only; a SKIP-LOCKED worker downloads media, runs one combined OpenAI classify+extract,
  matches/creates the candidate, auto-applies high-confidence fields, dead-letters with alerts).
- **lifecycle** [solid] — employee lifecycle end to end: directory CRUD with salary/region/manager
  governance, 90-day probation (legacy + new `probation_cases`), resignation + terminate-and-open-vacancy
  (`phx_resign_employee_and_open_vacancy` also vacates the AU seat + kills access), contract renewal;
  `lifecycle-risk/metrics.ts` is a real pure lib (9 importers), not a stub.
- **e360-organogram** [solid] — Employee 360 (`src/lib/employee-360`) per-person field intelligence (CRM
  visits, sales rollup / PM product attribution, coaching, DV, before/after impact, expenses, role panels)
  behind a 360-specific viewer-scope gate (`access.ts`); the organogram renders the AU seat model
  (`au_v_org_tree`) line-scoped, vacancy report reconciled against seat-occupancy truth.
- **portal-shell** [solid] — the chrome & routing brain: role-driven portal sidebar
  (`buildEmployeePortalSections`) + mobile nav (`PORTAL_NAV_REGISTRY`) + per-person Modules Control; the
  landing command center (`home-snapshot.ts`); consolidated approvals (`approvals-hub` + `action-center`);
  the CEO command center; admin-shell role routing. Heavily commented with owner rulings, defended by a
  dense set of source-pinning guard tests.
- **crm-visits** [mature] — mirrors the external iReports360 (single visit truth) into
  `ireports360_visits`/`_checkins` via one write engine (`crm/sync.ts`) + three crons; agent→HR_ID
  waterfall (manual-override > crm_id > unique-username) with a post-exit attribution guard; ONE read door
  (`crm/reads.ts`) applying a shared resigned exclusion + read-time burst-duplicate collapse.
- **geo-territory** [solid] — Territory Management (`territory-management/service.ts`): brick-allocation
  geometry (MST/hull/orphan/overlap) + rep-residence 1-median over located bricks; brick-centroid geocode
  pipeline (LocationIQ + Google Places, governorate region-gate); canonical `geo/egypt-locations.ts`;
  Super-Admin pin correction. NOT a stub — its blocker is pin trustworthiness, as the owner suspects.
- **coaching-dv** [solid] — Coaching (`src/lib/coaching`, 20-item scored eval draft→submit→ack→lock via the
  workflow registry) + Double-visit analytics (`double-visit-analytics`, reads live off the CRM mirror since
  2026-07-04: per-manager coverage, cadence bands, same-day senior→junior→MR chain resolution, DV Planner,
  Sunday digest, integrity reports).
- **weekly-planning** [solid] — weekly/monthly plan builder + approval chain for eligible managers
  (`WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES`); role-aware workweek, cross-domain prefill, submit→manager→
  CEO→HR-ack via SECURITY DEFINER RPCs with optimistic revision locks; shared planning calendar with
  owner-decided per-role visibility; admin & portal render the same `PlansWorkspace` (no logic fork).
- **outstation-expenses** [solid] — GPS-verified outstation claims: a wizard captures live location, routes
  it vs the registered residence via Google Directions, applies distance/governorate/campaign policy, and
  auto-decides (accept → payroll ledger; reject → notified; unresolved → Super-Admin hold); parallel paths
  (MR tickets, admin manual, offline, Excel import) all converge on `outstation_expenses`.
- **comms** [solid] — a unified hub (`notifications/system.ts` `createSystemNotification`) fanning to
  in-app/email/Telegram/OneSignal with prefs, quiet-hours, retry; a durable email outbox
  (`notifications/email.ts`: atomic claims, backoff, reaper, 90-day PII cleanup, Resend-primary/
  Brevo-backup, suppression list, a pre-send Confidence Gate holding anomalous sends); internal mail, HR
  tickets, Report-It.
- **workflow-approvals** [solid] — the workflow registry (`workflow-registry/service.ts` + `runtime.ts`) is
  a DB-backed state-machine gate; 9 lib domains call `assertWorkflowRegistryTransition` (from→to,
  allowedRoles, expectedNextStatus cross-check). `workflow-control` (`/admin/workflow-control`) is a
  SEPARATE Super-Admin surface whose persistence/publish/rollback stack is feature-flagged OFF (7 routes can
  only 503).
- **auth-security** [mature] — app-managed authn/authz: HR_ID + bcrypt → an HMAC session cookie cross-checked
  every request against an `app_sessions` row (role/version/lifecycle/revocation, all rejections audited); a
  16-role permission matrix with portal floors + DB overrides (30 s cache, fail-closed to last-known-good);
  a declarative access registry enforced by tests; CSRF middleware (`proxy.ts`), login rate-limiting, an IP
  blocklist.
- **reporting-exports** [solid] — the data-in/out layer: a validated bulk employee-master import (dry-run +
  confirm, same validator both times), premium ExcelJS workbook builders, org/vacancy reports, the S1
  Business Review (baked seat-map snapshot, fail-closed portal scope), a Friday-cron full multi-module
  Supabase backup to Storage.
- **ops-observability** [solid] — a self-hosted obs stack (replaces Sentry): `app_error_events` →
  `/admin/error-monitor` + `/admin/system-issues` (deploy-aware status, AI triage, weekly health digest);
  Healthchecks.io dead-man on every cron; a cron-control dashboard; a background-jobs queue; a
  synthetic-journeys Playwright pipeline that is complete code but shelfware (nothing schedules it).
  `ai/openai-client.ts` is the single OpenAI choke point.
- **tests-ci-docs** [solid] — the verification harness: a hand-rolled unit suite (`tests/run-tests.ts`), a
  Playwright e2e suite, and the Actions workflows. ⚠ CI specifics here are point-in-time and now stale
  (AGENTS.md is the live source: 6 required checks, `test` split from `validate` on 2026-09-17, merge is
  branch-protected). Its three most-dangerous untested areas were: business-review-s1 portal scope; every
  browser-level approval workflow (the e2e suite has NEVER completed in CI); `src/lib/uploads` spreadsheet
  parsing (feeds payroll/sales/coaching/employee importers).

## The audit's CRITIQUE — what to distrust and what went unread

**Modules NO auditor actually read (verify before trusting they are safe):**
- 🔴 **report-it** — the biggest crack: a pharmacovigilance / adverse-drug-reaction module storing patient
  data via `getSupabaseAdmin`, with an ad-hoc `report_it_dashboard_access` allowlist OUTSIDE the permission
  matrix; its "coverage" test only checks the permission matrix and never imports `lib/report-it`. (Aligns
  with the standing rule that Report-It is patient data, not HR.)
- **hr-calendar** exposes every employee's birth date + emails through a 41-line pass-through — audit only
  its page access gate. **`market/egx.ts`** is the repo's only runtime dependency on an unauthenticated
  third-party (Yahoo Finance) — silent-breakage risk. **`platform/metrics.ts`** (473 lines) was named by no
  group. **`system-cleanup.ts`** (name implies destructive maintenance) was claimed by nobody. Root-level
  `app/payslips/` and `app/employee/outstation/new` sit outside both nav groups — confirm their auth gates
  match `resolveAuthenticatedPageAccess`.

**Raw findings the meta-audit flagged as UNVERIFIED — do not act on a raw GAP as a defect:** several were
code-reading-only or inflammatory — e.g. sos-analytics "panels hard-FAIL until migration …" (no one ran
staging; session memory frames the same state as "numbers haven't moved"), payroll "hard-coded fallbacks
render FABRICATED salary figures" (may be an owner-approved carve-out near the protected `payroll/policy.ts`
— confirm intent first), and weekly-planning's sweeping absolutes (they intersect the owner's deliberate
locked-approver model; need a dev-auth role sweep + owner-intent check).

## The three cross-cutting themes (the highest-value durable takeaways)

1. **Nav-registry vs server-gate drift is SYSTEMIC, not per-module** — at least 7 groups independently found
   pages that exist-but-are-unreachable or reachable-but-bounce (portal `/leave-management`, coaching dead
   DSM links + missing RM/TM nav, organogram hidden from TM/TA, unreachable portal Company Calendar,
   duplicate attendance pages in two nav trees, weekly-planning queues rendered to roles the server rejects).
   **One nav-catalog-vs-page-gate parity test harness would retire ~10 findings at once.**
2. **Tested-engine ≠ production-path** — the suite repeatedly pins code production never calls (outstation's
   fully-tested `decision.ts` is bypassed by the live submit path; weekly-planning's foundation tests cover
   the DEAD v1 state machine; six tests pin dead `src/lib/overview`; report-it and visits-report "coverage"
   tests a different module entirely). **"Extensive and wired into `run-tests.ts`" systematically OVERSTATES
   protection — every coverage claim needs an "is this the code that actually runs?" check first.**
3. **Fail-open guards on service-role infrastructure** — the same silent-degradation shape recurs:
   payroll's `?? getSupabaseAdmin()` RLS fallback, `assertPeriodNotLocked` failing open on a query error,
   `assertSameOriginMutation` return values discarded (found independently by 3 groups), tolerated
   geography-load failures, confidence-gate holds that retry anyway. **Root enabler: the repo's source-regex
   test style verifies a guard is CALLED, never that its result is USED — a lint rule for discarded guard
   returns would address the whole class.**
