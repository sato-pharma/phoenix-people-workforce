# Payroll Month-End Runbook

Reference for HR / Finance when closing a monthly payroll batch.

---

## Standard Batch Lifecycle

```
uploaded → part1_ready → part1_paid → adjustments_open → part2_ready → under_review → approved → locked
```

Only Finance Manager and Super Admin can advance the batch. Each transition is logged to `audit_logs`.

---

## Step-by-Step Closure

### 1. Upload payroll sheet
- Go to `/payroll` → Upload
- Resolve any `CRITICAL` salary flags before advancing the batch.
- A `negative_net` flag means an employee's net salary is ≤ 0 — fix the source file and re-upload.

### 2. Advance to Part 1 Ready → Part 1 Paid
- Part 1 Paid locks the batch against file replacement. From this point, corrections go through the Adjustments step.

### 3. Open Adjustments (required before deduction import)
- Advance the batch to `adjustments_open` **before** approving deductions in Deductions Governance.
- If the batch is still `part1_paid`, the Import Deductions button is disabled.

### 4. Reconcile excused exceptions before importing deductions

> **This step is mandatory until PR #221 (auto-suppress deductions on excuse approval) lands.**
> Approving an attendance exception does **not** automatically void the matching deduction candidate.
> A candidate with an approved excuse will still be charged unless you void it manually first.

Run this query against the production database before clicking **Import Deductions**:

```sql
SELECT
  dc.id          AS candidate_id,
  dc.hr_id,
  dc.amount,
  dc.day,
  ae.status      AS excuse_status,
  ae.exception_date
FROM deduction_candidates dc
JOIN attendance_exceptions ae
  ON ae.employee_hr_id = dc.hr_id
 AND date_trunc('day', ae.exception_date) = date_trunc('day', dc.day)
WHERE dc.month_key = '<YYYY-MM>'        -- replace with e.g. '2026-06'
  AND ae.status = 'approved';
-- Every row = an excused absence that will still charge the employee.
-- Void each returned candidate_id in Deductions Governance before importing.
```

### 5. Approve deductions in Deductions Governance
- Approve or override each candidate. Approved decisions populate `deduction_summary_lines`.

### 6. Import deductions to payroll
- In `/admin/deductions-governance`, click **Import Deductions** for the batch.
- The import is **idempotent per summary**: clicking a second time for the same summary is blocked at the DB level and will not double-charge employees.
- Verify `salary_records.finger_print` (and other columns) have updated.

### 7. Advance to Part 2 Ready → Under Review → Approved
- Run the pre-approval reconciliation SQL (Phase 2 in the audit plan) before approving:

```sql
-- A. Totals match SUM(records)
SELECT b.id, b.year, b.month, b.status,
       COUNT(*) records,
       ROUND(SUM(r.gross_salary)::numeric, 2)     sum_gross,
       ROUND(SUM(r.total_deductions)::numeric, 2) sum_ded,
       ROUND(SUM(r.net_salary)::numeric, 2)       sum_net
FROM salary_batches b
LEFT JOIN salary_records r ON r.batch_id = b.id
WHERE b.status IN ('under_review', 'approved', 'locked')
GROUP BY b.id ORDER BY b.year DESC, b.month DESC LIMIT 5;

-- B. Stored net = gross − total_deductions (expect 0 rows)
SELECT hr_id, gross_salary, total_deductions, net_salary,
       ROUND((gross_salary - total_deductions)::numeric, 2) AS computed_net
FROM salary_records
WHERE batch_id = '<batch_id>'
  AND ROUND(net_salary::numeric, 2)
   <> ROUND((gross_salary - total_deductions)::numeric, 2);

-- C. total_deductions = sum of component columns (expect 0 rows)
SELECT hr_id, total_deductions,
       (crm + finger_print + unpaid_vacations + medical_insurance + loans + other_deductions) AS sum_components
FROM salary_records
WHERE batch_id = '<batch_id>'
  AND ROUND(total_deductions::numeric, 2)
   <> ROUND((crm + finger_print + unpaid_vacations + medical_insurance + loans + other_deductions)::numeric, 2);
```

If B or C return any rows, do **not** approve. Investigate the divergence first.

### 8. Lock the batch
- Once approved, lock the batch. After lock, `salary_records` are immutable at the DB level (`phx_prevent_closed_salary_records_mutation` trigger).

### 9. Distribute payslips
- Payslips are only available for `approved` or `locked` batches.
- Recipients resolve to `employees.work_email` — synthetic `phx-*@auth.phoenix.local` addresses are filtered out automatically.

---

## Post-Correction Workflow

If a correction is needed after a batch is locked:
- **Do not** edit salary_records directly (blocked by DB trigger).
- Issue a **revised payslip** (new `salary_records` row in a correction batch, same period reference).
- Document the correction reason in the audit log summary.

---

## Quick Reference: Who Can Do What

| Action | Super Admin | Finance Manager | CEO | HR Specialist |
|--------|-------------|-----------------|-----|---------------|
| Upload / Replace | ✅ | ✅ | — | — |
| Delete (pre-Part1-paid) | ✅ | ✅ | — | — |
| Advance workflow | ✅ | ✅ | — | — |
| Approve deductions | ✅ | ✅ | — | — |
| Import deductions | ✅ | ✅ | — | — |
| View batch (read) | ✅ | ✅ | ✅ | ✅ |
| Lock | ✅ | — | — | — |
| View payslips center | ✅ | ✅ | ✅ | — |
