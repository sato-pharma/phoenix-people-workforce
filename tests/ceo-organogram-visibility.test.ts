import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  canAccessCompanyOrganogram,
  scopeOrganogramReportData,
} from "../src/lib/reports/organogram.ts";
import type {
  OrganogramReportRow,
  VacancyReportData,
} from "../src/lib/reports/vacancies.ts";

// Compile-time guard: the Organogram is the CEO's intended company people-view.
// The CEO is deliberately barred from the salary-bearing employee master (see
// phase22-role-matrix-security.test.ts: "CEO must not see the employee master"),
// so the Organogram must stay STRUCTURAL ONLY — never compensation or HR PII.
// If anyone adds a sensitive field to OrganogramReportRow, this fails typecheck.
type ForbiddenOrganogramField =
  | "salary"
  | "baseSalary"
  | "basicSalary"
  | "grossSalary"
  | "netSalary"
  | "bankAccount"
  | "bankName"
  | "socialInsurance"
  | "medicalInsurance"
  | "nationalId"
  | "birthDate";
type OrganogramHasNoPii = Extract<
  keyof OrganogramReportRow,
  ForbiddenOrganogramField
> extends never
  ? true
  : never;
const organogramHasNoPii: OrganogramHasNoPii = true;

function organogramRow(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: null,
    areaName: "Greater Cairo",
    departmentId: null,
    departmentName: "Commercial",
    displayName: "Employee",
    fullName: "Employee",
    hireDate: "2022-01-01",
    hrId: "EMP-1",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti infective",
    managerHrId: "DSM-1",
    managerName: "District Manager",
    positionId: null,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: "Team A",
    type: "employee",
    ...overrides,
  };
}

export function runCeoOrganogramVisibilityTests() {
  // Reference the compile-time PII guard so it isn't flagged as unused.
  assert.equal(organogramHasNoPii, true);

  const ceo = createAccessContext({ hrId: "CEO-1", role: "CEO" });
  const superAdmin = createAccessContext({ hrId: "SA-1", role: "Super Admin" });
  const medicalRep = createAccessContext({ hrId: "MR-1", role: "Medical Rep" });
  const districtManager = createAccessContext({ hrId: "DSM-1", role: "District Manager" });

  // 1) The CEO reaches the company-wide organogram (their intended people view),
  //    alongside Super Admin. Line/field roles do not get company scope.
  assert.equal(canAccessCompanyOrganogram(ceo), true, "CEO must reach the company organogram");
  assert.equal(
    canAccessCompanyOrganogram(superAdmin),
    true,
    "Super Admin reaches the company organogram",
  );
  assert.equal(
    canAccessCompanyOrganogram(medicalRep),
    false,
    "Medical Rep has no company organogram",
  );
  assert.equal(
    canAccessCompanyOrganogram(districtManager),
    false,
    "District Manager has no company organogram",
  );

  // Training Manager and Marketing Manager get company-wide (all 3 commercial lines)
  // organogram oversight — regression guard for the employee-portal redirect bug where
  // the page checked only isLineScopedOrganogramRole() and never consulted this function.
  const trainingManager = createAccessContext({ hrId: "A-7", role: "Training Manager" });
  const marketingManager = createAccessContext({ hrId: "MM-1", role: "Marketing Manager" });
  assert.equal(
    canAccessCompanyOrganogram(trainingManager),
    true,
    "Training Manager must reach the company organogram",
  );
  assert.equal(
    canAccessCompanyOrganogram(marketingManager),
    true,
    "Marketing Manager must reach the company organogram",
  );

  // 2) Company mode must NOT be row-filtered down to the viewer. A CEO must see
  //    the WHOLE company structure, not just themselves — this guards against the
  //    employee-directory-style self-only filtering ever being copied here.
  const company: VacancyReportData = {
    organogramRows: [
      organogramRow({ hrId: "CEO-1", fullName: "Chief Exec", jobTitle: "CEO", positionTitle: "CEO", managerHrId: null }),
      organogramRow({ hrId: "MR-2", fullName: "Rep Two" }),
      organogramRow({ hrId: "MR-3", fullName: "Rep Three", managerHrId: "DSM-9" }),
    ],
    rows: [],
    summary: {
      areasAffected: 0,
      linesAffected: 0,
      openVacancies: 0,
      positionsAffected: 0,
      totalVacancies: 0,
    },
  };

  const scoped = scopeOrganogramReportData(company, { mode: "company" });
  const scopedHrIds = scoped.organogramRows.map((row) => row.hrId).sort();
  assert.deepEqual(
    scopedHrIds,
    ["CEO-1", "MR-2", "MR-3"],
    "company organogram must retain every employee row (no self-only filtering)",
  );
  assert.equal(
    scoped.organogramRows.length,
    3,
    "company organogram must not drop employees for a company-scope viewer",
  );
}
