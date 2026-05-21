import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeEmployeeSalaryDetails } from "../src/lib/employees/employee-directory.ts";

const employeeManagementSource = readFileSync(
  new URL("../src/components/employees/employee-management.tsx", import.meta.url),
  "utf8",
);
const employeeDirectorySource = readFileSync(
  new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
  "utf8",
);

export function runEmployeeSalaryDetailsTests() {
  const normalized = normalizeEmployeeSalaryDetails([
    {
      category: "earning",
      id: "mobile",
      label: "Mobile Allowance",
      notes: "Monthly",
      value: "750",
      valueType: "amount",
    },
    {
      category: "reference",
      label: "Payroll Grade",
      value: "G7",
      valueType: "text",
    },
    {
      label: "   ",
      notes: "   ",
      value: "   ",
    },
  ]);

  assert.deepEqual(normalized, [
    {
      category: "earning",
      id: "mobile",
      label: "Mobile Allowance",
      notes: "Monthly",
      value: "750",
      valueType: "amount",
    },
    {
      category: "reference",
      id: "salary-detail-2",
      label: "Payroll Grade",
      notes: null,
      value: "G7",
      valueType: "text",
    },
  ]);

  assert.match(
    employeeManagementSource,
    /salaryDetails: EmployeeSalaryDetailFormRow\[\];/,
    "Employee lifecycle form must hold flexible salary detail rows.",
  );

  assert.match(
    employeeManagementSource,
    /Flexible Salary Details/,
    "Employee lifecycle UI must expose the flexible salary details section.",
  );

  assert.match(
    employeeDirectorySource,
    /salary_details/,
    "Employee directory persistence must reference salary_details storage.",
  );
}
