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
  const helperStart = serviceSource.indexOf("function resolveFixedSalaryReference");
  const helperEnd = serviceSource.indexOf("function pickText", helperStart);
  const fixedSalaryReferenceSource = helperStart >= 0 && helperEnd > helperStart
    ? serviceSource.slice(helperStart, helperEnd)
    : "";

  assert.ok(
    fixedSalaryReferenceSource,
    "Employee portal service must define a fixed salary reference resolver.",
  );

  assert.match(
    serviceSource,
    /const payslipBaseSalary = fixedSalary\.baseSalary;/,
    "Payslip Base Salary keycard must use the fixed employee salary source.",
  );

  assert.match(
    serviceSource,
    /positiveMoneyOrNull\(employee\.baseSalary\) \?\?/,
    "Employee portal fixed salary must prefer the employee master Base Salary.",
  );

  assert.match(
    serviceSource,
    /positiveMoneyOrNull\(employee\.basicSalary\)/,
    "Employee portal fixed salary must use the employee master Basic Salary when it exists.",
  );

  assert.doesNotMatch(
    serviceSource,
    /salaryStructure\?\.baseSalary\s*\?\?\s*positiveMoneyOrNull\(employee\.netSalary\)/,
    "Employee portal fixed Base Salary must not treat employee Net Salary as the first salary fallback.",
  );

  assert.doesNotMatch(
    fixedSalaryReferenceSource,
    /latestRecord/,
    "Employee portal fixed salary reference must not derive fixed salary cards from monthly payslip records.",
  );

  assert.match(
    serviceSource,
    /const payslipBasicSalary = fixedSalary\.basicSalary;/,
    "Payslip Basic Salary keycard must use the fixed employee salary source.",
  );

  assert.match(
    serviceSource,
    /netSalary: fixedSalary\.netSalary,/,
    "Employee portal summary net salary must use the fixed employee salary source.",
  );

  assert.match(
    serviceSource,
    /latestPayslip[\s\S]*netSalary: fixedSalary\.netSalary,/,
    "Employee portal latest payslip net salary must use the fixed employee salary source.",
  );

  assert.doesNotMatch(
    serviceSource,
    /netSalary:\s*latestRecord\?\.netSalary\s*\?\?\s*fixedSalary\.netSalary/,
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
