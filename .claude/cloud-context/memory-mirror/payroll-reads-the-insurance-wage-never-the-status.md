---
name: payroll-reads-the-insurance-wage-never-the-status
description: "Payroll never reads social_insurance_status - the social_insurance_wage column alone decides who enters the statutory filing, so the register and the filing can disagree silently in both directions"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e8ea035-a798-4763-9d03-cacf8fae9490
  modified: 2026-08-31T17:56:04.071Z
---

`employees.social_insurance_status` (`yes` / `no` / `pending` / blank) is **display and data-entry
only**. Measured 2026-08-31 on `origin/main`: `git grep -n 'social_insurance_status\|socialInsuranceStatus' -- src/lib/payroll`
returns **zero hits**. The column surfaces in the directory, the import validator, the record-health
check, the portal and the hiring pack — never in a payroll computation.

What actually decides is **`employees.social_insurance_wage`**. `src/lib/payroll/copilot/service.ts`
selects exactly `hr_id,social_insurance_wage` with **no status column and no filter**, and
`assemble.ts:149` gates the whole statutory block on `insuranceWage != null && baseSalary > 0`.
So a wage present means the person is computed into the filing whatever the register says, and a
wage absent means they are not, however confidently the register says `yes`.

**The two failure shapes are opposite and both silent.** Omar Anwar (B-10) sat marked `no` while
carrying a 16,700 wage — the register said not insured and payroll filed him anyway. The mirror case
is anyone marked `yes` with a null wage: the register looks complete and the person is in no filing
at all. Neither raises an error, and `employee-record-health.ts` checks only that the status is one
of the three valid strings and that a `yes` carries an insurance number — it never compares status
to wage.

**How to apply:** never audit insurance enrollment by status. Query the two columns together and
reconcile them, in both directions. Reconciled clean across all 106 active employees on 2026-08-31:
`yes` 93 (92 filed — the one exception is deliberate), `pending` 8 (7 filed), `no` 4 (0 filed), blank
1 (the CEO). Wage rule, owner's own: base ÷ 1.3, capped at **16,700**; the statutory basic wage
prints as a flat **2,450**; `payroll_statutory_config` carries employee 11%, employer 18.75%, floor
2,700, effective 2026-01-01 (Law 148/2019). A `pending` person with a wage is correct and intended —
they are enrolled and awaiting the Authority's number.

Setting a wage does **not** cost the employee anything — see
[[social-insurance-and-tax-never-reduce-take-home-pay]]. Related:
[[people-with-no-salary-figure-are-priced-at-nothing]].
