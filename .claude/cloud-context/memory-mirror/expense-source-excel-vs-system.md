---
name: expense-source-excel-vs-system
description: "How to tell Excel-uploaded expenses from system-entered ones, and the 2026-06-13 prod purge of historical Excel expenses"
metadata: 
  node_type: memory
  type: project
  originSessionId: 50c9ffda-c81f-455f-814f-8b17108e9f9d
---

Employee/outstation **expenses come from two layers**, joined by `getMedicalRepPortalData` → `data.workload.expenseRows` (dashboard at `/employee-portals/expense-dashboard`, component `personal-expense-workload-dashboard.tsx`):

- **Excel-uploaded (historical):** rows in `payroll_expenses` + a header in `payroll_expense_reports` (file_name = the uploaded `.xlsx`). Only writer is `savePayrollExpenseApprovals` (src/lib/payroll/expenses.ts).
- **System-entered:** rows in `outstation_expense_requests` (the in-app wizard). When approved they are ALSO mirrored into `payroll_expenses` — those mirror rows have `trip_id` prefixed **`OUTSTATION-<id>`** and a report file_name like **`outstation-request-NN.workflow`**.

**Reliable discriminator inside `payroll_expenses`:** `trip_id ILIKE 'OUTSTATION-%'` = system-entered (keep); everything else = Excel upload. The dashboard dedups OUTSTATION- historical rows in favour of the live outstation request.

**2026-06-13 purge (done, prod ref ozucdzovmcqvepbozvqf):** user wanted all Excel-uploaded historical expenses gone, system-entered kept. There was exactly ONE Excel report — `"Expense historical upload.xlsx"` (id `6b610cc1-9b24-43af-bde5-4b09bedb5f40`, 273 rows, EGP 99,647, none locked into payroll). Backed up to `outputs/expense-excel-backup-20260613/` (`excel-expenses-backup.json` + `restore.sql`), then deleted those 273 rows + the report header. Verified: 0 Excel rows remain, 5 OUTSTATION- mirror rows + 14 outstation_expense_requests untouched.

**How to apply:** to purge future Excel uploads, target by `report_id` (one report per upload) or `trip_id NOT ILIKE 'OUTSTATION-%'`; always back up first; never touch `outstation_expense_requests`. See [[premium-design-language]] — same session squared the dashboard + swapped CSV export for a styled XLSX via `buildPhoenixTableWorkbook`.
