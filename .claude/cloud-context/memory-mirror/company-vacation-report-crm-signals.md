---
name: company-vacation-report-crm-signals
description: "New /admin/vacation-report module — CRM (iReports360) visit_type=-4 \"Annual Vacation\" signals cross-checked against fingerprint attendance, surfaced for Super Admin human review, never auto-written to balances."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2af55ae2-fc65-4cf8-9dd1-dd8575e265e0
---

Built 2026-07-13 (PR #1039, squash-merged to `main`, deployed to production rev `phoenix-hr-00128-tof`). Origin: the owner asked whether CRM visit data (iReports360 `visit_type=-4` = "Annual Vacation") could reveal undocumented employee leave, and initially wanted it bulk-written directly into real leave balances.

**Design decision (owner initially pushed back hard, then accepted):** CRM "AV" self-reports are unreliable on their own — live data showed fingerprint-contradicted "leave" days at Head Office. Bulk-writing them into `v2_vacation_requests` risked wrongly deducting real balances with no human check. Built instead: a read-only "Company Vacation Report" (`src/lib/vacation/company-vacation-report.ts`) that merges official HR-approved leave with CRM-derived "unverified" signals, plus a per-row **"Approve as real leave" toggle** (Super Admin only) that converts ONE specific CRM signal into a real, balance-deducting `vacation_requests` row via the existing `createVacationRequestAsAdmin` path — never automated, never bulk.

**Classification rules (owner-agreed, in `classifyAvDate()`):**
- Holiday-bridging days excluded.
- Rows where every CRM comment matches an excuse pattern are excluded (an "excuse" note is not a vacation claim).
- Device-mapped (fingerprint-tracked, effectively Head Office) employees: if worked minutes ≥ 5h that day (`AV_HALF_DAY_MAX_WORKED_MINUTES`), the AV signal is dropped as proven-worked; under 5h (or a single/no punch) downgrades to a 0.5-day signal rather than a full day.
- Never shows a 0-day row (explicit owner rule).
- HR-approved ranges suppress overlapping CRM signals so nothing double-counts.

**Bugs found and fixed during the owner's repeated "double-check" audits:** `v2_vacation_requests.working_days` is a stale DB-default column never written by the app — switched to `duration_days`; HR-request historical/current query split double-counted month-boundary-spanning requests — added `dedupeHrVacationRequestsById()`; approved-suppression compared raw HR_ID strings instead of `canonicalHrIdKey()`; an 11-agent "ultracode" adversarial audit (owner-invoked) additionally found a DST fall-back negative-minutes bug (fixed with a `span >= 0` guard in both `company-vacation-report.ts` and `attendance-cross-check.ts`) and a double-deduction risk where an approved wider-range request could contain a CRM date without tripping the DB's exact-tuple unique index — fixed with a pre-insert overlap-containment check (409) in `app/api/vacation/company-report/approve/route.ts`.

**How to apply:** if asked to touch CRM-derived leave/attendance signals again, do NOT bulk-write to balances — route any new signal type through this same per-row human-approval pattern. The approve route and report service are the reference implementation for "CRM signal → reviewed → real HR record."
