import assert from "node:assert/strict";

import {
  DEFAULT_EXTRA_COST_OF_LIVING,
  STANDARD_FUEL_ALLOWANCE,
  resolveStandardSalaryAllowances,
  standardExtraCostOfLiving,
} from "../src/lib/payroll/allowance-policy.ts";
import {
  calculateGrossSalary,
  calculateNetSalary,
  calculatePayrollParts,
  resolveFixedSalaryAmounts,
} from "../src/lib/payroll/policy.ts";
import { resolveEmployeeMasterExportSalary } from "../src/lib/employees/employee-master-export.ts";

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
  assert.equal(standardExtraCostOfLiving({ departmentName: "Marketing" }), 1500);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Marketing Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Product Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Group Product Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ positionTitle: "Training Manager" }), 3000);
  assert.equal(standardExtraCostOfLiving({ jobTitle: "Accountant" }), 1500);

  const preAprilAllowances = resolveStandardSalaryAllowances({
    jobTitle: "Medical Representative",
    month: 3,
    year: 2026,
  });
  assert.equal(preAprilAllowances.fuelAllowance, 0);
  assert.equal(preAprilAllowances.extraCostOfLiving, 0);
  assert.equal(calculateNetSalary({ baseSalary: 14000, ...preAprilAllowances }), 14000);

  const mrAllowances = resolveStandardSalaryAllowances({
    jobTitle: "Medical Representative",
    month: 4,
    year: 2026,
  });
  assert.equal(mrAllowances.fuelAllowance, 500);
  assert.equal(mrAllowances.extraCostOfLiving, 2000);
  assert.equal(calculateNetSalary({ baseSalary: 14000, ...mrAllowances }), 16500);
  assert.equal(calculateGrossSalary({ baseSalary: 14000, socialInsurance: 1200, taxes: 800 }), 16000);
  assert.deepEqual(
    resolveFixedSalaryAmounts({
      baseSalary: 14000,
      basicSalary: 1,
      extraCostOfLiving: 2000,
      fuelAllowance: 500,
      grossSalary: 999,
      netSalary: 999,
      socialInsurance: 1200,
      taxes: 800,
    }),
    {
      baseSalary: 14000,
      basicSalary: 9800,
      grossSalary: 16000,
      netSalary: 16500,
    },
  );

  assert.deepEqual(
    resolveEmployeeMasterExportSalary({
      baseSalary: 14000,
      basicSalary: 1,
      extraCostOfLiving: 2000,
      fuelAllowance: 500,
      grossSalary: 999,
      netSalary: 999,
      socialInsurance: 1200,
      taxes: 800,
    }),
    {
      baseSalary: 14000,
      basicSalary: 9800,
      grossSalary: 16000,
      netSalary: 16500,
    },
  );

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
