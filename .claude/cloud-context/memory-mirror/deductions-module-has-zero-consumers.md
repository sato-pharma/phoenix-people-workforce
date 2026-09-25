---
name: deductions-module-has-zero-consumers
description: "SUPERSEDED 2026-08-30, kept as the dated 08-01 record. The unified Deductions module IS now the live source feeding salary_records (via the 08-03 bridge src/lib/automated-payroll/deductions-source.ts); the legacy governance code was removed by C6 (PR #2733) and its DB tables archived off public into deductions_governance_backup_20260830 by C7 (PR #2746). See two-live-deduction-engines-p0 for the current state."
metadata: 
  node_type: memory
  type: project
  originSessionId: bd6c2994-f622-4563-b891-87464fa64cea
  modified: 2026-08-30T01:16:31.923Z
---

> **SUPERSEDED 2026-08-30 — kept as the dated 08-01 record.** Both headline claims below are now
> false. Since the 08-03 bridge (`src/lib/automated-payroll/deductions-source.ts`) the unified
> module **IS** the live source feeding `salary_records`, and "Phase 6 (retiring the legacy modules)
> never built" is done: **C6 (PR #2733)** removed the `src/lib/deductions-governance/` code and
> **C7 (PR #2746)** archived its DB tables/RPCs off `public` into schema
> `deductions_governance_backup_20260830` on both DBs. Path #2 below (the legacy governance handoff)
> no longer exists. See [[two-live-deduction-engines-p0]] for the current, resolved state.

**Owner asked on 2026-08-01 to confirm the Deductions module is the only source
of deductions and that Automated Payroll captures from it. It is not, and it
does not.** Verified against `main` at `a58c9c5f` (the merged restore):

- **Zero consumers.** Nothing outside `src/lib/deductions/` references
  `deductions_candidates`, `deductions_publications`, or
  `deductions_publication_lines`.
- **No link to payroll at all.** `git grep "lib/deductions/"` across
  `src/lib/automated-payroll` and `src/lib/payroll` returns nothing.
- The module's own sidebar entry says *"Phase 1 preview — feeds nothing live
  yet."*

**Three independent paths still write the salary_records deduction columns**
(`finger_print`, `crm`, `unpaid_vacations`, `loans`, `other_deductions`):

1. `src/lib/automated-payroll/recommend.ts` — its own engine, reading CRM visits
   directly via `scanVisitsForRangeIncludingDeparted`. Ten Part-1 steps:
   `p1_fingerprint`, `p1_crm`, `p1_no_record`, `p1_unpaid_vacation`,
   `p1_other_deductions`, `p1_resignation_crm`, `p1_resignations`, `p1_holds`,
   `p1_new_hires`, `p1_special_situations`.
2. `src/lib/deductions-governance/payroll-handoff.ts` — the LEGACY module's
   still-live import (`previewDeductionsPayrollImport`,
   `confirmDeductionsPayrollImport`).
3. `src/lib/payroll/salary-import.ts` + `src/lib/payroll/service.ts`.

**Why:** #1334 built Phases 1–4 only (candidate ledger, publish snapshot,
read-only reconciliation, portal dual-read). **Phase 5 (Automated Payroll
cutover) and Phase 6 (retiring the legacy modules) were never built** — see
[[deductions-module-god-mode]]. Restoring the module on 2026-08-01 did not
change that; it restored exactly what existed.

**How to apply:** production now holds a fully-built, RLS-correct deductions
ledger that nothing consumes — inert, not harmful. Do NOT tell the owner this is
the source of truth. Making it so is Phase 5, and it is the highest-risk piece
of the whole plan because it redirects what actually pays people; it needs its
own explicit scope confirmation first (the owner's own standing instruction, and
PR-2's original reconciliation design was already invalidated once — compare
against the CONFIRMED paid amount, not an independently recomputed "expected"
one, because Automated Payroll only *recommends* and a Super Admin confirms).
