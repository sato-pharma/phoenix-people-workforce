---
name: social-insurance-and-tax-never-reduce-take-home-pay
description: "Social insurance and income tax are reported as governmentalDeductions but are absent from the deductions that feed payable pay - the company absorbs both, so setting an insurance wage costs the employee nothing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9e8ea035-a798-4763-9d03-cacf8fae9490
  modified: 2026-08-31T17:56:14.637Z
---

They are called deductions and they deduct nothing. In `src/lib/payroll/copilot/assemble.ts` the
word `socialInsurance` appears in exactly **five** places (lines 132, 151, 157, 318, 396) and none of
them reaches the amount paid:

```ts
const totalDeductions = roundCurrency(
  crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
);
const governmentalDeductions = roundCurrency(socialInsurance + employmentIncomeTax);
```

`governmentalDeductions` is a **reported figure only**. The payable amount comes from
`calculatePayrollParts`, whose deduction list is the first total above — social insurance and income
tax are not in it. `src/lib/payroll/policy.ts` confirms the other side: `calculateNetSalary` is
`base + extraCostOfLiving + fuelAllowance`, and `totalPayable = netSalary + variableAdjustments`.
Neither statutory figure appears anywhere in either. Sato absorbs both.

**Why this matters:** it reads exactly backwards. I asserted repeatedly on 2026-08-31 that setting
`social_insurance_wage` "starts deducting 1,837/month from pay" (11% of the 16,700 ceiling), and the
owner's constraint *"but do not deduct anything from net or base"* is what forced the check that
disproved it. The plausible reading is the wrong one, and nothing in the UI corrects it — the payslip
prints a governmental-deductions line that never moved the money.

**How to apply:** setting or correcting an insurance wage is safe for take-home pay — it changes who
is filed with the Authority and what the employer owes, not what the employee receives. Do not warn
the owner that it will cost someone money, and do not withhold a wage for that reason. Withhold one
only when the person is genuinely not yet enrolled, because the wage is what puts them in the filing:
[[payroll-reads-the-insurance-wage-never-the-status]].
