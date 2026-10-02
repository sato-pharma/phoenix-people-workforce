---
name: payroll-copilot-design
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: Owner replaced the joiner proration rule (2026-08-29): a mid-month hire is now paid Net (Base + ECOL + Fuel) / calendar days x days worked, replacing the day-15 full/half rule (see `a-payroll-rule-change-does-not-reach-an-already-open-run`). Older text follows: The AI Payroll Copilot — assembles a payroll sheet from modules, negotiates flags in chat, feeds the existing batch→approve→lock→payslip machinery. BUILT AND LIVE for CEO+Super Admin (Phases 1-4 shipped 2026-07-07). Read before touching copilot work — holds the owner-confirmed statutory model (Base/Net are IMMUTABLE, tax on Base, Gross is the only value that moves), the universal proration rule, the resignation/joiner rules, and the reusable feeder/deduction wiring."
metadata: 
  node_type: memory
  type: project
  originSessionId: c77ebbe0-6291-4495-b1a7-b13d99435d69
  modified: 2026-09-26T02:59:09.318Z
---

The AI **Payroll Copilot** (negotiated 2026-07-06, design LOCKED; Phases 1-4 built and LIVE on production for
**CEO + Super Admin only**). Existing payroll was *validate-an-uploaded-Excel*; Copilot *builds* the sheet
from modules instead, then feeds the SAME `salary_batches`→approval→lock→payslip machinery.

**Agreed behaviour:** CEO says "Start [month] payroll" → seed every eligible employee from
`employee_compensation` + `allowance-policy.ts` + already-approved feeders → anyone **100% green is auto-filled
silently**; **not-green → a chat ask-queue**. Eight flag rules: pending/unapproved · joiner/leaver ·
attendance conflict · salary/role change · unpaid leave · off-system one-off · big-swing-vs-last-month ·
missing data. Off-system items (bonus/penalty/loan/advance) typed in chat; recurring items remembered +
counted down. Draft is a PURE function of live data + stored adjustments (re-assembled each call), **editable
until Lock**. Outputs: master xlsx + bank file + payslips + statutory summary. 🔴 **LLM parses/explains only —
ALL money math is deterministic.** Locked decision: statutory is a **NEW sibling module, NEVER touch the
locked `policy.ts`** ([[incentive-policy-lock]]) — call `resolveFixedSalaryAmounts`/`calculatePayrollParts`
only.

## 🔴 The statutory model (owner-confirmed — a real payroll bug was fixed to reach it)

**Base and Net are ALWAYS carried UNCHANGED from the employee master — statutory math never touches them.**
"base basic and net cannot be changed from stored database ever" — because `basicSalary = Base × 70%` feeds
the LOCKED incentive scheme, so any drift there is dangerous. The corrected model:

- **Tax is computed on BASE, not Gross** — annual taxable = `Base×12 − exemption`. Achieved WITHOUT changing
  the calculator signature by feeding `monthlyGross = baseSalary + SI.employee` into
  `computeIncomeTax(monthlyGross, monthlyEmployeeSI, config)`, so it cancels to `Base×12`.
- **Gross is the ONLY value allowed to move:** `Gross = Base + newSI + newTax` (forward calc, matches
  `calculateGrossSalary`). Gross feeds statutory-summary / bank reporting only — **never `calculatePayrollParts`
  or the actual bank payout, which anchor on `netSalary`.**
- The earlier bug (Gross treated as the fixed anchor, `baseSalary = gross − SI − tax`) was backwards and
  produced ~100 false-positive `salary_role_change` flags — an artifact, not real base changes.

**Social insurance:** `employees.social_insurance` is the LEGACY SI DEDUCTION (~27.47% of basic, likely
bundles the employer share) — **NOT a subject wage; never reverse it via `/0.11`** (degenerate, nearly all
hit the cap). The subject wage is the separate `employees.social_insurance_wage` column =
`clamp(basic_salary, 2700, 16700)`, populated for SI-enrolled employees (`social_insurance_status='yes'`);
non-enrolled + no-basic stay NULL and fall back to carried values. Payroll reads the **wage**, never the
status. The new computed SI (11% × capped basic) is ≈ HALF the legacy figure — INTENTIONAL, the correct 2026
rate. **2026 params (owner-approved, 2-source):** income-tax brackets 0/10/15/20/22.5/25/27.5%, personal
exemption EGP 20,000/yr (Law 7/2024); SI employee 11% / employer 18.75%, monthly caps 2,700–16,700 (Law
148/2019). The statutory engine is guarded/inert — falls back to carried values until the config migration is
applied AND the per-employee wage is populated. **DEFERRED:** high-earner tax phase-out (>600k/yr).

## 🔴 Proration, resignation and joiner rules (owner-confirmed, apply to ALL scenarios)

- **Universal proration:** daily rate = **Base Salary ÷ actual calendar days in month** (real 28–31, NEVER a
  flat 30). **ECOL and Fuel are "extras" — NEVER part of the daily rate, ever.**
- **Unpaid leave (continuing employee):** deduction = `(Base ÷ days-in-month) × unpaid days`; only Base-derived
  pay is reduced, ECOL/Fuel always paid in full.
- **Resignation Rule 1 — two branches by last-working-date vs day 25:**
  - last working day **≤ 25th**: `total = (Base ÷ calendar-days) × daysWorked, then ± deductions/additions`.
    **NO ECOL, NO Fuel at all** (literally excluded, not prorated to zero).
  - last working day **> 25th**: `total = Base FULL (unprorated) + ECOL full + Fuel full ± deductions/additions`
    ("no prorate and +additions −deductions"). Matches the Ready-sheet >25th full-pay waiver for genuine
    resignations.
  - `daysWorked` = simple calendar-day count from the 1st to the last-working-date, **then subtract** any
    unpaid-leave days inside that span.
- **Resignation Rule 2 (Part1/Part2 clawback) — TWO-PART payment-mode employees ONLY** (one-part employees
  just get the Rule-1 total paid once): fixed Part1 = Basic Salary (Base×70%). If Rule-1 total ≥ Basic →
  Part1=Basic, Part2=total−Basic; if total < Basic → Part1=total, Part2=0. The existing
  `calculatePayrollParts` two_parts branch (`firstPart = min(basicSalary, totalPayable − forcedSecondPart)`)
  likely implements this for free if fed the correct Rule-1 total as `netSalary` with `forcedSecondPart=0`.
- **Joiner (new hire mid-month) — a day-15 threshold with a HALF option** (different shape from resignation's
  zero): hired **≤ day 15 → ECOL+Fuel in FULL**; hired **> day 15 → ECOL+Fuel at HALF** (÷2). Base still
  follows the universal day-rate proration.
- **Medical insurance:** `employees.medical_insurance` (numeric, from `employee_compensation`, exposed as
  `EmployeeDirectoryRow.medicalInsurance`) is a FIXED monthly deduction that **ALWAYS applies** (no
  flagging/asking).

## Reusable codebase facts (feeders, deductions, the three review tabs)

- **Feeder columns:** unpaid leave = `v2_vacation_requests.payment_status='unpaid'`; attendance =
  `deduction_candidates` (`employee_hr_id_compact`/`superseded_at`); leaver =
  `employee_resignations.last_working_date`/`exit_status`.
- **The fingerprint payroll cycle is day-24→24** (`src/lib/attendance/digest-cycle.ts` `resolveDigestCycle`,
  anchor configurable via `getDigestSettings()`) and can **span two calendar months** — but
  `deduction_candidates.month_key` is stamped by the CALENDAR month of the work date, so the review must query
  BOTH month_keys the cycle touches and filter on each candidate's own `dates` jsonb.
- **`payrollColumnForDeduction` mapping:** `FIELD_WORKFORCE→crm`, `ATTENDANCE_DEVICE→finger_print`,
  `VACATION`/unpaid_leave/leave_without_balance→`unpaid_vacations`.
- 🔴 **The OLD `phx_import_deductions_governance_to_payroll` RPC is INCOMPATIBLE with Copilot's
  in-memory-then-materialize flow** — it requires an already-EXISTING `salary_batches` row. Copilot bypasses it
  and reads `deduction_decisions` directly. Copilot's deduction decisions deliberately bypass the
  Super-Admin-only `assertDeductionsGovernanceDecisionActor` gate (the Copilot route already asserts
  CEO/Super Admin) and stamp `decided_by='copilot:<actor>'`.
- **CRM review tab** = an "N" (no-activity) day report; reuses Field Workforce Compliance
  (`src/lib/field-workforce-compliance/`, reads the `ireports360_visits` mirror), which already implements
  hire/resign-date-aware exclusion (`isPreHire` + post-resignation filtering) — no new date logic needed.
- **Unpaid-vacation tab:** a vacation balance is NOT stored — it is computed live via
  `src/lib/vacation/calculations.ts`. "Deduct from balance instead of salary" needed a NEW settlement ledger
  (`payroll_copilot_vacation_settlements`, reversible via `superseded_at`) so the balance isn't
  double-counted; `vacation/service.ts` `approvedPaidDaysInPeriod` was extended to also sum
  `balance_days_consumed` from live settlements. The "deduct from balance" option is gated on FULL coverage
  (`paymentStatus==='paid'`), never partial, and its confirm sends an email (To: employee+manager, CC: HR).

## Status and the migration caveat

Phases 1-4 are all merged to `main` and live on production; the statutory config, `social_insurance_wage`
column and wages are populated on prod (145 SI-enrolled employees). **⚠ The one migration that may still be
unapplied is `20260707100000_payroll_copilot_vacation_settlements.sql`** (the vacation-tab settlement ledger);
as of 2026-07-07 it needed separate owner approval and the Vacation tab is fully inert (empty list, no writes,
defensive against the missing table) until applied. Given the age of this note, **verify its live state with
`pg_class` before acting** — a "not yet applied" line ages into a stale in-flight status. The remaining owner
step was to run a real Copilot payroll and verify SI/tax against the accountant before locking real pay.

**Lessons:** (1) a parallel session hijacked this branch and squash-merged the PR mid-build, colliding the
migration timestamp — **migration-timestamp collisions are a live risk when `main` advances during a long
build; re-check `main`'s migrations before AND after merge.** (2) Local dev points at PRODUCTION Supabase, so
a live Copilot run writes prod rows — verify UI safely via passing tests + a bogus-runId GET (clean 404
through the chain), never a live decision ([[local-browser-verify-gotchas]]).
