---
name: automated-payroll-resignation-crm-bug-fix
description: "Fixed the resignation CRM over-deduction (was charging post-resignation days); dedicated Resignations CRM tab, Base÷actual-month-days. BUT the self-heal only discards a stored day count GREATER than days worked, so a stale charge that FITS INSIDE the span survives with no candidate behind it — three did in August 2026 and one zeroed a whole payslip. Join draft rows to deductions_candidates; a charge with no candidate is unbacked."
metadata: 
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-09-04T00:00:00.000Z
---

**The bug (owner-reported 2026-07-26, "tried 10 times manual, numbers differ")**: the shared CRM tab's Working/Non-Working Days complement capped at the WHOLE MONTH (31 in July) for everyone, including resigned employees. A leaver who worked only 9 days (e.g. B-111 Amany Wasiem, resigned 9 July, base 14,000) could show 22 "non-working" days — the days AFTER she had already left — and get deducted `14,000/30 × 22 = 10,266.67`, when her real settlement was only 4,064.52. Net effect: she'd owe the company money instead of being owed.

**Owner's exact rule (locked in)**: unify the resignation CRM deduction rate with the resignation settlement's own rate — both use `Base ÷ ACTUAL calendar days in the month` (÷31 in July, ÷30 in June, etc.), never a fixed 30. Owner's worked example, confirmed exactly: base 14,000, resigned day 10 (9 days worked), 2 no-activity days → settlement `14,000/31×9=4,064.52`, CRM deduction `14,000/31×2=903.23`, July salary `4,064.52-903.23=3,161.29`.

**Fix built** (owner chose the more invasive option — a fully separate tab — over an in-place ~15-line patch, after I laid out both): new `p1_resignation_crm` step ("Resignations CRM"), leaver-only, in `src/lib/automated-payroll/recommend.ts` (`recommendResignationCrm` + exported pure `resignationCrmDeduction(base, days, period)`), `src/lib/automated-payroll/step-definitions.ts`, `src/lib/automated-payroll/types.ts`. Working+Non-Working Days now cap at the leaver's **Days Worked** (employment span), never the month. Reuses the existing `resignationCrmDays`/`crm` DraftRow columns directly (field keys ARE the column names) — no migration, no run-service remap needed for CRM (only the pre-existing vacation remap stays). Self-healing: a saved day count that's now impossible (> days worked) is discarded and re-recommended live; a saved value still ≤ days worked is trusted as-is (never silently overwritten — flagged for HR review instead, see below). The shared `p1_crm` tab is now continuing (one-part) employees only, unchanged ÷30 behavior for them.

**Live-verified against the real July 2026 run** (`2f1660e5-a6d8-4ccb-9492-0d589f252b43`) before shipping: Amany self-healed from 22 days/10,266.67 → 1 day/451.61 automatically. Shared `p1_crm` now has 0 leaver overlap (disjointness proven). Two rows flagged for owner review, not auto-corrected (saved value technically valid under the new cap but disagrees sharply with the fresh recommendation): **B-138 Ibrahim** (saved 17 days/7,677.42 vs recommended 2 days/903.23) and **B-28 Heba** (saved 0 days/0 vs recommended 21 days/17,951.61).

**Tests**: `tests/automated-payroll-resignation-crm.test.ts` (new, pure-function unit tests incl. a real "prove it fails" pass reintroducing the ÷30 bug and confirming the test catches it), `tests/automated-payroll-part1-scope.test.ts` rewritten for the new tab's metadata + disjointness. All 447 test files pass; `pnpm run check:harden` clean.

**Shipped**: PR #1355 merged 2026-07-25 (commit `4a090c2c`), deployed to production as revision `phoenix-hr-00542-cuy` (europe-west3, 100% traffic), zero `app_error_events` since promotion. Built in isolated worktree `F:\Phoenix Workforce\_wt-resignation-crm`, branch `codex/resignation-crm-dedicated-tab`, off latest `origin/main` (which already included the FAB/CIB work, PR #1354 — see [[automated-payroll-fab-cib-bank-sheets]]).

**Still open**: the two flagged rows (Ibrahim B-138, Heba B-28) were deliberately left un-auto-corrected — the owner hasn't yet said whether their saved values were intentional or stale-bug leftovers. Whoever opens the Resignations CRM tab next should raise these two specifically before Part 1 is confirmed for July 2026.

**Follow-up bug found + fixed same day**: see [[automated-payroll-leaver-medical-insurance-fix]] — a related but separate bug in `freezeFirstPart` (medical insurance never deducted for a two-part leaver whose settlement collapses entirely into First Part, e.g. Amany).

## 2026-09-04 — the guard's gap is not theoretical, and it recurs every month

**The self-heal above only fires on `storedDays > daysWorked`.** `recommendResignationCrm`
(`src/lib/automated-payroll/recommend.ts`) trusts any saved count inside the employment span:

```ts
const nonWorking =
  storedDays != null && storedDays >= 0 && storedDays <= daysWorked ? storedDays : recommendedNonWorking;
```

31 is not > 31. 5.5 is not > 9. 2 is not > 12. **So a stale whole-month value that happens to fit
inside the span is trusted forever, and no amount of re-opening the tab corrects it.** The
"flagged for HR review instead" behaviour recorded above is the whole of the protection, and a flag
nobody reads is not protection.

**Measured on the August 2026 run** (`715d41fa-1c0e-4387-ab01-e1eb4824a6cb`): of 8 CRM charges
totalling 24,483.87, **three had no candidate in the Deductions module at all** — not approved, not
pending, not superseded. Together they were **18,556.45, or 76% of the month's CRM**.

- **A-13 Nada El Saghir** — charged **31 of the 31 days she worked**, i.e. 100% of her pay.
  `14,500.00` earned, `14,500.00` charged, `first_part_frozen = 0.00`. **Her payslip was exactly
  EGP 0.00.** She is an Office Coordinator at Head office with no CRM territory and never had one —
  **the only non-Medical-Rep ever charged CRM across all 27 charges in this system's history.**
- **B-144 Mariam Farahat** — 5.5 of 9 days. **B-34 Sherouk Wael** — 2 of 12 days.

**The reliable test is the candidate join, not the day count.** A day count cannot tell a real
charge from a stale one; the presence of a row in `deductions_candidates` for that person and month
can. Since the owner's rule of 2026-08-04 the Deductions module decides which days are chargeable,
so **a `crm` value with no candidate behind it was decided by nobody** and is the shape to sweep for.

**Removed on the owner's instruction 2026-09-04** ("apply your recommendations on sheet 3"), with
every row of the run copied to `payroll_backup_20260904.draft_rows_pre_crm_fix` first (122 rows,
24,483.87 preserved, both read ACLs measured false). The UPDATE carried its expected `crm` and
`resignation_crm_days` as preconditions, so it is idempotent by construction: exactly 3 rows
matched, 119 came back byte-identical to the pre-image, and the 3 differed on exactly 3 columns.
August CRM: **24,483.87 → 5,927.42**, rows charged 8 → 5. The five that remain are all candidate-backed.

**A code fix was proposed and NOT made** — the guard should also refuse a stored count when the
module holds no candidate for that person that month. That is payroll logic, so it waits for the
owner to name it. Until then this defect regenerates every month.
