import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const employeeManagementSource = readFileSync(
  new URL("../src/components/employees/employee-management.tsx", import.meta.url),
  "utf8",
);
const employeeDirectorySource = readFileSync(
  new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
  "utf8",
);
const payrollTemplateRouteSource = readFileSync(
  new URL("../app/api/payroll/template/route.ts", import.meta.url),
  "utf8",
);

export function runEmployeePayrollEligibilityTests() {
  assert.match(
    employeeManagementSource,
    /payrollEligible: string;/,
    "Employee edit form must carry Payroll Eligible state.",
  );

  assert.match(
    employeeManagementSource,
    /payrollEligible: "yes"/,
    "New employee form must default Payroll Eligible to Yes.",
  );

  assert.match(
    employeeManagementSource,
    /payrollEligible: employee\.payrollEligible === false \? "no" : "yes"/,
    "Employee edit form must hydrate Payroll Eligible from the employee master row.",
  );

  assert.match(
    employeeManagementSource,
    /payrollEligible: form\.payrollEligible !== "no"/,
    "Employee save payload must persist Payroll Eligible.",
  );

  assert.match(
    employeeManagementSource,
    /label="Payroll Eligible"[\s\S]*options=\{yesNoOptions\}[\s\S]*value=\{canSelectPayrollEligibility \? form\.payrollEligible : "no"\}/,
    "Employee edit popup must expose Payroll Eligible as a yes/no control.",
  );

  assert.match(
    employeeDirectorySource,
    /payrollEligible\?: boolean \| null;/,
    "Employee mutation input must accept Payroll Eligible.",
  );

  assert.match(
    employeeDirectorySource,
    /const payrollEligible = lifecycleActive \? input\.payrollEligible !== false : false;/,
    "Employee persistence must respect manual Payroll Eligible while keeping inactive lifecycle rows excluded.",
  );

  assert.match(
    employeeDirectorySource,
    /payroll_eligible: payrollEligible/,
    "Employee persistence must write payroll_eligible from the resolved flag.",
  );

  assert.match(
    payrollTemplateRouteSource,
    /\(employee\.employmentStatus \?\? "active"\) === "active" && employee\.payrollEligible !== false/,
    "Payroll templates must exclude employees marked not eligible for payroll.",
  );
}
