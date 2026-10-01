---
name: outstation-expenses-two-data-models
description: "Outstation is two systems fused — approving a request manufactures a fake spreadsheet upload, so 95% of 'Historical Uploads' are synthetic one-row artefacts."
metadata: 
  node_type: memory
  type: project
  originSessionId: 24788870-9156-47da-a9f7-edb4bdd743dc
  modified: 2026-10-01T00:00:00.000Z
---

**Approving an outstation request writes a FAKE Excel upload.** There is no ledger writer other
than `savePayrollExpenseApprovals`, which mints an `outstation_expense_reports` row whenever
`reportId` is null. So `pushAcceptedOutstationExpenseToPayroll` creates a report literally named
`outstation-request-<id>.workflow` holding exactly one row.

Measured in production 2026-08-12: **36 of 38 reports are `.workflow` artefacts (94.7%)**. Only
`Jan - June Expenses.xlsx` and `jUNE EXPENSES CRM.xlsx` are real files.

The two tables are joined by the STRING `'OUTSTATION-' || requests.id` — **no foreign key** — so:
- **9 ledger rows (EGP 4,272.35, all `hr_approved=true`) outlive deleted requests 18–22, 28–31**,
  with no delete audit row. The app's own delete path removes the ledger row first, so those
  deletions were direct SQL.
- **3 reports hold zero rows** and 3 requests have duplicate reports (18, 21, 22).
- The request table has **no `approved_amount` column** — HR's cut lives only on the ledger row, so
  an adjustment made while the evidence gate holds a trip is silently discarded.

**How to apply:**
- Never read the "Historical Upload" list as a list of uploads — filter `file_name not like '%.workflow'`.
- Report counters are decorative: **no trigger exists on any outstation table**. 25 of 38 reports
  have a wrong `approved_rows`; `Jan - June Expenses.xlsx` says 277 rows / EGP 100,077 and holds
  248 / 87,264. `updated_at` is app-clock written before the insert — 37 of 38 reports are
  "updated" before they were created.
- `audit_logs` covers `outstation_request` (116 rows) and **`outstation_expenses` NOT AT ALL** (0),
  so every HR approval and amount cut on the ledger is unattributable.
- Only **Super Admin** holds `outstation:approve` (`admin-access.ts` → `adminOutstationRoles`).
  There is no manager approval step anywhere; a DM only gets a Cc email.
- 🔒 **OWNER RULING 2026-08-12: it STAYS that way — "no manager approval, keep super admin only".**
  Do not propose a DM/RM approval rung again, and do not build an approval-chain table
  (`expense_claim_approvals` / `step_order`) "in case". The redesign drops it entirely.
  **Consequence to design around, not argue with:** one approver is the throughput ceiling —
  27 of 39 live claims sat in `submitted` on the day of the ruling — so the answer is bulk decisions
  and triage-by-exception on ONE queue page, never delegation.

- 🔒 **OWNER DEFERRED 2026-08-12 — "I WILL DECIDE LATER MY SIDE".** Two ledger rows contradict
  themselves: `OUTSTATION-31` total 240 vs allowance 300, and `OUTSTATION-52` total 364 vs
  allowance 800. **Do not chase him for it, do not "fix" either row, do not pick a figure.** The
  redesign already routes around it — `claimed_total` stays a plain column until phase 6, both rows
  migrate intact with a `data_quality_hold` flag, and the original components go into the event log.
  Same treatment as the 21 deferred rows: his call, on his timeline.

Full evidence: `OUTSTATION_EXPENSES_AUDIT.md` §14 and §24 ·
target design in `OUTSTATION_EXPENSES_TARGET_ARCHITECTURE.md` §9 and §13.
See also [[outstation-payroll-import-is-locked-out-by-batch-status]] ·
[[outstation-b3-projection-correction-applied-2026-08-12]]

## 2026-08-23 — the 95% still holds, but "approving FAKES an upload" is being deleted, not maintained.

Re-read against current `main`. Two halves of this file now age differently:

**Still exactly right:** `outstation_expense_reports` holds 38 rows of which **36 are synthetic
`.workflow` artefacts** and only **2 are real uploads** (`src/lib/outstation/expenses.ts`). The
94.7% figure this file records is confirmed, and it is why any report-scoped read looks plausible and
returns the wrong set.

**No longer true going forward:** the new model does not manufacture a report per approval —
"that fiction is exactly what phase 3 deletes", so a claim carries `reportId: null` and imports keep
theirs on `import_id` (`src/lib/outstation/claims-read.ts:129`). The legacy read path still carries
`reportId` **on purpose**, to avoid serving a divergent set mid-cutover.

**How to apply.** Say which path you mean. New-model writes create no synthetic report; the legacy
read path deliberately still resolves them; and the 36 historical artefacts are not going anywhere,
so a report-scoped query keeps being a trap even after phase 3 lands.
