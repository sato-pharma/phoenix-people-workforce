import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";

import {
  applyOrganogramMirrorSafety,
  calculateOrganogramStructureKpis,
  districtBucketMatches,
  publicVacancyLabel,
  type StructureKpiSummary,
} from "../src/lib/reports/organogram-safety.ts";
import { scopeOrganogramReportData } from "../src/lib/reports/organogram.ts";
import { buildOrganogramLanes } from "../src/lib/reports/organogram-view-model.ts";
import type { OrganogramReportRow, VacancyReportData } from "../src/lib/reports/vacancies.ts";

function row(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: 10,
    areaName: "Cairo",
    departmentId: 1,
    departmentName: "Sales",
    displayName: "Employee",
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

  // Two distinct AREA seats under the same manager both render (each area is its
  // own fixed seat). Real rep areas are always specific names, so distinct seats
  // are distinguished by area, not by team within one broad area.
  const sameLineDifferentArea = applyOrganogramMirrorSafety([
    vacancy({ hrId: "vacancy_3", areaName: "Nasr City", teamId: 20, teamName: "New Cairo", vacancyCode: "vacancy_3" }),
    vacancy({ hrId: "vacancy_4", areaName: "Heliopolis", teamId: 21, teamName: "Nasr City", vacancyCode: "vacancy_4" }),
  ]);
  assert.equal(sameLineDifferentArea.length, 2);

  const sameCairoDsmAcrossChildAreas = applyOrganogramMirrorSafety([
    vacancy({
      areaId: 101,
      areaName: "Cairo East 1",
      hrId: "vacancy_dsm_1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: 20,
      teamName: "Nasr City",
      vacancyCode: "vacancy_dsm_1",
    }),
    vacancy({
      areaId: 102,
      areaName: "Cairo East 2",
      hrId: "vacancy_dsm_2",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: 21,
      teamName: "Heliopolis",
      vacancyCode: "vacancy_dsm_2",
    }),
  ]);
  assert.equal(sameCairoDsmAcrossChildAreas.length, 2);

  const sameLineTeamDifferentManager = applyOrganogramMirrorSafety([
    vacancy({ hrId: "vacancy_5", managerHrId: "DSM-1", vacancyCode: "vacancy_5" }),
    vacancy({ hrId: "vacancy_6", managerHrId: "DSM-2", vacancyCode: "vacancy_6" }),
  ]);
  assert.equal(sameLineTeamDifferentManager.length, 2);

  // Occupancy-truth model: a Medical-Rep area is one fixed seat. An active rep
  // on the SAME (manager, area, line) fills that seat, so a same-seat vacancy
  // record is stale and collapses into the active rep (one rep suppresses one
  // same-seat vacancy).
  const activeRepFillsItsAreaSeat = applyOrganogramMirrorSafety([
    row({ hrId: "MR-1" }),
    vacancy({ vacancyCode: "vacancy_7" }),
  ]);
  assert.deepEqual(activeRepFillsItsAreaSeat.map((item) => item.type), ["employee"]);

  // ...but a rep in one area never hides a vacancy in a DIFFERENT area under the
  // same manager — each area is its own fixed seat.
  const activeRepDoesNotHideOtherAreaVacancy = applyOrganogramMirrorSafety([
    row({ hrId: "MR-HELIO-ACTIVE", areaName: "Heliopolis", regionName: "Cairo", teamName: null }),
    vacancy({
      areaName: "Nasr City",
      regionName: "Cairo",
      teamName: null,
      hrId: "vacancy_nasr_city",
      vacancyCode: "vacancy_nasr_city",
    }),
  ]);
  assert.deepEqual(
    activeRepDoesNotHideOtherAreaVacancy.map((item) => item.type),
    ["employee", "vacancy"],
  );

  // An active rep fills its area seat, so EVERY stale same-seat vacancy record is
  // hidden (an occupied seat shows no vacant box, no matter how many duplicate
  // records exist for it).
  const activeRepHidesAllSameSeatVacancies = applyOrganogramMirrorSafety([
    row({ hrId: "MR-CAIRO-1", areaName: "Cairo", regionName: "Cairo", teamName: "New Cairo" }),
    vacancy({
      areaName: "Cairo",
      hrId: "vacancy_mr_cairo_1",
      regionName: "Cairo",
      teamName: "New Cairo",
      vacancyCode: "vacancy_mr_cairo_1",
    }),
    vacancy({
      areaName: "Cairo",
      hrId: "vacancy_mr_cairo_2",
      regionName: "Cairo",
      teamName: "New Cairo",
      vacancyCode: "vacancy_mr_cairo_2",
    }),
  ]);
  assert.equal(activeRepHidesAllSameSeatVacancies.filter((item) => item.type === "vacancy").length, 0);

  const filledDsmSlotSuppressesManagerVacancy = applyOrganogramMirrorSafety([
    row({
      hrId: "DSM-FILLED",
      jobTitle: "District Sales Manager",
      positionId: 200,
      positionTitle: "District Sales Manager",
    }),
    vacancy({
      hrId: "vacancy_dsm_filled",
      jobTitle: "District Sales Manager",
      positionId: 200,
      positionTitle: "District Sales Manager",
      vacancyCode: "vacancy_dsm_filled",
    }),
  ]);
  assert.deepEqual(
    filledDsmSlotSuppressesManagerVacancy.map((item) => item.type),
    ["employee"],
  );

  // An active Cairo DSM fills the Cairo DSM seat, so a stale Cairo DSM vacancy
  // record (even one with no team context and a "filled"-era status) is hidden —
  // occupancy is the truth. Each DSM owns a distinct area, so area alone
  // identifies the seat; no phantom "second Cairo DSM" is shown next to the hire.
  const activeCairoDsmSuppressesStaleCairoDsmVacancy = applyOrganogramMirrorSafety([
    row({
      areaId: null,
      areaName: "Cairo",
      hrId: "DSM-CAIRO-ACTIVE",
      jobTitle: "District Sales Manager",
      managerHrId: "NSM-1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: 49,
      teamName: "Cairo",
    }),
    vacancy({
      areaId: null,
      areaName: "Cairo",
      hrId: "vacancy_dsm_cairo",
      jobTitle: "District Sales Manager",
      managerHrId: "NSM-1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: null,
      teamName: null,
      vacancyCode: "vacancy_dsm_cairo",
    }),
  ]);
  assert.deepEqual(
    activeCairoDsmSuppressesStaleCairoDsmVacancy.map((item) => item.type),
    ["employee"],
  );

  const missingMetadata = applyOrganogramMirrorSafety([
    row({ hrId: "MR-2" }),
    vacancy({ areaId: null, areaName: null, vacancyCode: "vacancy_8" }),
  ]);
  assert.equal(missingMetadata.filter((item) => item.type === "vacancy").length, 1);

  // Root-cause fix: a resigned rep's area is a FIXED seat and must stay visible
  // as vacant even though its stale vacancy record wrongly says status="filled".
  // Occupancy — not the mutable status field — decides. Nobody active occupies
  // the Heliopolis seat, so its vacancy renders.
  const resignedAreaStaysVisibleDespiteFilledStatus = applyOrganogramMirrorSafety([
    row({ hrId: "MR-NASR", areaName: "Nasr City", regionName: "Cairo", teamName: null }),
    vacancy({
      areaName: "Heliopolis",
      regionName: "Cairo",
      teamName: null,
      hrId: "VAC-HELIO",
      status: "filled",
      vacancyCode: "VAC-HELIO",
    }),
  ]);
  assert.deepEqual(
    resignedAreaStaysVisibleDespiteFilledStatus
      .filter((item) => item.type === "vacancy")
      .map((item) => item.areaName),
    ["Heliopolis"],
  );

  // Symmetric guard: a "filled" vacancy whose seat IS occupied by an active rep
  // stays hidden — occupancy correctly recognizes the seat as filled.
  const filledStatusVacancyHiddenWhenSeatOccupied = applyOrganogramMirrorSafety([
    row({ hrId: "MR-NASR-ACTIVE", areaName: "Nasr City", regionName: "Cairo", teamName: null }),
    vacancy({
      areaName: "Nasr City",
      regionName: "Cairo",
      teamName: null,
      hrId: "VAC-NASR",
      status: "filled",
      vacancyCode: "VAC-NASR",
    }),
  ]);
  assert.equal(
    filledStatusVacancyHiddenWhenSeatOccupied.filter((item) => item.type === "vacancy").length,
    0,
  );

  // Orphaned import/test debris: a manager-level vacancy with no manager to
  // report to and no seat-continuity marker is structurally unplaceable and must
  // never render (this is what kept ~14 fake "PHASE15" DSM rows off the chart).
  const orphanManagerVacancyDropped = applyOrganogramMirrorSafety([
    vacancy({
      areaName: "Cairo",
      hrId: "VAC-ORPHAN",
      jobTitle: "District Sales Manager",
      managerHrId: null,
      managerName: "PHASE15_FAKE Manager",
      managerReplacementForHrId: null,
      positionId: 200,
      positionTitle: "District Sales Manager",
      status: "filled",
      vacancyCode: "VAC-ORPHAN",
    }),
  ]);
  assert.equal(orphanManagerVacancyDropped.length, 0);

  const resignationVacancy = applyOrganogramMirrorSafety([
    vacancy({
      hrId: "resignation_b-180_20260101000000",
      managerHrId: "NSM-1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      vacancyCode: "resignation_b-180_20260101000000",
    }),
  ]);
  // MD-6/LO-6 fix: the suffix is now a base-36 hash of the FULL raw code
  // (never a truncated substring of just the timestamp), so two distinct
  // resignation codes that happen to share a tail (e.g. same time-of-day on
  // different dates) can no longer collapse to the same public label.
  assert.equal(resignationVacancy[0]?.hrId, "VAC-RES-PH8AE7");
  assert.equal(publicVacancyLabel("resignation_vac_20260517123456_B180"), "VAC-RES-PIBHHX");
  // Same clock time (12:34:56), different date -> the OLD slice(-6) truncation
  // discarded the date and collided both to "123456"/"VAC-RES-123456". The new
  // full-string hash must NOT collide.
  assert.notEqual(
    publicVacancyLabel("resignation_vac_20260517123456_B180"),
    publicVacancyLabel("resignation_vac_20260610123456_B181"),
  );

  const vacantDsmLaneKeepsPendingReports = buildOrganogramLanes([
    row({
      fullName: "Line NSM",
      hrId: "NSM-1",
      jobTitle: "National Sales Manager",
      managerHrId: "AA",
      positionId: 300,
      positionTitle: "National Sales Manager",
    }),
    vacancy({
      fullName: "Vacant",
      hrId: "VAC-DSM-180",
      jobTitle: "District Sales Manager",
      managerHrId: "NSM-1",
      positionId: 200,
      positionTitle: "District Sales Manager",
      replacementForHrId: "B-180",
      vacancyCode: "VAC-DSM-180",
    }),
    row({
      areaName: "Heliopolis",
      fullName: "Active Rep",
      hrId: "MR-HELIO",
      managerHrId: "NSM-1",
      managerReplacementForHrId: "B-180",
      positionTitle: "Medical Representative",
    }),
    vacancy({
      areaName: "Cairo East 1",
      hrId: "VAC-MR-EAST-1",
      managerHrId: "NSM-1",
      managerReplacementForHrId: "B-180",
      positionTitle: "Medical Representative",
      vacancyCode: "VAC-MR-EAST-1",
    }),
  ]);
  const vacantDsmLane = vacantDsmLaneKeepsPendingReports.groups.find(
    (group) => group.dsm?.replacementForHrId === "B-180",
  );
  assert.ok(vacantDsmLane, "Vacant DSM must render as its own lane.");
  assert.deepEqual(
    vacantDsmLane.members.map((member) => member.hrId).sort(),
    ["MR-HELIO", "VAC-MR-EAST-1"],
  );

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

  const duplicateDsmKpis = calculateOrganogramStructureKpis([
    vacancy({
      areaId: 101,
      areaName: "Cairo East 1",
      hrId: "vacancy_dsm_3",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: 20,
      teamName: "Nasr City",
      vacancyCode: "vacancy_dsm_3",
    }),
    vacancy({
      areaId: 102,
      areaName: "Cairo East 2",
      hrId: "vacancy_dsm_4",
      positionId: 200,
      positionTitle: "District Sales Manager",
      teamId: 21,
      teamName: "Heliopolis",
      vacancyCode: "vacancy_dsm_4",
    }),
  ]);
  expectKpi(duplicateDsmKpis, "dsm", { actual: 0, total: 2, vacant: 2 });
  expectKpi(duplicateDsmKpis, "total", { actual: 0, total: 2, vacant: 2 });

  const scoped = scopeOrganogramReportData(
    {
      organogramRows: [
        row({ hrId: "PEDIA-1", lineName: "Pedia" }),
        row({ hrId: "CNS-1", lineName: "CNS" }),
        vacancy({ hrId: "PEDIA-VAC", lineName: "Pedia", managerHrId: "DSM-X", vacancyCode: "vacancy_pedia" }),
        vacancy({ hrId: "CNS-VAC", lineName: "CNS", managerHrId: "DSM-Y", vacancyCode: "vacancy_cns" }),
      ],
      rows: [
        {
          areaId: 10,
          areaName: "Cairo",
          createdAt: "2026-01-01",
          departmentId: 1,
          departmentName: "Sales",
          id: 1,
          jobTitle: "Medical Representative",
          lineId: 1,
          lineName: "Pedia",
          managerHrId: "DSM-1",
          managerName: "DSM One",
          note: null,
          positionId: 100,
          positionTitle: "Medical Representative",
          regionName: "Cairo",
          sourceRowNumber: null,
          status: "open",
          teamId: 20,
          teamName: "New Cairo",
          vacancyCode: "vacancy_pedia",
        },
        {
          areaId: 11,
          areaName: "Giza",
          createdAt: "2026-01-01",
          departmentId: 1,
          departmentName: "Sales",
          id: 2,
          jobTitle: "Medical Representative",
          lineId: 2,
          lineName: "CNS",
          managerHrId: "DSM-2",
          managerName: "DSM Two",
          note: null,
          positionId: 100,
          positionTitle: "Medical Representative",
          regionName: "Giza",
          sourceRowNumber: null,
          status: "open",
          teamId: 21,
          teamName: "Giza",
          vacancyCode: "vacancy_cns",
        },
      ],
      summary: {
        areasAffected: 2,
        linesAffected: 2,
        openVacancies: 2,
        positionsAffected: 1,
        totalVacancies: 2,
      },
    } satisfies VacancyReportData,
    { lineName: "Pedia", mode: "line" },
  );
  assert.deepEqual(scoped.organogramRows.map((item) => item.lineName), ["Pedia", "Pedia"]);
  assert.equal(scoped.summary.linesAffected, 1);
  assert.equal(scoped.summary.openVacancies, 1);

  // Multi-line override path keeps both allowed lines PLUS the upward management chain, so a
  // cross-line manager (e.g. a Head Office Marketing Manager above a two-line Product Manager)
  // still renders instead of orphaning the subtree. Unrelated lines stay excluded.
  const multiLineScoped = scopeOrganogramReportData(
    {
      organogramRows: [
        row({ hrId: "PM-PEDIA", lineName: "Pedia", managerHrId: "GPM-PEDIA" }),
        row({ hrId: "GPM-PEDIA", lineName: "Pedia", managerHrId: "MKT-MGR" }),
        row({ hrId: "MKT-MGR", lineName: "Head Office", managerHrId: "AA" }),
        row({ hrId: "AF-REP", lineName: "Anti infective", managerHrId: "GPM-PEDIA" }),
        row({ hrId: "CNS-REP", lineName: "CNS", managerHrId: "GPM-CNS" }),
      ],
      rows: [],
      summary: { areasAffected: 0, linesAffected: 0, openVacancies: 0, positionsAffected: 0, totalVacancies: 0 },
    } satisfies VacancyReportData,
    { lineNames: ["Pedia", "Anti infective"], mode: "line" },
  );
  const multiLineKept = multiLineScoped.organogramRows.map((item) => item.hrId).sort();
  assert.deepEqual(
    multiLineKept,
    ["AF-REP", "GPM-PEDIA", "MKT-MGR", "PM-PEDIA"],
    "multi-line scope keeps both lines' employees plus the cross-line management chain (Head Office Marketing Manager)",
  );
  assert.equal(multiLineKept.includes("CNS-REP"), false, "an unrelated line's employees stay excluded");

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
  assert.equal(
    districtBucketMatches(
      vacancy({
        areaId: 44,
        areaName: "Downtown + shoubra Masr",
        lineName: "Pedia",
        positionTitle: "Medical Representative",
        regionName: null,
        teamName: null,
      }),
      vacancy({ areaName: "Cairo", lineName: "Pedia", positionTitle: "District Sales Manager" }),
    ),
    true,
  );

  const componentSource = readFileSync("src/components/reports/organogram-report.tsx", "utf8");
  const portalSource = readFileSync("src/components/employee-portal/employee-organogram-dashboard.tsx", "utf8");
  // The bold org-chart rendering (lane labels, vacant-seat display, childLanes iteration)
  // is shared by both the admin and portal surfaces via this module, so the presentation
  // guards below read it instead of the per-surface wrappers.
  const orgChartSource = readFileSync("src/components/organogram/org-chart.tsx", "utf8");
  const organogramApiSource = readFileSync("app/api/reports/organogram/route.ts", "utf8");
  const vacancyApiSource = readFileSync("app/api/reports/vacancies/route.ts", "utf8");
  const portalPageSource = readFileSync("app/employee-portals/organogram/page.tsx", "utf8");
  const adminPageSource = readFileSync("app/(admin)/organogram/page.tsx", "utf8");
  const sharedViewModelSource = readFileSync("src/lib/reports/organogram-view-model.ts", "utf8");
  const vacancyReportSource = readFileSync("src/lib/reports/vacancies.ts", "utf8");
  const resignationServiceSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  const terminalVacancyGuardMigration = readFileSync(
    "supabase/_migrations_archive/pre-baseline-2026-07-11/20260527064308_terminal_employee_vacancy_guard.sql",
    "utf8",
  );

  assert.match(componentSource, /\/api\/reports\/organogram/);
  assert.match(portalSource, /\/api\/reports\/organogram/);
  assert.match(organogramApiSource, /assertPermission\(access, "organogram", "read"\)/);
  assert.match(vacancyApiSource, /assertPermission\(access, "vacancies", "read"\)/);
  assert.match(portalPageSource, /resolveOrganogramLinesForEmployee/);
  assert.doesNotMatch(portalPageSource, /getVacancyReport/);
  assert.match(
    portalPageSource,
    /canAccessCompanyOrganogram/,
    "Employee-portal Organogram page must branch on company-wide access (Training Manager / Marketing Manager), not just isLineScopedOrganogramRole.",
  );
  assert.match(portalPageSource, /isCompanyScoped/);
  assert.match(adminPageSource, /canAccessCompanyOrganogram/);
  assert.match(sharedViewModelSource, /export function buildOrganogramLanes/);
  assert.match(sharedViewModelSource, /organogramPositionSlotKey/);
  assert.match(sharedViewModelSource, /reportsToVacantReplacementOwner/);
  assert.match(vacancyReportSource, /manager_replacement_for_hr_id/);
  assert.match(vacancyReportSource, /pending_manager_replacement_for_hr_id/);
  assert.match(resignationServiceSource, /ensureResignationVacancyOwnership/);
  assert.match(resignationServiceSource, /replacement_for_hr_id: employee\.hrId/);
  assert.match(terminalVacancyGuardMigration, /phx_ensure_terminal_employee_vacancy/);
  assert.match(terminalVacancyGuardMigration, /phx_employee_terminal_vacancy_guard/);
  assert.match(terminalVacancyGuardMigration, /replacement_for_hr_id = v_employee\.hr_id/);
  assert.match(terminalVacancyGuardMigration, /area_id is not distinct from v_employee\.area_id/);
  assert.match(terminalVacancyGuardMigration, /phx_release_terminal_manager_ownership/);
  assert.doesNotMatch(
    terminalVacancyGuardMigration,
    /for r in[\s\S]*public\.employees[\s\S]*perform public\.phx_ensure_terminal_employee_vacancy/,
    "Terminal vacancy guard must not backfill every historical terminal employee automatically.",
  );
  assert.match(orgChartSource, /Reports to NSM/);
  assert.match(orgChartSource, /childLanes/);
  assert.match(orgChartSource, /Medical Sales Representatives/);
  assert.match(
    sharedViewModelSource,
    /if \(assignedToDsm\.has\(key\)\) \{\s*return false;\s*\}/,
    "Organogram DSM lanes must not duplicate the same member or vacancy across multiple manager columns.",
  );
  assert.match(
    sharedViewModelSource,
    /left\.type === "employee"[\s\S]*\? -1/,
    "Organogram lane assignment must prioritize real employee managers before broad vacant manager slots.",
  );
  assert.match(
    sharedViewModelSource,
    /const visibleDsmGroups = dsmGroups;/,
    "Organogram must render vacant DSM seats as visible manager lanes even when their reports are inferred later or temporarily missing.",
  );
  assert.match(
    orgChartSource,
    /isVacantManagerSeat \? "Vacant" : seatCount\.seats/,
    "Vacant manager seats must be visually labeled as vacant boxes, not only counted in totals.",
  );
  assert.match(
    sharedViewModelSource,
    /const directDsmGroups = visibleDsmGroups\.filter/,
    "Organogram direct DSM rendering must use the visible lane set instead of raw vacant manager slots.",
  );
  assert.doesNotMatch(componentSource, /AdminStatCard/);

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE V ORGANOGRAM IS GONE, AND IT MAY NOT COME BACK.
  //
  // `public.v_active_organogram` was dropped on 2026-10-12 at the owner's instruction: the EU
  // organogram — the `au_v_*` seat model — is the only source of truth for an employee's
  // distribution. The view was a flat `employees` join filtered to "active TODAY", so an area
  // whose seat is vacant NOW vanished from it entirely and every question about a PAST month came
  // back as "nobody". It reported 48 areas with no Down town while Down town's CNS rep seat was
  // occupied for the whole of September. Nothing in the database depended on it, confirmed against
  // production immediately before the drop: zero dependent views, matviews or rules.
  //
  // Reading it now is a PostgREST 42P01, and a missing relation fails the WHOLE request rather
  // than one field — so this sweeps the source instead of trusting a grep run once. Naming it in a
  // comment is allowed; reading it is not.
  const readsTheDroppedView = /\.from\(\s*["'`]v_active_organogram["'`]\s*\)/;
  const offenders: string[] = [];
  for (const root of ["src", "app", "scripts"]) {
    for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const rel = `${root}/${String(entry).split("\\").join("/")}`;
      if (!/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(rel)) continue;
      if (!statSync(rel).isFile()) continue;
      if (readsTheDroppedView.test(readFileSync(rel, "utf8"))) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `v_active_organogram was dropped on 2026-10-12 — read the EU organogram (au_v_* seat views) instead. Still reading it: ${offenders.join(", ")}`,
  );
}
