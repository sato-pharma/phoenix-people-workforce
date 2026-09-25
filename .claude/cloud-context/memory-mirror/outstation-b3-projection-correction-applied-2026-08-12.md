---
name: outstation-b3-projection-correction-applied-2026-08-12
description: "21 outstation ledger rows were cleared to pending in production on 2026-08-12 by owner ruling — don't redo or undo it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9fa05b22-8835-4510-bdef-6bdf43711c24
  modified: 2026-08-12T05:47:51.339Z
---

**Applied to PRODUCTION 2026-08-12, owner-authorised. Do not redo, do not revert.**

On 2026-08-08 22:41:15.420963 Cairo someone bulk-reverted 21 `outstation_expense_requests` to
`submitted` by direct SQL (no audit row). Their `OUTSTATION-*` rows in `outstation_expenses` were left
saying `status='Approved'`, `hr_status='Approved'` while `hr_approved=false`.

Owner ruled 2026-08-12: **the revert was deliberate — treat all 21 as pending.** The projection was
then corrected (`status=''`, `hr_status=''`) on trips `OUTSTATION-38, 39, 41, 43, 45, 46, 48, 50–63`.
Pre-image of all 21 rows (EGP 13,435.44) is in
`phoenix_backup.outstation_expenses_20260812_b3_preimage` — private schema, anon has no access.

**How to apply:**
- Verified after: B3 conflicts 0 · total rows still 360 · imported-to-payroll still 0 · approved still
  82 · rejected still 16 · undecided 241 → 262.
- **The correction did NOT stop these trips being recommended for payment.**
  `payoutExpenseRowIsPayable` excludes only `rejected`; `pending` is included by design ("the wizard IS
  the approval point"). They are still in the Automated Payroll recommendation at **EGP 6,052.17 for
  the 2026-08 payout and 7,383.27 for 2026-09**. What the fix changed is the wizard's per-trip
  indicator: it now correctly reads "Not yet approved" instead of "Approved".
- **Owner DEFERRED deciding the 21 trips (2026-08-12) — deliberate, not an oversight. Do not chase
  him for it every session.** They stay pending until he says otherwise. The live deadline is the
  August batch assembly (≈2026-09-10): if still undecided then, the wizard pre-fills EGP 6,052.17
  across 4 employees and the only guard is the per-trip indicator now reading "Not yet approved".
  July proved the operator types whatever is pre-filled (all 22 rows `source='inline'`).
- Separately, `TRP-00285` (B-117, 455 EGP) has `status='Rejected'` with `approved_at`/`approved_by`
  still set — a pre-existing invariant violation, deliberately left untouched.

Full write-up: `OUTSTATION_EXPENSES_AUDIT.md` §13 (search "APPLIED 2026-08-12").
See also [[outstation-payroll-import-is-locked-out-by-batch-status]].
