import assert from "node:assert/strict";

import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";

// The Employee Master upload normalizes Fuel Allowance to the payroll figure on every row. On
// 2026-09-15 that reset a Medical Representative whose fuel is the standard 500 plus a 1,500 car
// allowance (owner decision) back to 500, and her net from 20,000 to 18,500. The approved figure now
// comes from the same resolver the upload normalizes to, so re-uploading it is a no-op.

const existingState = {
  canonicalAreas: [{ code: "AB1", name: "Cairo" }],
  employeeHrIds: new Set<string>(),
  employeeHrIdByCanonicalKey: new Map(),
};

function medicalRepRow(overrides: Record<string, unknown>) {
  return {
    Area: "Cairo",
    "Base Salary": 16000,
    "Extra Cost Of Living": 2000,
    "Full Name": "Test Employee",
    "Gross Salary": 20358.35,
    "Job Title": "Medical Representative",
    Line: "Pedia",
    Position: "Medical Representative",
    Region: "Cairo",
    "Social Insurance": 1837,
    Taxes: 2521.35,
    ...overrides,
  };
}

function upload(row: Record<string, unknown>, hrId: string) {
  const result = validateEmployeeImportRows([row], { existingState });
  const record = [...result.rowsToInsert, ...result.rowsToUpdate].find((candidate) => candidate.hrId === hrId);
  assert.ok(record, `${hrId} must be importable`);
  const warningCodes = result.validationWarnings
    .filter((issue) => issue.rowNumber === record.rowNumber)
    .map((issue) => issue.code);
  return { compensation: record.compensation, warningCodes };
}

export function runEmployeeImportPersonalFuelAllowanceTests() {
  // Re-uploading the approved figures changes nothing and warns about nothing.
  const kept = upload(
    medicalRepRow({ "Full Name": "Exception Employee", HR_ID: "PD-0013", "Fuel Allowance": 2000, "Net Salary": 20000 }),
    "PD-0013",
  );
  assert.equal(kept.compensation.fuelAllowance, 2000, "the upload keeps the approved 2,000 fuel allowance");
  assert.equal(kept.compensation.extraCostOfLiving, 2000, "cost of living stays the Medical Representative standard");
  assert.equal(kept.compensation.netSalary, 20000, "net stays base 16,000 + cost of living 2,000 + fuel 2,000");
  assert.ok(
    !kept.warningCodes.includes("fuel_allowance_policy_mismatch"),
    "the approved fuel figure must not be reported as a policy mismatch",
  );
  assert.ok(
    !kept.warningCodes.includes("net_salary_formula_mismatch"),
    "a net that includes the approved fuel must not be reported as a formula mismatch",
  );

  // A sheet still carrying the standard 500 is corrected up to the approved figure, with the warning.
  const corrected = upload(
    medicalRepRow({ "Full Name": "Exception Employee", HR_ID: "PD-0013", "Fuel Allowance": 500, "Net Salary": 18500 }),
    "PD-0013",
  );
  assert.equal(corrected.compensation.fuelAllowance, 2000, "an upload carrying 500 is corrected to the approved 2,000");
  assert.equal(corrected.compensation.netSalary, 20000, "and its net is corrected with it");
  assert.ok(corrected.warningCodes.includes("fuel_allowance_policy_mismatch"), "the correction is reported");

  // Everyone else is still normalized to the standard 500, exactly as before.
  const standard = upload(
    medicalRepRow({ "Full Name": "Standard Employee", HR_ID: "T-001", "Fuel Allowance": 2000, "Net Salary": 20000 }),
    "T-001",
  );
  assert.equal(standard.compensation.fuelAllowance, 500, "an employee with no approved exception is still normalized to 500");
  assert.equal(standard.compensation.netSalary, 18500, "and that employee's net is normalized with it");
  assert.ok(standard.warningCodes.includes("fuel_allowance_policy_mismatch"), "the normalization is still reported");
}
