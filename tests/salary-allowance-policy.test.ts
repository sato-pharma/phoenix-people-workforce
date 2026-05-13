import assert from "node:assert/strict";

import {
  DEFAULT_EXTRA_COST_OF_LIVING,
  STANDARD_FUEL_ALLOWANCE,
  resolveStandardSalaryAllowances,
  standardExtraCostOfLiving,
} from "../src/lib/payroll/allowance-policy.ts";
import { calculateNetSalary, calculatePayrollParts } from "../src/lib/payroll/policy.ts";

export function runSalaryAllowancePolicyTests() {
  assert.equal(STANDARD_FUEL_ALLOWANCE, 500);
  assert.equal(DEFAULT_EXTRA_COST_OF_LIVING, 1500);

  assert.equal(standardExtraCostOfLiving({ jobTitle: "National Sales Manager" }), 5000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "NSM" }), 5000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "NSMs" }), 5000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "N.S.M." }), 5000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "District Sales Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "DSM" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "DSMs" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Medical Representative" }), 2000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "MR" }), 2000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "MRs" }), 2000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "M.R." }), 2000);
  assert.equal(standardExtraCostOfLiving({ departmentName: "Marketing" }), 3000);
  assert.equal(standardExtraCostOfLiving({ positionTitle: "Training Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Accountant" }), 1500);

  const mrAllowances = resolveStandardSalaryAllowances({ jobTitle: "Medical Representative" });
  assert.equal(mrAllowances.fuelAllowance, 500);
  assert.equal(mrAllowances.extraCostOfLiving, 2000);
  assert.equal(calculateNetSalary({ baseSalary: 14000, ...mrAllowances }), 16500);

  const mrParts = calculatePayrollParts({
    baseSalary: 14000,
    ...mrAllowances,
    paymentMode: "two_parts",
  });
  assert.equal(mrParts.basicSalary, 9800);
  assert.equal(mrParts.firstPart, 9800);
  assert.equal(mrParts.secondPart, 6700);
  assert.equal(mrParts.totalPayable, 16500);
}
