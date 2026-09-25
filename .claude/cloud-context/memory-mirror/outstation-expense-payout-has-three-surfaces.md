---
name: outstation-expense-payout-has-three-surfaces
description: "One outstation expense figure is paid through THREE independent surfaces — and the one that actually writes salary_records is a SQL RPC, not TypeScript. Fixing only the TS paths changes no money."
metadata: 
  node_type: memory
  type: project
  originSessionId: a2224779-e5db-46b9-962c-b3642028fdb4
  modified: 2026-08-01T23:26:14.556Z
---

**MERGED to main `f0db6600` (PR #1598, 2026-08-02).** Migration already applied to prod. Nothing
deploys on merge — production ships on the 2h cron, so verify against a revision, not the merge.

**Verified 2026-08-01 while adding `outstation_expenses.approved_amount`.** If you change what an
outstation expense is worth, you must change **three** places or the money and the reporting split:

1. `getApprovedExpenseTotalsForPayroll` — `src/lib/outstation/expenses.ts` (payroll template totals).
2. `loadPayoutExpenseTrips` / `recommendExpenses` — `src/lib/automated-payroll/recommend.ts`
   (the Automated Payroll wizard's recommended figure **and** its per-trip breakdown, which must
   foot to the total).
3. 🔴 **`public.phx_import_approved_expenses_to_payroll(p_month, p_year)` — a plpgsql RPC.** This is
   the one that actually `update`s `salary_records.expenses` / `second_part` / `month_salary`.
   Called from `expenses.ts` (~line 1071). **Its `sum(...)` is the real payout.** I fixed every
   TypeScript path first and the paid amount would not have moved by a piastre.

Also on the reporting side, still on the CLAIMED figure by design: `summarizePayrollExpenses`
(`totalAmount` / `pendingAmount`), `fn_get_admin_command_center_data`'s `approved_amount`
aggregate (migration `20260713120000`), Employee 360 expense analysis, and the Action Center
decision log.

**Rule that keeps them together:** `payableExpenseAmount(approvedAmount, total)` in
`src/lib/outstation/payable.ts` is the single TS rule; the RPC mirrors it as
`coalesce(approved_amount, total)`. NULL `approved_amount` = HR never adjusted the claim, so `total`
pays — which is why the column is backward-compatible with every historical row.

🔴 **"Fix the workload source" is a TRAP — the campaign cap must keep the double-visit source.**
`resolveOutstationWorkloadPayload` (`outstation/service.ts`, **4 call sites**: trip creation, mobile
wizard, admin manual create, update) read workload from the double-visit mirror, which cannot see a
rep's SOLO field days — so worked days recorded as "no activity". Measured on prod 2026-08-01: **6
of 8** expense requests falsely "no activity", hiding **69 real field visits**.

But do NOT swap the whole source. The campaign-visit cap (`decision.ts` rule 3 +
`campaignRuleRejection`) issues `rejected_by_system` on **campaign DOUBLE-visits** and on
`totalDvVisits <= 0`. The corrected CRM read counts every visit where the rep is agent OR partner,
including solo — so a wholesale swap breaks it BOTH ways: solo campaign visits inflate
`campaignVisits` into **spurious auto-rejections**, and solo visits satisfy `totalDvVisits > 0`,
**silently fail-opening a live rejection rule**. Fixed by splitting them in
`src/lib/outstation/workload-evidence.ts` (`mergeWorkloadEvidence`): workload/no-activity from the
CRM read, campaign/regular counts from the double-visit mirror. Test
`tests/outstation-workload-evidence.test.ts` pins both halves.

🔴 **Saving ONE approval rewrites the whole report, and silently canonicalizes two columns.**
`savePayrollExpenseApprovals` upserts the report's FULL record set (the UI sends every row, because
report totals recompute from what you send — a single-record POST corrupts the aggregate). The read
mapper runs `normalizeTransportation()` / `normalizeExpenseType()`, and the save writes those
normalized values back, so every save rewrites `transportation_type` (`car` → `Car`) and
`trip_type` (blank → `Unspecified`) for the entire report. Verified live 2026-08-01: report
`d5bb5270` (79 rows) shows the canonical forms, the never-saved report `55d6eb69` (248 rows) still
holds the raw lowercase/blank values. **Pre-existing, not caused by the approved_amount work** — but
it means a report's row hash always changes after any approval, so never use a whole-row hash as
your restore proof. Use money-level invariants (per-employee payout fingerprint, claimed totals,
approved counts) instead.

**Deploy ordering matters:** the write path sends `approved_amount` unconditionally, so the
migration must be applied BEFORE the code ships, or every approvals save fails with 42703. Related:
[[list-migrations-reports-ledger-not-reality]], [[app-visibility-is-application-scoped-not-rls]].
