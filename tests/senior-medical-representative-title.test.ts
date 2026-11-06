import assert from "node:assert/strict";

import {
  HR_ADVISORY_COMPENSATION_JOB_TITLES,
  matchesHrAdvisoryCompensationAudience,
  normalizeRole,
  phoenixCompanyJobTitles,
} from "../src/lib/auth/permissions.ts";
import { isAttendanceTrackingEligible } from "../src/lib/attendance/eligibility.ts";
import {
  isFieldWorkforceComplianceEligibleTitle,
  logsOwnCrmVisitsTitle,
} from "../src/lib/field-workforce-compliance/eligibility.ts";
import { isFieldWorkforceWeeklyOff } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import { isExpenseAnalysisRole, resolveJobFunctionRole } from "../src/lib/employees/job-function.ts";
import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import { isMedicalRepJobTitle } from "../src/lib/crm/medical-rep.ts";
import { COMPANY_ROLE_WORKBOOKS } from "../src/lib/hr/job-workbook.ts";
import { positionRules } from "../src/lib/imports/org-rules.ts";
import { resolveStandardSalaryAllowances } from "../src/lib/payroll/allowance-policy.ts";
import { resolveTitleAllowances } from "../src/lib/payroll/salary-autofill.ts";

/**
 * "Senior Medical Representative" — the appreciation grade the owner gave B-7 (Aya Ibrahim) on
 * 2026-09-29. His instruction was explicit: it changes NOTHING about what she does day to day, it is
 * only recognition of good effort — "just add a senior before the rep, no other behaviour change".
 *
 * A promotion that only renames a row is the most dangerous kind of change here, because the title is
 * read by exact-key maps that answer a DEFAULT rather than an error when they miss. Left alone, the
 * "Senior" prefix would have dropped her from job-function classification to the baseline Employee
 * (portal routing, coaching mode, Employee 360), emptied her CRM contact list from the mirror sweep,
 * cut her form allowance to the 1,500 office default, and removed her from attendance, compliance,
 * her own doctor-coverage scope, and the HR Business Partner's pay view.
 *
 * So this pins that the new title behaves EXACTLY like "Medical Representative" everywhere the system
 * asks what she does, while granting nothing new — her access comes from her assigned app role, not
 * from any of these words. It is the medical-rep twin of runSeniorDistrictManagerTitleTests.
 */
export function runSeniorMedicalRepresentativeTitleTests() {
  const SENIOR = "Senior Medical Representative";
  const REP = "Medical Representative";

  // --- 1. The job FUNCTION is identical. This one map feeds attendance/compliance eligibility,
  // portal routing, coaching mode, Employee 360 and own-CRM-visit logging. --------------------
  assert.equal(
    resolveJobFunctionRole(SENIOR),
    resolveJobFunctionRole(REP),
    "a seniority grade is the same job function as the rep title it grades",
  );
  assert.equal(resolveJobFunctionRole(SENIOR), "Medical Rep");
  assert.equal(resolveJobFunctionRole("SENIOR MEDICAL REPRESENTATIVE"), "Medical Rep", "matched case-insensitively, as the data spells titles however it likes");
  assert.equal(isMedicalRepJobTitle(SENIOR), true, "she still belongs on every medical-rep board");
  assert.equal(isExpenseAnalysisRole(SENIOR), false, "a rep does not generate travel oversight spend, senior grade or not — exactly as before");

  // --- 2. And it grants NOTHING new. Provisioning stays least-privilege for the senior grade, the
  // same deliberate choice made for Senior District Manager; her real Medical Rep role is assigned
  // explicitly and untouched by a title. -----------------------------------------------------
  assert.equal(normalizeRole(SENIOR), "Employee", "the title is only a label — it is never parsed into a role");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: SENIOR }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: SENIOR }), "Employee");

  // --- 3. PAY. Both allowance sources — the one payroll reads and the one the employee form fills —
  // must answer the SAME rep figure she already gets, not the 1,500 office default. ------------
  assert.deepEqual(
    resolveStandardSalaryAllowances({ jobTitle: SENIOR }),
    resolveStandardSalaryAllowances({ jobTitle: REP }),
    "the appreciation label must not move one pound of the standard allowances by itself",
  );
  assert.equal(resolveTitleAllowances(SENIOR).extraCostOfLiving, 2000, "the form fills the base payroll then pays on — the rep figure, unchanged");

  // --- 4. Attendance, compliance, own-visit logging and the weekend. --------------------------
  assert.equal(isAttendanceTrackingEligible(SENIOR), true);
  assert.equal(isFieldWorkforceComplianceEligibleTitle(SENIOR), true);
  assert.equal(logsOwnCrmVisitsTitle(SENIOR), true, "a rep logs her own CRM visits, so a no-activity day still reads honestly");
  // 2026-10-03 is a Saturday, 2026-10-02 the Friday before it.
  assert.equal(
    isFieldWorkforceWeeklyOff({ dateIso: "2026-10-03", title: SENIOR }),
    false,
    "Saturday is a working day for the field force, whatever grade sits on the seat",
  );
  assert.equal(isFieldWorkforceWeeklyOff({ dateIso: "2026-10-02", title: SENIOR }), true);

  // --- 6. The HR Business Partner's boundary. A plain rep's pay was visible to her, and a label
  // must not narrow that by accident. --------------------------------------------------------
  assert.ok((HR_ADVISORY_COMPENSATION_JOB_TITLES as readonly string[]).includes(SENIOR));
  assert.equal(matchesHrAdvisoryCompensationAudience({ hrId: "B-7", jobTitle: SENIOR }, "A-99"), true);

  // --- 7. Catalogue and import. A company title with a workbook line, and the import normalizer
  // keeps its own spelling instead of collapsing it back onto "Medical Representative". --------
  assert.ok((phoenixCompanyJobTitles as readonly string[]).includes(SENIOR));
  const workbook = COMPANY_ROLE_WORKBOOKS.find((entry) => entry.jobTitle === SENIOR);
  assert.ok(workbook, "every company job title carries a workbook line");
  assert.equal(workbook?.role, "Medical Rep");
  assert.equal(positionRules.senior_medical_representative, SENIOR);
  assert.notEqual(
    positionRules.senior_medical_representative,
    REP,
    "collapsing it onto the rep title here would let the next employee import demote her back",
  );
}
