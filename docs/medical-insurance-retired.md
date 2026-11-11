# The Medical Insurance module — retired 2026-11-11

**What it was.** A module built on 2026-11-04 for Sato Pharma's MetLife group medical policy: who should be on the
policy, the additions-and-deletions file for the insurer, what a period should cost at the rate card, and each
invoice compared against that plan. It lived at `/medical-insurance` (and `/hr/medical-insurance` for the HR
Operations seats) and sent nothing and paid nothing.

**Why it was retired.** Sato Pharma cancelled the MetLife contract and is renewing with Libano-Suisse. The owner
chose to retire the module completely, and for its data: "Export, then drop".

## What was removed (one pull request)

- The code: `src/lib/medical-insurance/`, `src/components/medical-insurance/`, `app/(admin)/medical-insurance/`,
  `app/api/medical-insurance/` (15 routes) and `tests/medical-insurance.test.ts`.
- Every registration: the two sidebar links and the People Management hub entry, the `medical_insurance` and
  `medical_insurance_invoices` permission resources, the `medical_insurance_members` HR function and its place in
  the HR Operations and HR Administration bundles, the 17 access-registry routes, the seat-view rule, the module
  catalogue, activity and system-audit page maps, the HR command-centre keys, the proxy body-size exclusions and the
  build's file-tracing entry for the insurer's template.
- The module memory file `.claude/rules/medical-insurance.md` and its entry in `scripts/module-memory/modules.mjs`.
- The insurer's blank EDI template `assets/medical-insurance/metlife-edi-template.xlsx`, copied to
  `F:\Claude Scratchpad Archive\medical-insurance\` before it left the repo (spreadsheets are never deleted).
- The database: migration `20261111061213_retire_medical_insurance.sql` dropped the seven `medical_insurance_*`
  tables and the storage policy `medical_insurance_service_role` on staging and production; the private
  `medical-insurance` storage bucket was deleted on both through the Storage API. The two 2026-11-04 migrations stay
  in the history.

## What was kept

- **The payroll medical insurance deduction** — `employees.medical_insurance`, `employee_compensation.medical_insurance`,
  `salary_records.medical_insurance`, `employees.medical_insurance_status` / `_number` / `_card_received_date`, and
  their use in payroll, the employee portal and the imports. That is an older, separate feature and was not touched.
- **The six audit entity keys** (`medical_insurance_member`, `_exception`, `_invoice`, `_document`, `_export`,
  `_category_choice`) in `src/lib/admin/audit.ts` and `src/lib/admin/audit-entity-types.ts`, so audit rows the module
  wrote before it was retired still render. Nothing writes them any more.

## Where the data went

Exported from production on 2026-11-11 about 06:11 Cairo, before the drop, to the owner's machine (outside the
repo — it holds names and national IDs):

`C:\Users\satoh\OneDrive\Desktop\Folders\Medical Insurance\MetLife module export 2026-11-11\tables.xlsx`

One sheet per table plus a summary. Row counts, read back from the file and equal to the database:

| Table | Rows |
| --- | --- |
| `medical_insurance_policies` | 1 |
| `medical_insurance_members` | 114 |
| `medical_insurance_exceptions` | 0 |
| `medical_insurance_invoices` | 0 |
| `medical_insurance_invoice_lines` | 0 |
| `medical_insurance_documents` | 0 |
| `medical_insurance_category_choices` | 0 |

The storage bucket held **0 files** on production and on staging, so there was nothing to download.

Production has no point-in-time restore. The workbook above is the only copy of those rows; re-running the two
2026-11-04 migrations would recreate empty tables, not the data.
