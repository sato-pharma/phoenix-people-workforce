---
name: deleting-an-employee-needs-a-full-text-scan
description: "An FK-based blast-radius check before deleting an employee MISSES the payroll tables — they reference employees.hr_id by plain text with no foreign key."
metadata: 
  node_type: memory
  type: project
  originSessionId: 81bc36d9-e479-4bda-923a-cfe0f57f57c9
  modified: 2026-08-05T17:41:54.813Z
---

Before deleting (or repointing) an `employees` row, enumerating `pg_constraint` foreign keys is
NOT enough. Several important tables reference `employees.hr_id` by a **plain text column with no
FK at all**, so they are invisible to that check:

- `salary_records.hr_id` — historical payslips
- `automated_payroll_draft_rows.employee_hr_id` — open payroll runs

On 2026-08-05 a duplicate employee (B-165) was deleted after an FK inventory reported it held
nothing. It actually held a locked March payslip and a draft row in the still-open July run, both
of which became orphans.

**Instead, scan every text column in the schema for the literal HR_ID.** A DO block over
`information_schema.columns` (data_type in text/varchar, BASE TABLE only) running
`select count(*) from %I where %I = 'THE-ID'` finds them all. The same method later found
`B-HIST-MG` holding 7 marketing requests worth EGP 23,350 when a payslip check had suggested it
was empty — and found a misspelling hiding inside `auth.users.raw_user_meta_data`, which no join
can reach.

Two guards that DO work and should be trusted:
- `phx_prevent_closed_salary_detail_mutation()` refuses any edit to a `locked` salary batch.
- `marketing_requests_requester_hr_id_fkey` is NO ACTION, so it blocks a delete rather than
  cascading.

Related: [[marketing-approver-hrid-casing-fk]] — the other HR_ID trap, where a lower-cased write
dies on the FK while fuzzy reads make the check pass.
