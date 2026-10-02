---
name: outstation-expense-notifications-reject-only
description: "Outstation notification design: a clean submission WAITS for a human (no auto-approve since PR #1916, 2026-08-08). ONE submit email fires from the submit paths — To employee, Cc manager (skip-level if the CEO), Bcc active Super Admins. Approval is silent; a rejection notifies the employee in-app+Telegram+push, NEVER email. High-risk digest REMOVED; payroll-import alert forbidden"
metadata: 
  node_type: memory
  type: project
  originSessionId: ad0de976-b05e-4e1d-8b5d-e079c07cc47f
  modified: 2026-10-02T16:37:11.435Z
---

Outstation & payroll-expense submissions **no longer auto-approve**: since PR #1916 (2026-08-08) a
clean submission persists as `submitted` and WAITS for an explicit human decision in the queue —
nothing is pushed to payroll and nothing is refused from the submit path. See
[[outstation-submit-used-to-auto-approve-into-payroll]].
**Superseded 2026-10-02:** previously "submissions still AUTO-APPROVE straight to payroll staging
(`submitOutstationRequest` → `approveOutstationRequestForPayroll`), no human pending-approval step" —
PR #1916 (2026-08-08, owner decisions 2026-08-08/09).

The notification policy below was first set on 2026-07-13 by explicit owner instruction and has
moved since:

**Notification state (built 2026-07-13, updated since):**
1. **Submit notification** — `notifyOutstationSubmitted` fires once per fresh submission **from the
   submit paths themselves, not from approval**. It is ONE message: **To the employee himself, Cc his
   direct manager (the skip-level manager when the direct manager is missing or the CEO), Bcc every
   active Super Admin** — envelope from `resolveOutstationSubmitRouting`
   (`src/lib/outstation/submit-recipients.ts`). Channels: **in-app + email + Telegram + push**;
   `eventType` `request_submitted`. Body contains the full request detail (employee, role,
   line/area, transport, trip dates, distance, fuel/ticket/allowance/meeting/other amounts,
   expected vs. claimed + variance, eligibility, approval recommendation, suspicious-location
   score, fraud flags, territory validation, GPS capture, notes). The Super Admin Bcc is what tells
   the approver the queue has something in it. From the approve path it fires ONLY when a Super
   Admin overrides a system rejection.
   **Superseded 2026-10-02:** previously "fires from inside `approveOutstationRequestForPayroll`,
   to every active Super Admin ONLY (not the manager), email + Telegram only, an informational feed
   with nothing to approve" — PR #1916 moved it to the submit paths and the 2026-08-08 routing put
   the employee on To and the manager on Cc.
2. **Reject notification** — `notifyOutstationDecision` fires only on a manual rejection, to the
   submitting employee, on **in-app, Telegram and push — NEVER email** (owner rule 2026-09-19;
   `src/lib/notifications/outstation-rejection-channel-guard.ts` strips email even on the
   Telegram-failure fallback). Approval is silent.
   **Superseded 2026-10-02:** previously "`notifyOutstationDecision` is still the ONLY email the
   submitting employee ever receives" — the submit email goes To him since 2026-08-08, and the
   rejection notice was taken off email by the owner on 2026-09-19.
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

**Why the 2026-07-13 reversal:** the owner wanted visibility into every submission (not just risky
ones) funneled to Super Admin specifically, on the "loud" channels, since auto-approve (as it was
then) meant nobody was otherwise told anything happened at all until the once-a-day high-risk digest
(which only covered flagged rows, not every submission).

**Implementation entry point:** each submission path calls `notifyOutstationSubmitted` itself after
the insert (the employee wizard / offline sync, `submitMedicalRepSimpleExpenseRequest`, and
`createManagerExpenseAsAdmin` — in `src/lib/outstation/service.ts`), passing `heldForReview` /
`reviewReason`; `approveOutstationRequestForPayroll` calls it only on a rejection override. The
admin-edit resync path (`syncLinkedOutstationPayrollExpense`) never fires it.
**Superseded 2026-10-02:** previously "all four paths call `approveOutstationRequestForPayroll`
immediately after insert, so the hook lives there" — PR #1916 removed that auto-approve and moved
the mail to the submit paths.

**Enforced by `tests/outstation-notifications.test.ts` ("RULE 1", wired in `tests/run-tests.ts`):**
`notifyOutstationSubmitted` MUST exist; it must build its envelope with
`resolveOutstationSubmitRouting(request.employeeHrId)`, send To `routing.toHrId` with the manager on
Cc and Super Admins on Bcc of ONE message; its `channels` must be
`["in_app", "email", "telegram", "push"]`; `eventType` must be `request_submitted`;
`approveOutstationRequestForPayroll` may call it ONLY when overriding a system rejection and must
never call `notifyOutstationDecision`; the decision function is reject-only (`request_rejected`, to
the submitting employee, never email). The no-payroll-import-alert assertion is unchanged.
**Superseded 2026-10-02:** previously "Super-Admin-only, `["email", "telegram"]`, only
`approveOutstationRequestForPayroll` may call it" — the test was rewritten with the 2026-08-08 and
2026-09-19 changes.

**LANDMINE (from before, still true):** commit `fa79585c` (mislabeled "fix(ci): clean unused
variable warnings", carried on abandoned SoS branches e.g. `codex/weekly-sos-filters-tables`,
`codex/sos-territory-template-registry`) ADDED the forbidden `notifyExpensesAddedToPayroll`
call — still fails RULE 1's payroll-import assertion. Drop/fix it before landing those branches.

**Status as of 2026-07-13:** implemented in worktree `_wt-outstation-submit-notify`
(branch `codex/outstation-submit-notify`, created because a second Claude Code session was
reported active in the primary checkout — see [[parallel-session-swarm-hazard]]). Since merged and
reworked as above; re-verify against current code before relying on this as live-state fact.
