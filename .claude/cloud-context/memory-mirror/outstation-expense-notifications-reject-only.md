---
name: outstation-expense-notifications-reject-only
description: "Outstation notification design: reject-only email to the employee PLUS (as of 2026-07-13) a new Super-Admin-only submit alert with full request details; high-risk digest REMOVED same day"
metadata: 
  node_type: memory
  type: project
  originSessionId: ad0de976-b05e-4e1d-8b5d-e079c07cc47f
---

Outstation & payroll-expense submissions still AUTO-APPROVE straight to payroll staging
(`submitOutstationRequest` → `approveOutstationRequestForPayroll`) — there is no human
pending-approval step. That original design is unchanged. What changed on 2026-07-13,
by explicit owner instruction, is the notification policy layered on top of it:

**Current state (2026-07-13 onward):**
1. **Submit alert (NEW)** — `notifyOutstationSubmitted` fires once per fresh submission,
   from inside `approveOutstationRequestForPayroll` (guarded by `existing.status !== "approved"`
   so a re-approve call never double-fires). Recipients: **every active Super Admin only**
   (`resolveActiveSuperAdminHrIds`, `app_auth_users` filtered to `role = "Super Admin"`) —
   explicitly NOT the submitter's manager, NOT Finance Manager/CEO. Channels: **email +
   Telegram only** (no in-app). Body contains the full request detail (employee, role,
   line/area, transport, trip dates, distance, fuel/ticket/allowance/meeting/other amounts,
   expected vs. claimed + variance, eligibility, approval recommendation, suspicious-location
   score, fraud flags, territory validation, GPS capture, notes) — an informational live feed,
   not an action queue (there's nothing to approve; it already auto-approved).
2. **Reject notification (unchanged)** — `notifyOutstationDecision` is still the ONLY email
   the *submitting employee* ever receives, fired only on manual Super Admin rejection.
3. **High-risk digest — REMOVED 2026-07-13, same session.** The owner first said keep it
   (while adding #1), then minutes later reversed and said remove it — the new full-detail
   submit alert made the separate daily digest redundant. `src/lib/outstation/high-risk-digest.ts`
   (`runOutstationHighRiskDigest`) was deleted entirely, unwired from the daily cron
   (`app/api/notifications/daily/route.ts` — removed the import, the `Promise.all` entry, and
   the `outstationHighRisk` destructure/response-field to keep the array positional), and the
   two tests that referenced it (`tests/email-notifications.test.ts` catch-boundary assertion,
   `tests/notification-governance-hardening.test.ts` `highRiskDigestSource` check) were updated
   to drop those assertions. `isHighRiskRequest`/`highRiskReasons` in `src/lib/outstation/expense-risk.ts`
   were LEFT ALONE — still used by the Expense Command Center dashboard (`expense-command.ts`)
   to flag rows in the UI; only the daily digest email/Telegram job was removed, not the
   underlying risk scoring.
4. **Payroll-import notification — still forbidden.** `importApprovedExpensesToPayroll`
   must still NOT call any `notifyExpensesAddedToPayroll`-style alert.

**Why the reversal:** the owner wants visibility into every submission (not just risky
ones) funneled to Super Admin specifically, on the two "loud" channels (email + Telegram),
since auto-approve means nobody was otherwise told anything happened at all until the
once-a-day high-risk digest (which only covers flagged rows, not every submission).

**Implementation entry point:** all four submission paths (wizard `submitOutstationRequest`,
its `syncOfflineOutstationRequest` wrapper, `submitMedicalRepSimpleExpenseRequest`,
`createManagerExpenseAsAdmin`) call `approveOutstationRequestForPayroll` immediately after
insert — so hooking the new notification there (rather than in each of the four callers)
covers all of them from one place and is never fired again by `syncLinkedOutstationPayrollExpense`
(the admin-edit resync path, which does not call `approveOutstationRequestForPayroll`).

**Enforced by `tests/outstation-notifications.test.ts` ("RULE 1", wired in `tests/run-tests.ts`),
now asserting the OPPOSITE of the old rule:**
`notifyOutstationSubmitted` MUST exist; it must use `resolveActiveSuperAdminHrIds` (not
`direct_manager`); its `channels` must be `["email", "telegram"]`; `eventType` must be
`request_submitted`; none of the three submit hooks may call it directly (only
`approveOutstationRequestForPayroll` may); `approveOutstationRequestForPayroll` must call it
and must still never call `notifyOutstationDecision`. Reject-only and no-payroll-import-alert
assertions are unchanged from before.

**LANDMINE (from before, still true):** commit `fa79585c` (mislabeled "fix(ci): clean unused
variable warnings", carried on abandoned SoS branches e.g. `codex/weekly-sos-filters-tables`,
`codex/sos-territory-template-registry`) ADDED the forbidden `notifyExpensesAddedToPayroll`
call — still fails RULE 1's payroll-import assertion. Drop/fix it before landing those branches.

**Status as of 2026-07-13:** implemented in worktree `_wt-outstation-submit-notify`
(branch `codex/outstation-submit-notify`, created because a second Claude Code session was
reported active in the primary checkout — see [[parallel-session-swarm-hazard]]). Pending
validation (typecheck/tests) and commit/push/PR — not yet merged to main at time of writing;
re-verify against current code before relying on this as live-state fact.
