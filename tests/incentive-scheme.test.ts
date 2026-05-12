import assert from "node:assert/strict";

import { calculateIncentive2026 } from "../src/lib/incentives/scheme-2026.ts";
import { calculatePayrollParts } from "../src/lib/payroll/policy.ts";

export function runIncentiveSchemeTests() {
  const result = calculateIncentive2026({
    achievementPercent: 150,
    netSalary: 90000,
  });

  assert.equal(result.basicSalary, 63000);
  assert.equal(result.semesterTargetIncentive, 126000);
  assert.equal(result.payoutPercentage, 220);
  assert.equal(result.payoutAmount, 277200);

  const hundredPercent = calculateIncentive2026({
    achievementPercent: 100,
    netSalary: 90000,
  });

  assert.equal(hundredPercent.payoutPercentage, 100);
  assert.equal(hundredPercent.payoutAmount, 126000);

  const withAllowances = calculateIncentive2026({
    achievementPercent: 100,
    baseSalary: 16000,
    extraCostOfLiving: 2500,
    fuelAllowance: 4050,
  });

  assert.equal(withAllowances.netSalary, 22550);
  assert.equal(withAllowances.basicSalary, 11200);
  assert.equal(withAllowances.semesterTargetIncentive, 22400);
  assert.equal(withAllowances.payoutAmount, 22400);

  const netSalaryWithAllowances = calculateIncentive2026({
    achievementPercent: 100,
    netSalary: 22550,
    extraCostOfLiving: 2500,
    fuelAllowance: 4050,
  });

  assert.equal(netSalaryWithAllowances.netSalary, 22550);
  assert.equal(netSalaryWithAllowances.basicSalary, 11200);
  assert.equal(netSalaryWithAllowances.semesterTargetIncentive, 22400);

  const fixedBasic = calculateIncentive2026({
    achievementPercent: 100,
    basicSalary: 11200,
    extraCostOfLiving: 2500,
    fuelAllowance: 4050,
    netSalary: 17000,
  });

  assert.equal(fixedBasic.basicSalary, 11200);
  assert.equal(fixedBasic.payoutAmount, 22400);

  const b12 = calculateIncentive2026({
    achievementPercent: 120,
    baseSalary: 30000,
  });

  assert.equal(b12.basicSalary, 21000);
  assert.equal(b12.semesterTargetIncentive, 42000);
  assert.equal(b12.payoutPercentage, 130);
  assert.equal(b12.payoutAmount, 54600);

  const b67 = calculateIncentive2026({
    achievementPercent: 97,
    baseSalary: 16500,
  });

  assert.equal(b67.basicSalary, 11550);
  assert.equal(b67.semesterTargetIncentive, 23100);
  assert.equal(b67.payoutPercentage, 85);
  assert.equal(b67.payoutAmount, 19635);

  const twoPartSalary = calculatePayrollParts({
    netSalary: 22550,
    extraCostOfLiving: 2500,
    fuelAllowance: 4050,
  });

  assert.equal(twoPartSalary.basicSalary, 11200);
  assert.equal(twoPartSalary.firstPart, 11200);
  assert.equal(twoPartSalary.secondPart, 11350);
  assert.equal(twoPartSalary.totalPayable, 22550);
}
