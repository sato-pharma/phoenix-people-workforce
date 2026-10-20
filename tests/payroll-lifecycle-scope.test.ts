import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isPayrollIneligibleEmployee } from "../src/lib/payroll/eligibility.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * WP-4 regression coverage for the payroll eligibility rule and the Payslips Center
 * company-scope guard. The rule answers a BUILD-time question — who belongs in a new
 * batch — and is consumed by the payroll template roster and the automated-payroll
 * recommender. It is deliberately absent from the payroll read views: an existing
 * batch's membership is historical, so filtering it by today's employment removes
 * people who were legitimately paid (see tests/payroll-batch-membership.test.ts).
 * The service and payslip-center modules are env-bound (Supabase admin client), so
 * the pure rule is unit-tested directly and the wiring is locked via source
 * assertions (mirroring tests/vacation-module and tests/workforce-hierarchy-continuity).
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

  // -- Wiring: the eligibility rule belongs to the BUILD path, not the read path.
  //    Applying it to an existing batch is the defect covered by
  //    tests/payroll-batch-membership.test.ts, which asserts its absence here.
  const serviceSource = readFileSync(
    new URL("../src/lib/payroll/service.ts", import.meta.url),
    "utf8",
  );
  const templateRouteSource = readFileSync(
    new URL("../app/api/payroll/template/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    templateRouteSource,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "the new-batch roster must be built from the full roster (including inactive) so a mid-month leaver is still offered for their final pay",
  );
  assert.match(
    templateRouteSource,
    /isTerminalPayrollEmployeeForPeriod\(employee, month, year\)/,
    "the new-batch roster must decide leavers per PERIOD, not by today's status",
  );

  // SELF scope still restricts records to the viewer's own HR_ID (self-only).
  assert.match(
    serviceSource,
    /payrollScope === "SELF"[\s\S]*allowedHrIds: new Set\(\[currentHrId\]\)/,
    "SELF scope must restrict allowed records to the viewer only",
  );
  // Scope is the sole limb of the read filter, so it alone bounds visibility.
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
  // Was `getPayrollScope(access) !== "COMPANY"` — the guard when the page had two answers, company
  // or nothing. The owner opened it to the HR Business Partner on 2026-09-01 with a NAMED audience
  // ("the district managers, the Medicare reps, and herself only"), so the guard now resolves an
  // audience and the readers filter by it. What must still be true is that company-scope payroll
  // access is what produces the COMPANY audience — nothing else may.
  assert.match(
    payslipCenterSource,
    /getPayrollScope\(access\) === "COMPANY"\) return \{ kind: "company" \}/,
    "company-wide payslip sight must still come from getPayrollScope and nothing else",
  );
  assert.match(
    payslipCenterSource,
    /export function resolvePayslipCenterAudience\(/,
    "the payslip audience must be resolved in one exported place the page and the readers share",
  );
  assert.match(
    payslipCenterSource,
    /const audience = assertPayslipCenterAccess\(access\)/,
    "both readers must TAKE the audience from the guard, not just call it for its throw",
  );
  // The boundary is the JS predicate, applied after the query. A `.or()` string is easy to get
  // subtly wrong and this repo has shipped a PostgREST filter that returned everything silently.
  assert.match(
    payslipCenterSource,
    /isPayslipRowVisibleToAudience\(audience, \{ hrId: record\.hr_id, jobTitle: record\.job_title \}\)/,
    "search results must be re-filtered in JavaScript, not trusted to the SQL narrowing alone",
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
  // The picker is one row per person per published month and PostgREST answers at most 1,000 rows
  // however large the limit — 989 rows for 188 people on 20 Oct 2026 — so it must PAGE, or the people
  // at the end of the alphabet silently drop out of it (owner, 2026-10-20).
  const optionsBody = stripComments(
    payslipCenterSource.slice(
      payslipCenterSource.indexOf("export async function getPayslipCenterEmployeeOptions"),
      payslipCenterSource.indexOf("export function escapeLikePattern"),
    ),
  );
  assert.match(
    optionsBody,
    /await fetchAllRows<unknown>\(\(\) => \{[\s\S]*?\}, "id"\);/,
    "the Payslips Center employee picker reads every published row through the paged reader",
  );
  assert.equal(/\.limit\(\d+\)/.test(optionsBody), false, "the picker never relies on a single capped read");
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
