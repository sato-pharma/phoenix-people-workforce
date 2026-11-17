# The Medical Insurance module — retired 2026-11-11, rebuilt for Libano-Suisse 2026-11-17

## Rebuilt for Libano-Suisse (2026-11-17)

The owner asked on 2026-11-17 to "build the Libano-Suisse medical insurance module", from three papers: the signed and
stamped table of benefits, the renewal offer Rev 1.3 of 5 November 2026, and the insurer's member draft (Initial
Draft1.xlsx). The policy runs from **15 November 2026 to 14 November 2027** (his pick). The retired module was put
back on the same pages and tables and changed where the contract differs:

- **Cost** is the offer's annual premium per person, by plan (A, B, C) and five-year age band, plus 1.55% tax, EGP 30
  a card per member and EGP 90 issue fee, priced from the age on the day cover starts. The seeded card reproduces the
  offer's EGP 712,300 for 104 people. A joiner pays by the day to the policy's end (25% of the year from the last
  quarter); a leaver is refunded by the day. The rates are editable on the Cost tab, and so is the policy number,
  which Libano-Suisse has not issued yet.
- **The member file** is Libano-Suisse's own "Output draft" sheet with its 39 headings, built for the people ticked
  on the add/remove screen, or for everyone covered. It replaces the MetLife EDI workbook; nothing sends it.
- **Bills** are recorded by hand (number, kind, dates, total, the file beside it) and compared with the plan; the
  MetLife PDF reader is gone, since Libano-Suisse's layout is not known.
- **Age limits**: anyone over 64, and a child over 18, is listed for review.
- The register is seeded once on production from the insurer's draft (140 people), matched to employees by national
  ID; names and IDs never enter the repo.

Migration: `supabase/migrations/20261117041500_medical_insurance_libano_suisse.sql` (six tables, the private bucket
and the Libano-Suisse policy row). Rules: `.claude/rules/medical-insurance.md`.

## The MetLife module and its retirement (2026-11-11)

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
