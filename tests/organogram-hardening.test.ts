import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyOrganogramMirrorSafety,
  calculateOrganogramStructureKpis,
  findOrganogramDiagnostics,
  scopeOrganogramReportForAccess,
} from "../src/lib/reports/organogram-safety.ts";
import type { VacancyReportData } from "../src/lib/reports/vacancies.ts";

type OrganogramRow = VacancyReportData["organogramRows"][number];
type VacancyRow = VacancyReportData["rows"][number];

const organogramRouteSource = readFileSync(
  new URL("../app/api/reports/organogram/route.ts", import.meta.url),
  "utf8",
);
const vacancyRouteSource = readFileSync(
  new URL("../app/api/reports/vacancies/route.ts", import.meta.url),
  "utf8",
);
const organogramComponentSource = readFileSync(
  new URL("../src/components/reports/organogram-report.tsx", import.meta.url),
  "utf8",
);

function employee(overrides: Partial<OrganogramRow>): OrganogramRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: 1,
    departmentName: "Sales",
    fullName: "Employee",
    hireDate: "2020-01-01",
    hrId: "EMP-1",
    jobTitle: "Medical Representative",
    lineId: 10,
    lineName: "Pedia",
    managerHrId: "NSM-1",
    managerName: "Pedia NSM",
    positionId: 100,
    positionTitle: "Medical Representative",
    regionName: null,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function vacancyOrg(overrides: Partial<OrganogramRow>): OrganogramRow {
  return {
    ...employee({
      fullName: "Vacant",
      hireDate: null,
      hrId: "VAC-1",
      sourceRowNumber: 1,
      status: "open",
      type: "vacancy",
      vacancyCode: "vacancy_1",
    }),
    ...overrides,
    fullName: overrides.fullName ?? "Vacant",
    hireDate: null,
    status: overrides.status ?? "open",
    type: "vacancy",
  };
}

function vacancyRow(overrides: Partial<VacancyRow>): VacancyRow {
  return {
    areaId: 20,
    areaName: "Nasr City",
    createdAt: "2026-01-01",
    departmentId: 1,
    departmentName: "Sales",
    id: 1,
    jobTitle: "Medical Representative",
    lineId: 10,
    lineName: "Pedia",
    managerHrId: "NSM-1",
    managerName: "Pedia NSM",
    note: null,
    positionId: 100,
    positionTitle: "Medical Representative",
    regionName: null,
    sourceRowNumber: 1,
    status: "open",
    teamId: null,
    teamName: null,
    vacancyCode: "vacancy_1",
    ...overrides,
  };
}

function report(
  organogramRows: OrganogramRow[],
  rows: VacancyRow[] = organogramRows
    .filter((row) => row.type === "vacancy")
    .map((row, index) =>
      vacancyRow({
        areaId: row.areaId,
        areaName: row.areaName,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        id: index + 1,
        jobTitle: row.jobTitle,
        lineId: row.lineId,
        lineName: row.lineName,
        managerHrId: row.managerHrId,
        managerName: row.managerName,
        positionId: row.positionId,
        positionTitle: row.positionTitle,
        sourceRowNumber: row.sourceRowNumber,
        status: row.status,
        teamId: row.teamId,
        teamName: row.teamName,
        vacancyCode: row.vacancyCode ?? `vacancy_${index + 1}`,
      }),
    ),
): VacancyReportData {
  return {
    organogramRows,
    rows,
    summary: {
      areasAffected: 0,
      linesAffected: 0,
      openVacancies: 0,
      positionsAffected: 0,
      totalVacancies: 0,
    },
  };
}

function visibleVacancies(data: VacancyReportData) {
  return data.organogramRows.filter((row) => row.type === "vacancy");
}

const leadership = [
  employee({
    areaId: null,
    areaName: null,
    departmentId: 3,
    departmentName: "Executive",
    fullName: "Chief Executive",
    hrId: "AA",
    jobTitle: "CEO",
    lineId: 30,
    lineName: "Office",
    managerHrId: null,
    managerName: null,
    positionId: 300,
    positionTitle: "CEO",
  }),
  employee({
    areaId: null,
    areaName: null,
    fullName: "Pedia NSM",
    hrId: "NSM-1",
    jobTitle: "National Sales Manager",
    managerHrId: "AA",
    positionId: 110,
    positionTitle: "National Sales Manager",
  }),
];

const baseReport = report([
  ...leadership,
  employee({
    areaId: 20,
    areaName: "Nasr City",
    fullName: "Active Rep",
    hrId: "REP-1",
  }),
  employee({
    areaId: 20,
    areaName: "Nasr City",
    fullName: "Former Rep",
    hrId: "REP-OLD",
    status: "resigned",
  }),
  vacancyOrg({
    areaId: 21,
    areaName: "Heliopolis",
    hrId: "REP-2",
    sourceRowNumber: 12,
    vacancyCode: "resignation_rep-2_20260101000000",
  }),
  vacancyOrg({
    areaId: 20,
    areaName: "Nasr City",
    hrId: "REP-1",
    sourceRowNumber: 13,
    vacancyCode: "vacancy_13",
  }),
]);

export function runOrganogramHardeningTests() {
  assert.match(
    organogramRouteSource,
    /assertPermission\(access,\s*"organogram",\s*"read"\)/,
    "Organogram refresh API must enforce organogram:read",
  );
  assert.match(
    organogramComponentSource,
    /fetch\("\/api\/reports\/organogram"/,
    "Organogram client refresh must use the Organogram API",
  );
  assert.match(
    vacancyRouteSource,
    /vacancyReportWithoutOrganogramRows/,
    "Vacancy API must not expose Organogram hierarchy rows",
  );

  const safeReport = applyOrganogramMirrorSafety(baseReport);
  assert.equal(
    safeReport.organogramRows.some((row) => row.hrId === "REP-1" && row.type === "employee"),
    true,
    "active employees remain visible",
  );
  assert.equal(
    safeReport.organogramRows.some((row) => row.hrId === "REP-OLD"),
    false,
    "resigned employees are removed from active Organogram rows",
  );
  assert.equal(
    safeReport.organogramRows.some((row) => row.type === "vacancy" && row.areaName === "Heliopolis"),
    true,
    "valid resignation vacancies remain visible",
  );
  assert.equal(
    safeReport.organogramRows.some((row) => row.type === "vacancy" && row.areaName === "Nasr City"),
    false,
    "exact same filled slot is not duplicated beside an active employee",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-PEDIA", lineId: 10, lineName: "Pedia" }),
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-CNS", lineId: 11, lineName: "CNS", vacancyCode: "vacancy_cns" }),
        ]),
      ),
    ).length,
    2,
    "same area and title in different lines remain visible",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-T1", teamId: 1, teamName: "Team A" }),
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-T2", teamId: 2, teamName: "Team B", vacancyCode: "vacancy_t2" }),
        ]),
      ),
    ).length,
    2,
    "same area, title, and line in different teams remain visible",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-M1", managerHrId: "DSM-1", teamId: 1, teamName: "Team A" }),
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-M2", managerHrId: "DSM-2", managerName: "Other DSM", teamId: 1, teamName: "Team A", vacancyCode: "vacancy_m2" }),
        ]),
      ),
    ).length,
    2,
    "same area, title, line, and team under different managers remain visible",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          employee({ areaId: 20, areaName: "Nasr City", hrId: "REP-FILLED", teamId: 1, teamName: "Team A" }),
          vacancyOrg({ areaId: 20, areaName: "Nasr City", hrId: "VAC-FILLED", teamId: 1, teamName: "Team A" }),
        ]),
      ),
    ).length,
    0,
    "exact same slot with an active employee suppresses the vacancy",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          employee({ areaId: 20, areaName: "Nasr City", hrId: "REP-MISSING" }),
          vacancyOrg({ areaId: null, areaName: null, hrId: "VAC-MISSING", vacancyCode: "vacancy_missing" }),
        ]),
      ),
    ).length,
    1,
    "missing slot metadata preserves the vacancy instead of hiding it aggressively",
  );

  assert.equal(
    visibleVacancies(
      applyOrganogramMirrorSafety(
        report([
          employee({ areaId: 20, areaName: "Nasr City", hrId: "REP-ACTIVE", teamId: 1, teamName: "Team A" }),
          vacancyOrg({
            areaId: 20,
            areaName: "Nasr City",
            hrId: "REP-RESIGNED",
            teamId: 2,
            teamName: "Team B",
            vacancyCode: "resignation_rep-resigned_20260101000000",
          }),
        ]),
      ),
    ).length,
    1,
    "resignation-created vacancy remains visible until the exact slot is filled",
  );

  const scoped = scopeOrganogramReportForAccess(
    baseReport,
    {
      hrId: "NSM-1",
      role: "National Sales Manager",
      scope: "line",
      source: "session",
    },
  );
  assert.equal(
    scoped.organogramRows.every((row) => row.lineName === "Pedia" || row.hrId === "AA"),
    true,
    "line-scoped Organogram users only receive their line plus leadership chain",
  );

  const diagnostics = findOrganogramDiagnostics([
    ...safeReport.organogramRows,
    employee({ fullName: "Self Manager", hrId: "SELF-1", managerHrId: "SELF-1" }),
    employee({ fullName: "Cycle A", hrId: "CYCLE-A", managerHrId: "CYCLE-B" }),
    employee({ fullName: "Cycle B", hrId: "CYCLE-B", managerHrId: "CYCLE-A" }),
    employee({ fullName: "Missing Manager", hrId: "MISSING-1", managerHrId: "NO-MANAGER" }),
  ]);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "self_manager"),
    true,
    "self-manager links are diagnosed",
  );
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "circular_manager"),
    true,
    "circular manager links are diagnosed",
  );
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.code === "missing_manager"),
    true,
    "missing or inactive managers are diagnosed",
  );

  assert.doesNotMatch(
    organogramComponentSource,
    /gridTemplateColumns:\s*`repeat\(\$\{laneCount\}, minmax\(0, 1fr\)\)`/,
    "Organogram must not compress manager lanes into zero-width columns on mobile",
  );
  assert.match(
    organogramComponentSource,
    /overflow-x-auto/,
    "Organogram manager lanes must remain horizontally readable on small screens",
  );
  assert.match(
    organogramComponentSource,
    /function isOrganogramVisibleRow[\s\S]*isVacancyRow\(row\)/,
    "Organogram display filtering must keep vacancy rows even when department metadata is incomplete",
  );
  assert.match(
    organogramComponentSource,
    /row\.lineName === effectiveLineFilter &&\s*\(\s*isVacancyRow\(row\) \|\| isSalesDepartment\(row\)\s*\)/,
    "Line filtering must keep vacancies in the selected line instead of requiring Sales department metadata",
  );
  assert.match(
    organogramComponentSource,
    /function reportsToDsmGroup/,
    "DSM lane assignment must use an explicit helper for defensive vacancy matching",
  );
  assert.match(
    organogramComponentSource,
    /row\.type === "vacancy"[\s\S]*dsmNameKeysForGroup\.has\(managerNameKey\)/,
    "Vacancies with a bad or missing manager HR_ID must still render under the matching DSM name",
  );

  const kpis = calculateOrganogramStructureKpis([
    employee({ fullName: "CEO Placeholder", hrId: "CEO-1", jobTitle: "CEO", positionTitle: "CEO" }),
    employee({ fullName: "Line Placeholder", hrId: "LINE-1", jobTitle: "Line", positionTitle: "Line" }),
    employee({ fullName: "Actual MR", hrId: "MR-1", jobTitle: "Medical Representative", positionTitle: "Medical Representative" }),
    vacancyOrg({ hrId: "VAC-MR", jobTitle: "Medical Representative", positionTitle: "Medical Representative" }),
    employee({ fullName: "Actual DSM", hrId: "DSM-1", jobTitle: "District Sales Manager", positionTitle: "District Sales Manager" }),
    vacancyOrg({ hrId: "VAC-DSM", jobTitle: "DSM", positionTitle: "DSM", vacancyCode: "vacancy_dsm" }),
    employee({ fullName: "Actual NSM", hrId: "NSM-KPI", jobTitle: "National Sales Manager", positionTitle: "National Sales Manager" }),
    vacancyOrg({ hrId: "VAC-NSM", jobTitle: "NSM", positionTitle: "NSM", vacancyCode: "vacancy_nsm" }),
  ]);
  assert.deepEqual(
    kpis.medicalReps,
    { actual: 1, total: 2, vacant: 1 },
    "Medical Rep KPI must split actual employees and vacant boxes",
  );
  assert.deepEqual(
    kpis.dsms,
    { actual: 1, total: 2, vacant: 1 },
    "DSM KPI must split actual employees and vacant boxes",
  );
  assert.deepEqual(
    kpis.nsms,
    { actual: 1, total: 2, vacant: 1 },
    "NSM KPI must split actual employees and vacant boxes",
  );
  assert.deepEqual(
    kpis.rsms,
    { actual: 0, total: 0, vacant: 0 },
    "RSM KPI zero state must show 0/0/0 when no RSM rows exist",
  );
  assert.deepEqual(
    kpis.totalLineStructure,
    { actual: 3, total: 6, vacant: 3 },
    "Total Line Structure must equal the sum of MR, DSM, NSM, and RSM categories only",
  );
  assert.match(
    organogramComponentSource,
    /calculateOrganogramStructureKpis\(rows\)/,
    "KPI cards must calculate from currently rendered Organogram rows",
  );
  assert.doesNotMatch(
    organogramComponentSource,
    /label="Employees"[\s\S]*label="Vacancies"[\s\S]*label="Rows"/,
    "Generic Employees/Vacancies/Rows KPI cards must not remain in Organogram",
  );
}
