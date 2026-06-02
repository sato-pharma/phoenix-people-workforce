import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isPayrollIneligibleEmployee } from "../src/lib/payroll/eligibility.ts";

/**
 * WP-4 regression coverage: payroll read views (dashboard / export) must exclude
 * terminal and payroll-ineligible employees, and the Payslips Center data-layer
 * functions must enforce a company-scope access guard. The payroll service and
 * payslip-center modules are env-bound (Supabase admin client), so the pure rule
 * is unit-tested directly and the service wiring is locked via source assertions
 * (mirroring tests/vacation-module and tests/workforce-hierarchy-continuity).
 */
export function runPayrollLifecycleScopeTests() {
  // -- Pure eligibility rule.
  // Active + payroll-eligible employees remain included.
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "active", payrollEligible: true }),
    false,
    "active + payroll_eligible employee is included",
  );
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "active", payrollEligible: null }),
    false,
    "active employee with unset payroll_eligible is included",
  );
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "on_leave", payrollEligible: true }),
    false,
    "on_leave + payroll_eligible employee is included",
  );

  // Terminal lifecycle statuses are excluded.
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "resigned", payrollEligible: true }),
    true,
    "resigned employee is excluded from payroll dashboard/export",
  );
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "terminated", payrollEligible: true }),
    true,
    "terminated employee is excluded",
  );
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "inactive", payrollEligible: true }),
    true,
    "inactive employee is excluded",
  );
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "not_renewed", payrollEligible: true }),
    true,
    "non-renewed employee is excluded",
  );

  // Explicit payroll-ineligibility excludes even an otherwise-active employee.
  assert.equal(
    isPayrollIneligibleEmployee({ employmentStatus: "active", payrollEligible: false }),
    true,
    "payroll_eligible=false employee is excluded",
  );

  // -- Wiring: payroll service applies the blocklist on top of access scope.
  const serviceSource = readFileSync(
    new URL("../src/lib/payroll/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    serviceSource,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "ineligibility blocklist must be built from the full roster (including inactive)",
  );
  assert.match(
    serviceSource,
    /isPayrollIneligibleEmployee\(employee\)/,
    "blocklist must use the canonical payroll eligibility rule",
  );
  assert.match(
    serviceSource,
    /ineligibleHrIds/,
    "access filter must carry the lifecycle/eligibility blocklist",
  );
  assert.match(
    serviceSource,
    /!isPayrollRecordIneligible\(row, accessFilter\.ineligibleHrIds\)/,
    "record filtering must drop ineligible employees (incl. COMPANY/system)",
  );
  assert.match(
    serviceSource,
    /!isPayrollFlagIneligible\(row, accessFilter\.ineligibleHrIds\)/,
    "flag filtering must drop ineligible employees",
  );

  // -- SELF-scope carve-out: self-service reads keep the viewer's own payslips
  //    (even if payroll_eligible=false) but remain strictly self-only.
  assert.match(
    serviceSource,
    /accessContext\.scope !== "system" && getPayrollScope\(accessContext\) === "SELF"/,
    "self-scope reads must be detected for the eligibility carve-out",
  );
  assert.match(
    serviceSource,
    /isSelfScopeRead \? Promise\.resolve\(new Set<string>\(\)\) : buildPayrollIneligibleHrIdSet\(\)/,
    "self-scope must skip the eligibility blocklist; company/system keeps it",
  );
  // SELF scope still restricts records to the viewer's own HR_ID (self-only).
  assert.match(
    serviceSource,
    /payrollScope === "SELF"[\s\S]*allowedHrIds: new Set\(\[currentHrId\]\)/,
    "SELF scope must restrict allowed records to the viewer only",
  );
  // The blocklist is still applied via scope (isPayrollRecordInScope) so the
  // carve-out never broadens visibility beyond the viewer.
  assert.match(
    serviceSource,
    /isPayrollRecordInScope\(row, accessFilter\.allowedHrIds\)/,
    "record scope restriction must remain in force regardless of the carve-out",
  );

  // -- My Payslips route stays self-scoped: it reads via the access-scoped export
  //    and narrows to a single employeeHrId; it never returns another employee.
  const payslipRouteSource = readFileSync(
    new URL("../app/api/payroll/[id]/payslips/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    payslipRouteSource,
    /getSalaryBatchExport\(id, access\)/,
    "My Payslips must read through the access-scoped export (self-scoped for employees)",
  );
  assert.match(
    payslipRouteSource,
    /filterPayslipRecords\(exportData\.records, request\.url\)/,
    "My Payslips must narrow records to the requested employee",
  );
  assert.match(
    payslipRouteSource,
    /record\.hrId\.toLowerCase\(\) === employeeHrId/,
    "My Payslips employee filter must match on the employee HR_ID",
  );

  // -- Wiring: Payslips Center data functions enforce a company-scope guard.
  const payslipCenterSource = readFileSync(
    new URL("../src/lib/payroll/payslip-center.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    payslipCenterSource,
    /function assertPayslipCenterAccess\(access: AccessContext\)/,
    "payslip center must define a function-level access guard",
  );
  assert.match(
    payslipCenterSource,
    /getPayrollScope\(access\) !== "COMPANY"/,
    "payslip center guard must require company-scope payroll access",
  );
  assert.match(
    payslipCenterSource,
    /throw new Error\("Forbidden: Payslips Center/,
    "non-company access must be rejected with a Forbidden error",
  );
  assert.match(
    payslipCenterSource,
    /export async function getPayslipCenterEmployeeOptions\(access: AccessContext\)/,
    "getPayslipCenterEmployeeOptions must accept AccessContext",
  );
  assert.match(
    payslipCenterSource,
    /export async function searchPayslipCenter\(access: AccessContext,/,
    "searchPayslipCenter must accept AccessContext",
  );
  assert.match(
    payslipCenterSource,
    /assertPayslipCenterAccess\(access\)/,
    "payslip center functions must call the access guard",
  );

  // -- Wiring: the admin page passes its resolved access context through.
  const pageSource = readFileSync(
    new URL("../app/(admin)/admin/payslips-center/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    pageSource,
    /getPayslipCenterEmployeeOptions\(access\)/,
    "payslips-center page must pass access to options lookup",
  );
  assert.match(
    pageSource,
    /searchPayslipCenter\(access, searchParams\.employee\)/,
    "payslips-center page must pass access to search",
  );
}
