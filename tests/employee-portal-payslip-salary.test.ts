import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(
  new URL("../src/lib/employee-portal/service.ts", import.meta.url),
  "utf8",
);

const dashboardSource = readFileSync(
  new URL("../src/components/employee-portal/employee-portal-dashboard.tsx", import.meta.url),
  "utf8",
);

export function runEmployeePortalPayslipSalaryTests() {
  assert.match(
    serviceSource,
    /const payslipBaseSalary = fixedBaseSalary;/,
    "Payslip Base Salary keycard must use the fixed employee salary source.",
  );

  assert.match(
    serviceSource,
    /positiveMoneyOrNull\(employee\.netSalary\) \?\?/,
    "Employee portal salary fallback must not treat a zero employee base salary as valid.",
  );

  assert.match(
    serviceSource,
    /const payslipBasicSalary = calculateBasicSalary\(\{ baseSalary: payslipBaseSalary \}\);/,
    "Payslip Basic Salary keycard must be calculated from fixed base salary.",
  );

  assert.match(
    serviceSource,
    /netSalary: sourceNetSalary,/,
    "Employee portal summary net salary must use fixed base + standard allowances.",
  );

  assert.match(
    serviceSource,
    /netSalary: fixedNetSalary,/,
    "Employee portal latest payslip net salary must use fixed base + standard allowances.",
  );

  assert.doesNotMatch(
    serviceSource,
    /netSalary:\s*latestRecord\?\.netSalary\s*\?\?\s*(sourceNetSalary|fixedNetSalary)/,
    "Employee portal fixed net salary must not be overridden by uploaded monthly net salary.",
  );

  assert.doesNotMatch(
    serviceSource,
    /payslipBasicSalary\s*=\s*latestRecord\?\.firstPart/,
    "Payslip Basic Salary must not use the uploaded first part value.",
  );

  assert.match(
    dashboardSource,
    /Base Salary x 70%/,
    "Payslip salary breakdown must explain the fixed basic salary formula.",
  );

  assert.match(
    dashboardSource,
    /Base Salary \+ Extra Cost of Living \+ Fuel Allowance/,
    "Payslip salary breakdown must explain the fixed net salary formula.",
  );

  assert.match(
    dashboardSource,
    /\.sort\(\(left, right\) => left\.value - right\.value/,
    "Payslip salary breakdown rows must render from smallest amount to largest amount.",
  );

  assert.doesNotMatch(
    dashboardSource,
    /This breakdown is read from the latest uploaded payroll sheet/,
    "Payslip salary breakdown copy must not say the fixed breakdown is read from the uploaded sheet.",
  );
}
