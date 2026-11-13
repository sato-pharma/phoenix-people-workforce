# Employee keys — every money, leave and attendance row names a real employee

Since 2026-11-13 every money, leave and attendance table carries a validated foreign key from its
employee column to `public.employees(hr_id)` (REC-037, F-DB-001). A validated key makes a row that
names nobody impossible, so it never shows as a blank or a raw id in a payslip, a leave balance or
an attendance report.

The migrations that added them: `20261113160008`, `20261113160747` (slices 1 and 2) and
`20261113161558` (`medical_trip_hr_id` on outstation expenses). Each one was applied only after an
orphan count of zero. They are pinned by `tests/employee-key-foreign-keys.test.ts`. Every key is
named `<table>_phx_employee_fkey`, with ON UPDATE CASCADE and ON DELETE RESTRICT.

Two cases needed more than a key:

- **The 13 leavers known only from the January to March 2026 salary files** had no employee row, so
  their salary rows would have been orphans. They were restored as `historical_payroll_record`. That
  was the owner's choice, and they were never marked `resigned`: no invented dates and no vacancy.
- **`medical_trip_hr_id` on outstation expenses.** The seat model gives the expense forms lower-case
  ids. Trigger `phx_outstation_medical_trip_hr_id_canonical` stores the employee's own case. When an
  id names nobody, the trigger clears it but keeps the name, so an expense is never refused because
  of it.

## The count only rises

A repository test sees migration files, not the database. A key dropped by hand, or put back
`NOT VALID`, would be invisible to it, and most of this schema has changed by hand. So the
database is asked directly, every night:

| Piece | What it does |
| --- | --- |
| `public.phx_ci_employee_keys()` (`20261113171643`) | Lists every single-column foreign key to `employees(hr_id)`: table, column, constraint, validated. Read-only, `SECURITY DEFINER`, executable by `service_role` only. |
| `scripts/employee-key-baseline.json` | The keys that must exist, as `schema.table.column`, sorted. |
| `scripts/check-schema-shape.ts` | Run by the nightly Migration Drift Check on staging and production. A baseline key missing live → error `employee_key_dropped`. A key that is `NOT VALID` → error `employee_key_not_validated`. A live key that is not in the baseline → warning `employee_key_baseline_behind`. A target without the function skips the check and logs a line. |
| `tests/schema-shape-employee-keys.test.ts` | In the required CI. The baseline holds at least `MIN_EMPLOYEE_KEYS` keys, includes every money, leave and attendance key, and the gate fires on each case above. |

Measured 2026-11-13: 112 keys on production, all validated, on 78 tables. Staging was the same, with
the same fingerprint as the committed baseline.

## Adding a key

1. Count the orphans, and repair them first. The count must be zero.
2. Add the key `NOT VALID`, then `VALIDATE CONSTRAINT`, in one migration.
3. Add the key to `scripts/employee-key-baseline.json`, and raise `MIN_EMPLOYEE_KEYS` in the same PR.

Until step 3 merges, the night only warns. It never goes red between the migration being applied
and its PR merging.

## Removing a key

Removing a key is a decision the owner is told about first. Take it out of the baseline and lower
`MIN_EMPLOYEE_KEYS` in the same PR that drops it. Otherwise the night goes red on both staging and
production.

Actor columns (`decided_by`, `created_by` and the like) are left unkeyed on purpose. They hold
`system` and old lower-case ids by design.
