---
name: outstation-expense-deep-audit-2026-07
description: "How the Outstation & Expense module works: 'expenses' IS outstation (src/lib/outstation/); submit runs every check but NEVER decides — a failed check is flagged and the claim waits as `submitted` for a Super Admin, only a human rejects (an NSM's claim is never held); payroll is an ADDITION to net pay; approve/reject is Super Admin only; the live eligibility logic is INLINE in service.ts (decision.ts is dead code); two entry points skip the full engine. Holds owner rulings and open findings."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d2c7ad3-4ca0-47d6-8233-3a6e95d3b5bc
  modified: 2026-10-02T16:37:47.347Z
---

Deep read-only audit of the Outstation & Expense module (2026-07-17), then rebuilt and extended. The old
fraud-score / variance / auto-APPROVE-on-submit model is HISTORICAL, and so is the auto-decide-at-submit
model this note first recorded — below is the current behaviour (corrected 2026-10-02).

## How it works (durable mechanics)

- **ONE module — "expenses" IS outstation.** Everything lives under `src/lib/outstation/`; there is no
  `src/lib/expenses/`. 6 tables, all RLS-enabled, but the app uses the service-role client everywhere, so
  RLS is bypassed at runtime — **the app-layer gate is the real boundary.**
- **Submit FLAGS, it never decides — every claim waits for a human.** `submitOutstationRequest` still runs
  the eligibility engine and records each check's reason, but a failure HOLDS the claim as `submitted` in the
  pending approvals queue carrying that reason (`reviewHoldReasons`) — `rejected_by_system` is no longer
  reachable from the submit path, and the submit-time rejection email is gone (owner rule 2026-08-09,
  [[system-flags-expenses-never-rejects]]). A clean submission also persists as `submitted` and waits
  (PR #1916, 2026-08-08, [[outstation-submit-used-to-auto-approve-into-payroll]]); `calculation_status` still
  records `accepted_by_system` vs `submitted` as decision-support only. Only a Super Admin decides —
  `accepted_by_admin` / `rejected_by_admin`, audit-logged. The one exception: a National Sales Manager's
  outstation expense is never held (owner rule 2026-08-28). Status columns are free text, so new values never
  need a migration. The governorate HOLD (destination cannot be confirmed → `submitted`, not pushed to
  payroll, Super Admin notified; owner chose "hold when unconfirmed" over fail-open) is now one hold reason
  among several.
  **Superseded 2026-10-02:** previously "Submit AUTO-DECIDES and PERSISTS `accepted_by_system`/`rejected_by_system`; a rejection is kept and the employee notified; no human pending queue" — PR #1916 (2026-08-08) and the owner's never-auto-reject rule of 2026-08-09.
- 🔴 **The live eligibility logic is INLINE in `service.ts` — `src/lib/outstation/decision.ts` is DEAD
  CODE** (built during the redesign, never wired). The rules: distance ≥ 60 km (tolerance 58) AND destination
  outside the RESIDENCE governorate (`resolveFirstGovernorate` walks city→area→address) AND, for a DM/TM
  travelling, ≥1 double-visit and ≤2 campaign visits (`visitType -8` = campaign). Fuel = `distance × 2 × rate`
  (round-trip, default 1.8 EGP/km). If asked to change the approval flow, change the inline `service.ts`
  logic, not `decision.ts` and not a queue.
- 🔴 **Two entry points SKIP the full engine:** `submitMedicalRepSimpleExpenseRequest`
  (distance/governorate/campaign never applied) and `createManagerExpenseAsAdmin` (distance-only). Only the
  wizard and its offline wrapper run the full eligibility check. Neither self-approves any more: both insert
  as `submitted` and wait for a Super Admin (checked in `service.ts` 2026-10-02) — except an admin-entered
  claim for an NSM, which lands `accepted_by_system` under the never-held rule.
  **Superseded 2026-10-02:** previously "skip the engine and self-approve on insert" — PR #1916 (2026-08-08) made every submit path wait for a human.
- **Payroll is an ADDITION to net pay** (Part 2 / additions), NEVER a deduction. RPC
  `phx_import_approved_expenses_to_payroll` joins on `lower(hr_id)`, is delta-applied (idempotent), uses
  period = trip month + 1, and refuses before Part 1 is paid. Accepted → payroll; rejected → not. (Owner
  reversed an initial "remove payroll" ask — the linkage is KEPT.)
- **Approve / reject / delete are Super Admin only** (`assertOutstationAdminAccess`); Finance Manager and CEO
  are hard-listed read-only (`executionOnlyOutstationRoles`). 🔴 **The permission MATRIX grants DM/RM/NSM
  `outstation:approve`, but that does NOT reach the admin routes** — the matrix over-states authority (the
  stale DM/RM/NSM approve grant was later removed from the matrix; the DB workflow-registry may still list
  extra roles, but the code gate wins).
- **Tickets:** train/bus REQUIRES ≥1 ticket, hard-blocked both client and server (offline is exempt via
  `!offlineCaptured`); tickets travel as base64 data URLs → `uploadOutstationTicketAttachments` → bucket
  `outstation-evidence`, cols `ticket_attachment_paths`/`_metadata`. An employee can ADD extra tickets to
  their own train/bus non-rejected request AFTER submit (add-only, pre-payment, audited) via
  `addExtraTicketsToOwnOutstationRequest` — the extra cost ADDS to the total (recompute expected/claimed,
  never touch the allowance) and re-syncs the unpaid linked payroll row through the existing
  `syncLinkedOutstationPayrollExpense`. **Payroll lock:** `imported_to_payroll_at` /
  `imported_payroll_batch_id` block any edit once the trip is paid. Car evidence is hard-blocked client-side.

## Owner rulings

- Payroll linkage KEPT (the "remove payroll" task was dropped). Hold-when-governorate-unconfirmed over
  fail-open. The employee's self-service extra-ticket control lives INSIDE `PersonalExpenseWorkloadDashboard`'s
  per-row expand panel (desktop and mobile), gated to the viewer's OWN train/bus rows via a `viewerHrId` prop
  — passed only from the employee-portal page, NEVER from the admin-shell's team-wide view of the same
  component. The "Extra Tickets" count is also a column on that dashboard. Item 7 of the build list was
  REVOKED — do not build it.

## Open findings (informed, not asked to fix)

- **Finance Manager can edit GLOBAL policy** — `POST /api/outstation/policy` requires only generic
  `outstation:update`, which Finance Manager holds, so it can rewrite eligibility/fuel/allowance policy for
  everyone despite being execution-locked out of approving individual requests.
- **Admin single-request GET is over-gated** — `app/api/admin/outstation/[id]` GET requires action
  `"approve"` not `"read"`, so Finance Manager/CEO 403 even on read-only detail, contradicting the
  admin-access comment that they should see outstation data.
- **`workload-evidence` scoping** was the F2 fix — an `outstation:approve` role could read any employee's
  Double-Visit workload; now scoped via `canViewEmployeeExpenseScope`. Excel import trip-id collisions (R1)
  were fixed by content-hashing (`syntheticTripId`).
- **Portal UX gaps:** the wizard shows a generic "submitted successfully" toast (since #1916 nothing is
  decided at submit, so the toast is no longer hiding an outcome — the decision surfaces later on the Expense
  Dashboard status pill), and there is
  no resubmit/edit/cancel path — a rejection means starting over. Held rows are surfaced via a
  `PendingReviewRequestsCard`. Duplicated wizard fields (an editable copy beside a disabled
  "auto-resolved after submission" copy bound to the same state) look like leftover markup.

## The reusable lesson (cost a full prod apply→rollback→fix→re-apply cycle)

🔴 **Before dropping a DB column or table, grep ALL of `src` + `app` for its name** — typecheck does NOT
catch Supabase `.select("…col…")` strings or table-name string arguments. The redesign's "no traces"
migration dropped `variance_amount`/`fraud_flags_json` and `outstation_location_audit_logs` while live
cross-module consumers (`employee-360/deep-service.ts`, `admin/system-cleanup.ts`,
`workflow-control/definitions.ts`) still read them by string and threw in production.

**Dev-preview gotcha:** this module's worktree `.env.local` points at PRODUCTION Supabase.
`/api/dev-auth?role=X&hrId=<real HR_ID>&next=<path>` impersonates a real employee — read-only browsing is
safe, but **never click a submit/mutate action against a prod-pointed dev server**, and `next dev` 404s
`/api/dev-auth` outside `NODE_ENV=development` (see [[local-browser-verify-gotchas]]).

See [[outstation-expense-notifications-reject-only]] and [[expense-source-excel-vs-system]].
