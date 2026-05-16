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
const vacancyReportSource = readFileSync(
  new URL("../src/lib/reports/vacancies.ts", import.meta.url),
  "utf8",
);
const resignationServiceSource = readFileSync(
  new URL("../src/lib/resignations/service.ts", import.meta.url),
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
  assert.match(
    vacancyReportSource,
    /getEmployeeDirectory\(\{ pageSize: -1 \}\)/,
    "Organogram report must load the full employee directory instead of a paginated slice",
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
          vacancyOrg({
            areaId: 20,
            areaName: "Nasr City",
            hrId: "VAC-DSM-1",
            jobTitle: "District Sales Manager",
            managerHrId: "NSM-1",
            positionTitle: "District Sales Manager",
            vacancyCode: "resignation_dsm-old_20260101000000",
          }),
          vacancyOrg({
            areaId: 20,
            areaName: "Nasr City",
            hrId: "VAC-DSM-2",
            jobTitle: "District Sales Manager",
            managerHrId: "NSM-1",
            positionTitle: "District Sales Manager",
            vacancyCode: "vacancy_dsm_duplicate",
          }),
        ]),
      ),
    ).length,
    1,
    "exact duplicate open vacancies for the same DSM slot render once in Organogram",
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
  const sanitizedResignationReport = applyOrganogramMirrorSafety(
    report([
      vacancyOrg({
        areaId: 20,
        areaName: "Nasr City",
        hrId: "B-180",
        vacancyCode: "resignation_b-180_20260101000000",
      }),
    ]),
  );
  assert.equal(
    visibleVacancies(sanitizedResignationReport)[0]?.hrId,
    "VAC-RES-000000",
    "legacy resignation vacancies must not display the resigned employee HR_ID as the Organogram card ID",
  );
  assert.equal(
    sanitizedResignationReport.rows[0]?.vacancyCode,
    "VAC-RES-000000",
    "Organogram vacancy payload must not expose legacy resignation vacancy codes containing HR_ID",
  );
  assert.match(
    vacancyReportSource,
    /VAC-RES-/,
    "resignation-created Organogram vacancies must display generated vacancy labels",
  );
  assert.doesNotMatch(
    vacancyReportSource,
    /return\s+resignationMatch(?:\?\.)?\[1\]\.toUpperCase\(\)/,
    "resignation-created Organogram vacancies must not display the resigned employee HR_ID",
  );
  assert.match(
    resignationServiceSource,
    /resignation_vac_\$\{stamp\}_\$\{suffix\}/,
    "new resignation vacancy codes must be generated without embedding the resigned employee HR_ID",
  );
  assert.doesNotMatch(
    resignationServiceSource,
    /resignation_\$\{hrId\}_\$\{stamp\}/,
    "resignation vacancy code generation must not embed the resigned employee HR_ID",
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
    employee({ fullName: "Missing Manager", hrId: "MISSING-1", managerHrId: "NO-MANAGER", managerName: null }),
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

  const nameFallbackDiagnostics = findOrganogramDiagnostics([
    employee({
      fullName: "Pedia NSM",
      hrId: "NSM-1",
      jobTitle: "National Sales Manager",
      managerHrId: null,
      managerName: null,
      positionTitle: "National Sales Manager",
    }),
    employee({
      fullName: "Pedia RSM",
      hrId: "RSM-1",
      jobTitle: "Regional Sales Manager",
      managerHrId: "NSM-1",
      managerName: "Pedia NSM",
      positionTitle: "Regional Sales Manager",
    }),
    employee({
      fullName: "Pedia DSM",
      hrId: "DSM-NAME",
      jobTitle: "District Sales Manager",
      managerHrId: null,
      managerName: "Pedia RSM",
      positionTitle: "District Sales Manager",
    }),
  ]);
  assert.equal(
    nameFallbackDiagnostics.some((diagnostic) => diagnostic.code === "missing_manager"),
    false,
    "managerName fallback must not flag a valid visible manager chain as missing",
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
    /row\.lineName === effectiveLineFilter &&\s*\(\s*isVacancyRow\(row\) \|\| isSalesDepartment\(row\) \|\| isSalesStructureRole\(row\)\s*\)/,
    "Line filtering must keep vacancies in the selected line instead of requiring Sales department metadata",
  );
  assert.match(
    organogramComponentSource,
    /function reportsToManagerGroup/,
    "Manager lane assignment must use an explicit helper for defensive vacancy matching",
  );
  assert.match(
    organogramComponentSource,
    /function findManagerRow\(/,
    "Organogram hierarchy resolution must expose a shared manager row resolver",
  );
  assert.match(
    organogramComponentSource,
    /row\.type === "vacancy"[\s\S]*managerNameKeysForGroup\.has\(managerNameKey\)/,
    "Vacancies with a bad or missing manager HR_ID must still render under the matching DSM name",
  );
  assert.match(
    organogramComponentSource,
    /currentManagerName = row\.managerName \?\? null[\s\S]*findManagerRow\(rows, managerHrId, currentManagerName\)/,
    "Recursive hierarchy traversal must fall back to managerName when manager_hr_id is stale",
  );
  assert.match(
    organogramComponentSource,
    /const managerNameKey = normalizeNameKey\(member\.managerName\)[\s\S]*nodes\.find\(\(candidate\) => normalizeNameKey\(candidate\.row\.fullName\) === managerNameKey\)/,
    "Nested team rendering must attach children by manager name when manager_hr_id is missing",
  );
  assert.match(
    organogramComponentSource,
    /function reportsToVacantManagerSlot/,
    "DSM vacancies must have a context-aware fallback for teams whose old manager link is missing or stale",
  );
  assert.match(
    organogramComponentSource,
    /contextMatches\(row\.lineId, row\.lineName, vacantManager\.lineId, vacantManager\.lineName\)/,
    "DSM vacancy fallback must always require the same line",
  );
  assert.match(
    organogramComponentSource,
    /contextMatches\(row\.areaId, row\.areaName, vacantManager\.areaId, vacantManager\.areaName\)/,
    "DSM vacancy fallback must use area context before attaching team rows",
  );
  assert.match(
    organogramComponentSource,
    /function districtBucketMatches/,
    "DSM vacancy fallback must support district bucket matching for Cairo-style structures",
  );
  assert.match(
    organogramComponentSource,
    /isDistrictBucketLabel\(vacantManager\.areaName\)[\s\S]*districtBucketKey\(vacantManager\.areaName\)/,
    "DSM vacancy district fallback must only treat broad area labels like Cairo as buckets",
  );
  assert.match(
    organogramComponentSource,
    /districtBucketKey\(row\.regionName\)[\s\S]*districtBucketKey\(row\.areaName\)[\s\S]*districtBucketKey\(row\.teamName\)/,
    "Cairo medical reps must match a Cairo vacant DSM through region, area, or team context",
  );
  assert.match(
    organogramComponentSource,
    /!reportsToKnownManager\(row, dsmHrIds, dsmNameKeys\)[\s\S]*reportsToVacantManagerSlot\(row, primaryDsm\)/,
    "DSM vacancy fallback must not steal rows that already report to a known visible manager",
  );
  assert.match(
    organogramComponentSource,
    /region: primaryDsm\.regionName \?\? primaryDsm\.areaName/,
    "DSM vacancy lanes should show area context when region metadata is missing",
  );
  assert.match(
    organogramComponentSource,
    /const rsmGroups: ManagerLane\[\]/,
    "RSMs must render as explicit manager lanes, not be flattened into DSM lanes",
  );
  assert.match(
    organogramComponentSource,
    /level: "rsm"/,
    "RSM lanes must carry their own hierarchy level for distinct rendering",
  );
  assert.match(
    organogramComponentSource,
    /Reports to NSM:/,
    "RSM lanes must visibly show that they report to the NSM",
  );
  assert.match(
    organogramComponentSource,
    /childLanes: ManagerLane\[\][\s\S]*reportsToVacantManagerSlot\(row, primaryDsm\)/,
    "Medical reps must stay under vacant DSM slots even when those DSM slots report to an RSM",
  );
  assert.match(
    organogramComponentSource,
    /group\.level === "rsm" && childLanes\.length > 0[\s\S]*gridColumn: `span \$\{Math\.max\(childLanes\.length, 1\)\}`/,
    "RSM lanes must span their DSM child columns instead of rendering as a flat DSM lane",
  );
  assert.match(
    organogramComponentSource,
    /const vacancyCountForLane = \(group: ManagerLane\): number[\s\S]*group\.childLanes \?\? \[\][\s\S]*vacancyCountForLane\(child\)/,
    "RSM vacancy counters must aggregate vacancies from reporting DSM child lanes",
  );
  assert.match(
    organogramComponentSource,
    /const groupVacancies = vacancyCountForLane\(group\)/,
    "Manager lane vacancy labels must use the aggregated lane vacancy counter",
  );
  assert.match(
    organogramComponentSource,
    /canUseVacantManagerFallback[\s\S]*!isDistrictSalesManager\(member\)/,
    "Vacant manager fallback must not nest DSM managers under other vacant DSM cards",
  );
  assert.match(
    organogramComponentSource,
    /isVacancyRow\(row\) \|\| isSalesDepartment\(row\) \|\| isSalesStructureRole\(row\)/,
    "Line filtering must keep sales structure employees even when department metadata is incomplete",
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
  assert.match(
    organogramComponentSource,
    /Medical Sales Representatives/,
    "KPI cards must use the full enterprise role title",
  );
  assert.match(
    organogramComponentSource,
    /Actual \/ Total Structure/,
    "KPI cards must show actual against total structure in one compact block",
  );
  assert.match(
    organogramComponentSource,
    /Completion/,
    "KPI cards must include a completion bar label",
  );
  assert.doesNotMatch(
    organogramComponentSource,
    /bg-sky-500|bg-violet-500|bg-emerald-500|from-sky-500|from-violet-500|from-emerald-500/,
    "Organogram KPI cards must stay on the Phoenix orange/slate page palette",
  );
}
