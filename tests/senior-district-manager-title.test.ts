import assert from "node:assert/strict";

import {
  HR_ADVISORY_COMPENSATION_JOB_TITLES,
  matchesHrAdvisoryCompensationAudience,
  normalizeRole,
  phoenixCompanyJobTitles,
} from "../src/lib/auth/permissions.ts";
import { isAttendanceTrackingEligible } from "../src/lib/attendance/eligibility.ts";
import { isFieldWorkforceComplianceEligibleTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import { isFieldWorkforceWeeklyOff } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import { isExpenseAnalysisRole, resolveJobFunctionRole } from "../src/lib/employees/job-function.ts";
import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import { COMPANY_ROLE_WORKBOOKS } from "../src/lib/hr/job-workbook.ts";
import { positionRules } from "../src/lib/imports/org-rules.ts";
import { resolveStandardSalaryAllowances } from "../src/lib/payroll/allowance-policy.ts";
import { resolveTitleAllowances } from "../src/lib/payroll/salary-autofill.ts";

/**
 * "Senior District Manager" — the seniority grade the owner opened on 2026-09-29 when he promoted
 * B-94 off "District Sales Manager".
 *
 * A promotion that only renames a row is the most dangerous kind of change in this codebase,
 * because the title is read by exact-key maps that answer a DEFAULT rather than an error when they
 * miss. The measured cost of leaving those maps alone was: the extra cost of living falling 3,000
 * to 1,500 with nothing reporting it, the man disappearing from attendance tracking, from the
 * workforce-compliance report, from his own doctor-coverage scope, from the HR Business Partner's
 * payslip list, and from the CRM contact-list sweep.
 *
 * So what this file pins is not the new title — it is that the new title behaves EXACTLY like the
 * old one everywhere the system asks what the man does, while changing nothing about what he is
 * ALLOWED to do, which comes from his assigned app role and not from any of these words.
 */
export function runSeniorDistrictManagerTitleTests() {
  const SENIOR = "Senior District Manager";
  const DSM = "District Sales Manager";

  // --- 1. The job FUNCTION is identical. This one map feeds ~50 call sites — outstation
  // allowance tiers, portal routing, coaching mode, Employee 360, the DM plan chain. -----------
  assert.equal(
    resolveJobFunctionRole(SENIOR),
    resolveJobFunctionRole(DSM),
    "a seniority grade is the same job function as the district seat it grades",
  );
  assert.equal(resolveJobFunctionRole(SENIOR), "District Manager");
  assert.equal(resolveJobFunctionRole("senior district sales manager"), "District Manager");
  assert.equal(resolveJobFunctionRole("SENIOR DISTRICT MANAGER"), "District Manager", "matched case-insensitively, as the data spells titles however it likes");
  assert.equal(isExpenseAnalysisRole(SENIOR), true, "he still travels, so Employee 360 still shows his expenses");

  // --- 2. And yet it grants NOTHING. The two-title field-force provisioning allowlist was
  // deliberately not widened: the owner approved exactly two titles there in 2026-08, and a
  // promotion is not a new hire — B-94 already holds his District Manager role explicitly. ------
  assert.equal(normalizeRole(SENIOR), "Employee", "the most senior-sounding title in the company is still only a label");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: SENIOR }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: SENIOR }), "Employee");

  // --- 3. PAY. Both allowance sources — the one payroll reads and the one the employee form
  // fills — must answer the district figure, not the 1,500 office default. --------------------
  assert.deepEqual(
    resolveStandardSalaryAllowances({ jobTitle: SENIOR }),
    resolveStandardSalaryAllowances({ jobTitle: DSM }),
    "the promotion must not move one pound of the standard allowances by itself",
  );
  assert.equal(resolveStandardSalaryAllowances({ jobTitle: SENIOR }).extraCostOfLiving, 3000);
  assert.equal(resolveTitleAllowances(SENIOR).extraCostOfLiving, 3000, "the form fills the base payroll then pays on");
  // The clause admits the district grades and never a national manager, who is paid 5,000.
  assert.equal(resolveStandardSalaryAllowances({ jobTitle: "National Sales Manager" }).extraCostOfLiving, 5000);

  // --- 4. Attendance, compliance and the weekend. A district manager works Saturday; the
  // deduction weight rides on that, so it is pinned beside the eligibility. --------------------
  assert.equal(isAttendanceTrackingEligible(SENIOR), true);
  assert.equal(isFieldWorkforceComplianceEligibleTitle(SENIOR), true);
  // 2026-10-03 is a Saturday, 2026-10-02 the Friday before it.
  assert.equal(
    isFieldWorkforceWeeklyOff({ dateIso: "2026-10-03", title: SENIOR }),
    false,
    "Saturday is a working day for the district, whatever grade sits on the seat",
  );
  assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-10-02", title: SENIOR }), true);

  // --- 6. The HR Business Partner's boundary. His pay was visible to her the day before the
  // promotion, and the owner's 2026-09-01 sentence named the seat, not the spelling. -----------
  assert.ok((HR_ADVISORY_COMPENSATION_JOB_TITLES as readonly string[]).includes(SENIOR));
  assert.equal(matchesHrAdvisoryCompensationAudience({ hrId: "B-94", jobTitle: SENIOR }, "A-99"), true);
  assert.equal(
    matchesHrAdvisoryCompensationAudience({ hrId: "X-1", jobTitle: "Regional Sales Manager" }, "A-99"),
    false,
    "and the list is still exact-after-lowercasing — a regional manager is never admitted",
  );

  // --- 7. Catalogue and import. The title is a company title with a workbook line, and the
  // import normalizer keeps its own spelling instead of collapsing it back onto the DSM name. --
  assert.ok((phoenixCompanyJobTitles as readonly string[]).includes(SENIOR));
  const workbook = COMPANY_ROLE_WORKBOOKS.find((entry) => entry.jobTitle === SENIOR);
  assert.ok(workbook, "every company job title carries a workbook line");
  assert.equal(workbook?.role, "District Manager");
  assert.equal(positionRules.senior_district_manager, SENIOR);
  assert.notEqual(
    positionRules.senior_district_manager,
    DSM,
    "collapsing it onto the district title here would let the next employee import demote him back",
  );
}
