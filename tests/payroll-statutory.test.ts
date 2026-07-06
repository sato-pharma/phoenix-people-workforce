import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildRowForEmployee } from "../src/lib/payroll/copilot/assemble.ts";
import { evaluateEmployeeFlags } from "../src/lib/payroll/copilot/flags.ts";
import type { CopilotPeriod } from "../src/lib/payroll/copilot/types.ts";
import {
  clampInsuranceWage,
  computeAnnualTaxFromBrackets,
  computeIncomeTax,
  computeSocialInsurance,
  computeStatutory,
} from "../src/lib/payroll/statutory/calculator.ts";
import { DEFAULT_STATUTORY_CONFIG } from "../src/lib/payroll/statutory/config.ts";
import { validateSalaryRows } from "../src/lib/payroll/salary-import.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

const CONFIG = DEFAULT_STATUTORY_CONFIG;
const PERIOD: CopilotPeriod = { month: 6, year: 2026 };

function statSource(overrides: Partial<PayrollSalarySource> = {}): PayrollSalarySource {
  return {
    baseSalary: 8000,
    grossSalary: 10000,
    netSalary: 10500,
    socialInsurance: 999,
    employmentIncomeTax: 999,
    extraCostOfLiving: 2000,
    fuelAllowance: 500,
    paymentMode: "two_parts",
    ...overrides,
  };
}

function statEmp(): EmployeeDirectoryRow {
  return {
    hrId: "B-STAT",
    fullName: "Statutory Test",
    nameAr: null,
    jobTitle: "Medical Representative",
    lineName: "Line A",
    areaName: "Area 1",
    hireDate: "2020-01-01",
    employmentStatus: "active",
    payrollEligible: true,
  } as unknown as EmployeeDirectoryRow;
}

export function runPayrollStatutoryTests() {
  // --- social insurance (11% employee / 18.75% employer, caps 2,700–16,700) ---
  const si = computeSocialInsurance(10000, CONFIG);
  assert.equal(si.subjectWage, 10000);
  assert.equal(si.employee, 1100);
  assert.equal(si.employer, 1875);

  // above the max cap → clamped to 16,700
  const siMax = computeSocialInsurance(25000, CONFIG);
  assert.equal(siMax.subjectWage, 16700);
  assert.equal(siMax.employee, 1837);
  assert.equal(siMax.employer, 3131.25);

  // below the min cap → clamped to 2,700
  const siMin = computeSocialInsurance(1000, CONFIG);
  assert.equal(siMin.subjectWage, 2700);
  assert.equal(siMin.employee, 297);

  assert.equal(clampInsuranceWage(500, CONFIG), 2700);
  assert.equal(clampInsuranceWage(50000, CONFIG), 16700);
  assert.equal(clampInsuranceWage(9000, CONFIG), 9000);

  // --- annual bracket application (marginal) --------------------------------
  assert.equal(computeAnnualTaxFromBrackets(0, CONFIG.taxBrackets), 0);
  assert.equal(computeAnnualTaxFromBrackets(40000, CONFIG.taxBrackets), 0); // all in 0% band
  assert.equal(computeAnnualTaxFromBrackets(50000, CONFIG.taxBrackets), 1000); // (50k-40k)*10%
  // 40–55k: 1,500 ; 55–70k: 2,250 ; 70–86.8k: 16,800*20% = 3,360 → 7,110
  assert.equal(computeAnnualTaxFromBrackets(86800, CONFIG.taxBrackets), 7110);

  // --- monthly income tax (annualize − exemption, floor to step, ÷12) -------
  // gross 10,000 ; SI 1,100 → annualNet 106,800 − 20,000 = 86,800 → 7,110/yr → 592.50/mo
  assert.equal(computeIncomeTax(10000, 1100, CONFIG), 592.5);
  // taxable rounds DOWN to nearest 10 → same result as the round case
  assert.equal(computeIncomeTax(10000.5, 1100, CONFIG), 592.5);
  // below exemption → zero tax
  assert.equal(computeIncomeTax(2000, 220, CONFIG), 0);

  // --- combined statutory result --------------------------------------------
  const combined = computeStatutory({ monthlyGross: 10000, insuranceWage: 10000 }, CONFIG);
  assert.equal(combined.socialInsurance, 1100);
  assert.equal(combined.employerSocialInsurance, 1875);
  assert.equal(combined.incomeTax, 592.5);
  assert.equal(combined.subjectWage, 10000);

  // high earner, standard brackets (phase-out intentionally NOT applied in P2)
  const high = computeStatutory({ monthlyGross: 100000, insuranceWage: 16700 }, CONFIG);
  assert.equal(high.socialInsurance, 1837);
  assert.equal(high.incomeTax, 22019.79);

  // disabled uses the higher (EGP 30,000) exemption
  assert.ok(
    computeIncomeTax(10000, 1100, CONFIG, { disabled: true }) <
      computeIncomeTax(10000, 1100, CONFIG),
  );

  // --- copilot assembly integration -----------------------------------------
  // Base/Basic/Net must NEVER move regardless of SI/Tax — only Gross is
  // allowed to move, computed FORWARD as Base + SI + Tax. Tax is computed on
  // Base (not Gross): monthlyGross fed to computeIncomeTax is Base + SI so it
  // cancels back out to Base × 12 annualized.
  const computedRow = buildRowForEmployee({
    employee: statEmp(),
    source: statSource(),
    recurring: [],
    adjustments: [],
    period: PERIOD,
    index: 1,
    statutory: { config: CONFIG, insuranceWage: 10000 },
  });
  assert.ok(computedRow, "row should assemble");
  assert.equal(computedRow.socialInsurance, 1100);
  // tax on (base 8000 + SI 1100 = 9100), SI 1100 → annualNet (9100-1100)*12=96000
  // − 20,000 exemption = 76,000 taxable → 4,950/yr → 412.50/mo
  assert.equal(computedRow.employmentIncomeTax, 412.5);
  assert.equal(computedRow.baseSalary, 8000, "base must equal the stored master value, never re-derived");
  assert.equal(computedRow.netSalary, 10500, "net must equal the stored master value, never re-derived");
  assert.equal(computedRow.grossSalary, 9512.5); // forward: 8000 + 1100 + 412.5
  assert.equal(computedRow.governmentalDeductions, 1512.5);

  // Gross's movement must never perturb the bank payout (monthSalary) — prove
  // it by comparing against the same row assembled with NO insurance wage,
  // where Gross is simply carried unchanged from source.
  const carriedRow = buildRowForEmployee({
    employee: statEmp(),
    source: statSource(),
    recurring: [],
    adjustments: [],
    period: PERIOD,
    index: 1,
    statutory: { config: CONFIG, insuranceWage: null },
  });
  assert.ok(carriedRow, "row should assemble");
  assert.equal(carriedRow.socialInsurance, 999);
  assert.equal(carriedRow.employmentIncomeTax, 999);
  assert.equal(carriedRow.grossSalary, 10000); // carried straight from source, untouched
  assert.equal(carriedRow.baseSalary, computedRow.baseSalary);
  assert.equal(carriedRow.netSalary, computedRow.netSalary);
  assert.equal(
    carriedRow.monthSalary,
    computedRow.monthSalary,
    "monthSalary (bank payout) must be identical with or without an insurance wage configured",
  );

  // A prior snapshot with the same base but a different implied gross must
  // never false-fire salary_role_change — proves the statutory-drift bug that
  // caused ~100 false positives in the first live run is gone.
  const flags = evaluateEmployeeFlags({
    row: computedRow,
    employee: statEmp(),
    source: statSource(),
    prior: { netSalary: computedRow.netSalary, baseSalary: computedRow.baseSalary, line: "Line A", jobTitle: "Medical Representative" },
    feeder: undefined,
    period: PERIOD,
    bigChangeThreshold: 0.25,
  });
  assert.ok(
    !flags.some((flag) => flag.rule === "salary_role_change"),
    "salary_role_change must not fire when only Gross moved",
  );

  // the assembled row must satisfy the shared validator (no formula mismatch)
  const formulaIssues = validateSalaryRows([computedRow]).filter((issue) =>
    ["gross_salary_formula_mismatch", "net_salary_formula_mismatch", "deductions_exceed_net"].includes(issue.code),
  );
  assert.deepEqual(formulaIssues, []);
}
