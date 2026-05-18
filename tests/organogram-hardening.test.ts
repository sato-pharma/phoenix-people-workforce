import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  applyOrganogramMirrorSafety,
  calculateOrganogramStructureKpis,
  districtBucketMatches,
  publicVacancyLabel,
  type StructureKpiSummary,
} from "../src/lib/reports/organogram-safety.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

function row(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: 10,
    areaName: "Cairo",
    departmentId: 1,
    departmentName: "Sales",
    fullName: "Employee",
    hireDate: "2026-01-01",
    hrId: "E-1",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: "DSM-1",
    managerName: "DSM One",
    positionId: 100,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "active",
    teamId: 20,
    teamName: "New Cairo",
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function vacancy(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return row({
    fullName: "Vacant",
    hireDate: null,
    hrId: "vacancy_1",
    status: "open",
    type: "vacancy",
    vacancyCode: "vacancy_1",
    ...overrides,
  });
}

function expectKpi(
  summary: StructureKpiSummary,
  key: keyof StructureKpiSummary,
  expected: { actual: number; total: number; vacant: number },
) {
  assert.deepEqual(summary[key], expected);
}

export function runOrganogramHardeningTests() {
  const sameAreaTitleDifferentLine = applyOrganogramMirrorSafety([
    vacancy({ hrId: "vacancy_1", lineId: 1, lineName: "Pedia", vacancyCode: "vacancy_1" }),
    vacancy({ hrId: "vacancy_2", lineId: 2, lineName: "CNS", vacancyCode: "vacancy_2" }),
  ]);
  assert.equal(sameAreaTitleDifferentLine.length, 2);

  const sameLineDifferentTeam = applyOrganogramMirrorSafety([
    vacancy({ hrId: "vacancy_3", teamId: 20, teamName: "New Cairo", vacancyCode: "vacancy_3" }),
    vacancy({ hrId: "vacancy_4", teamId: 21, teamName: "Nasr City", vacancyCode: "vacancy_4" }),
  ]);
  assert.equal(sameLineDifferentTeam.length, 2);

  const sameLineTeamDifferentManager = applyOrganogramMirrorSafety([
    vacancy({ hrId: "vacancy_5", managerHrId: "DSM-1", vacancyCode: "vacancy_5" }),
    vacancy({ hrId: "vacancy_6", managerHrId: "DSM-2", vacancyCode: "vacancy_6" }),
  ]);
  assert.equal(sameLineTeamDifferentManager.length, 2);

  const exactFilledSlot = applyOrganogramMirrorSafety([
    row({ hrId: "MR-1" }),
    vacancy({ vacancyCode: "vacancy_7" }),
  ]);
  assert.deepEqual(exactFilledSlot.map((item) => item.type), ["employee"]);

  const missingMetadata = applyOrganogramMirrorSafety([
    row({ hrId: "MR-2" }),
    vacancy({ areaId: null, areaName: null, vacancyCode: "vacancy_8" }),
  ]);
  assert.equal(missingMetadata.filter((item) => item.type === "vacancy").length, 1);

  const resignationVacancy = applyOrganogramMirrorSafety([
    vacancy({
      hrId: "resignation_b-180_20260101000000",
      managerHrId: "NSM-1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      vacancyCode: "resignation_b-180_20260101000000",
    }),
  ]);
  assert.equal(resignationVacancy[0]?.hrId, "VAC-RES-000000");
  assert.equal(publicVacancyLabel("resignation_vac_20260517123456_B180"), "VAC-RES-123456");

  const kpis = calculateOrganogramStructureKpis([
    row({ hrId: "MR-3", positionTitle: "Medical Representative" }),
    vacancy({ vacancyCode: "vacancy_9", positionTitle: "Medical Representative" }),
    row({ hrId: "DSM-3", positionTitle: "District Sales Manager" }),
    vacancy({ vacancyCode: "vacancy_10", positionTitle: "District Sales Manager" }),
    row({ hrId: "NSM-1", positionTitle: "National Sales Manager" }),
  ]);
  expectKpi(kpis, "medicalRep", { actual: 1, total: 2, vacant: 1 });
  expectKpi(kpis, "dsm", { actual: 1, total: 2, vacant: 1 });
  expectKpi(kpis, "nsm", { actual: 1, total: 1, vacant: 0 });
  expectKpi(kpis, "rsm", { actual: 0, total: 0, vacant: 0 });
  expectKpi(kpis, "total", { actual: 3, total: 5, vacant: 2 });

  assert.equal(
    districtBucketMatches(
      row({ areaName: "New Cairo", regionName: "Cairo", teamName: "Nasr City" }),
      vacancy({ areaName: "Cairo", regionName: "Cairo", positionTitle: "District Sales Manager" }),
    ),
    true,
  );
  assert.equal(
    districtBucketMatches(
      row({
        areaId: 99,
        areaName: "Alex Center 1",
        lineName: "Pedia",
        regionName: "Alex",
        teamId: 99,
        teamName: "Alex Center 1",
      }),
      vacancy({ areaName: "Cairo", lineName: "Pedia", positionTitle: "District Sales Manager" }),
    ),
    false,
  );

  const componentSource = readFileSync("src/components/reports/organogram-report.tsx", "utf8");
  assert.match(componentSource, /Reports to NSM/);
  assert.match(componentSource, /childLanes/);
  assert.match(componentSource, /Medical Sales Representatives/);
  assert.match(
    componentSource,
    /if \(assignedToDsm\.has\(key\)\) \{\s*return false;\s*\}/,
    "Organogram DSM lanes must not duplicate the same member or vacancy across multiple manager columns.",
  );
  assert.match(
    componentSource,
    /left\.type === "employee"[\s\S]*\? -1/,
    "Organogram lane assignment must prioritize real employee managers before broad vacant manager slots.",
  );
  assert.match(
    componentSource,
    /const visibleDsmGroups = dsmGroups\.filter\([\s\S]*lane\.members\.length > 0 \|\| lane\.dsm\?\.type !== "vacancy"/,
    "Organogram must not render empty vacant DSM lanes after their vacancies are still counted in structure totals.",
  );
  assert.match(
    componentSource,
    /const directDsmGroups = visibleDsmGroups\.filter/,
    "Organogram direct DSM rendering must use the visible lane set instead of raw vacant manager slots.",
  );
  assert.doesNotMatch(componentSource, /AdminStatCard/);
}
