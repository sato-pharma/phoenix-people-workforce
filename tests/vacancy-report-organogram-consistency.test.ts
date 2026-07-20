import { strict as assert } from "node:assert";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  reconcileVacancyRowsAgainstOccupancy,
  scopeAuVacancyReportToLines,
  scopeAuVacancyReportToTeam,
  seatKeysOfActiveEmployees,
} from "../src/lib/reports/organogram.ts";
import type { OrganogramReportRow, VacancyReportData, VacancyReportRow } from "../src/lib/reports/vacancies.ts";

function seat(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: null,
    areaName: "Cairo",
    departmentId: null,
    departmentName: null,
    displayName: "Employee",
    fullName: "Employee",
    hireDate: null,
    hrId: "E-1",
    jobTitle: "District Sales Manager",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: "NSM-1",
    managerName: "NSM One",
    positionId: null,
    positionTitle: "District Sales Manager",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function vacancyRow(overrides: Partial<VacancyReportRow>): VacancyReportRow {
  return {
    areaId: null,
    areaName: "Cairo",
    createdAt: "2026-05-01T00:00:00.000Z",
    departmentId: null,
    departmentName: null,
    id: 1,
    jobTitle: "District Sales Manager",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: "NSM-1",
    managerName: "NSM One",
    note: null,
    positionId: null,
    positionTitle: "District Sales Manager",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "open",
    teamId: null,
    teamName: null,
    vacancyCode: "VAC-1",
    ...overrides,
  };
}

export function runVacancyReportOrganogramConsistencyTests() {
  // ── The exact audit finding: a stale "open" position_vacancies row for a seat ──
  // the organogram's own occupancy model shows as filled must be reconciled away,
  // so the flat report's count can never disagree with what /organogram shows.
  {
    const auTree: OrganogramReportRow[] = [
      seat({ hrId: "DSM-CAIRO-ACTIVE", areaName: "Cairo", lineName: "Pedia", managerHrId: "NSM-1" }),
    ];
    const occupiedSeatKeys = seatKeysOfActiveEmployees(auTree);

    const legacyRows: VacancyReportRow[] = [
      // Stale: position_vacancies still says "open" for the exact seat AU shows filled.
      vacancyRow({
        id: 101,
        vacancyCode: "VAC-STALE-CAIRO-DSM",
        areaName: "Cairo",
        lineName: "Pedia",
        managerHrId: "NSM-1",
        status: "open",
      }),
      // Genuinely open: a different seat (different area) AU has no conflicting data on.
      vacancyRow({
        id: 102,
        vacancyCode: "VAC-REAL-GIZA-DSM",
        areaName: "Giza",
        lineName: "Pedia",
        managerHrId: "NSM-1",
        status: "open",
      }),
    ];

    const reconciled = reconcileVacancyRowsAgainstOccupancy(legacyRows, occupiedSeatKeys);
    assert.deepEqual(
      reconciled.map((row) => row.vacancyCode),
      ["VAC-REAL-GIZA-DSM"],
      "a stale open row for an AU-occupied seat must be removed; an unrelated genuinely-open row must remain",
    );
  }

  // ── Rows that are already filled/cancelled are never touched by reconciliation ──
  // (this only corrects rows wrongly claiming to still be open).
  {
    const auTree: OrganogramReportRow[] = [
      seat({ hrId: "DSM-CAIRO-ACTIVE", areaName: "Cairo", lineName: "Pedia", managerHrId: "NSM-1" }),
    ];
    const occupiedSeatKeys = seatKeysOfActiveEmployees(auTree);
    const legacyRows: VacancyReportRow[] = [
      vacancyRow({ id: 201, vacancyCode: "VAC-ALREADY-FILLED", areaName: "Cairo", lineName: "Pedia", managerHrId: "NSM-1", status: "filled" }),
      vacancyRow({ id: 202, vacancyCode: "VAC-CANCELLED", areaName: "Cairo", lineName: "Pedia", managerHrId: "NSM-1", status: "cancelled" }),
    ];
    const reconciled = reconcileVacancyRowsAgainstOccupancy(legacyRows, occupiedSeatKeys);
    assert.deepEqual(
      reconciled.map((row) => row.vacancyCode).sort(),
      ["VAC-ALREADY-FILLED", "VAC-CANCELLED"],
      "non-open rows pass through untouched regardless of AU occupancy",
    );
  }

  // ── A genuinely vacant seat (AU agrees) keeps its open row, with no seat key ──
  // in the occupied set at all.
  {
    const auTree: OrganogramReportRow[] = [
      seat({ hrId: "MR-ACTIVE", jobTitle: "Medical Representative", positionTitle: "Medical Representative", areaName: "Nasr City", lineName: "Pedia", managerHrId: "DSM-1" }),
    ];
    const occupiedSeatKeys = seatKeysOfActiveEmployees(auTree);
    const legacyRows: VacancyReportRow[] = [
      vacancyRow({
        id: 301,
        vacancyCode: "VAC-HELIOPOLIS",
        jobTitle: "Medical Representative",
        positionTitle: "Medical Representative",
        areaName: "Heliopolis",
        lineName: "Pedia",
        managerHrId: "DSM-1",
        status: "open",
      }),
    ];
    const reconciled = reconcileVacancyRowsAgainstOccupancy(legacyRows, occupiedSeatKeys);
    assert.deepEqual(reconciled.map((row) => row.vacancyCode), ["VAC-HELIOPOLIS"]);
  }

  // ── Line scoping filters organogramRows AND rows by the same criterion, and ──
  // recomputes the summary from the (already-reconciled) rows.
  {
    const report: VacancyReportData = {
      organogramRows: [
        seat({ hrId: "PEDIA-DSM", lineName: "Pedia" }),
        seat({ hrId: "CNS-DSM", lineName: "CNS" }),
      ],
      rows: [
        vacancyRow({ id: 401, vacancyCode: "VAC-PEDIA", lineName: "Pedia", status: "open" }),
        vacancyRow({ id: 402, vacancyCode: "VAC-CNS", lineName: "CNS", status: "open" }),
      ],
      summary: { areasAffected: 0, linesAffected: 0, openVacancies: 0, positionsAffected: 0, totalVacancies: 0 },
    };
    const scoped = scopeAuVacancyReportToLines(report, ["Pedia"]);
    assert.deepEqual(scoped.organogramRows.map((row) => row.hrId), ["PEDIA-DSM"]);
    assert.deepEqual(scoped.rows.map((row) => row.vacancyCode), ["VAC-PEDIA"]);
    assert.equal(scoped.summary.openVacancies, 1);
    assert.equal(scoped.summary.totalVacancies, 1);
  }

  // ── Team scoping (District Manager) filters both lists to rows reporting ──
  // directly to the viewer, exactly like the legacy path did.
  {
    const report: VacancyReportData = {
      organogramRows: [
        seat({ hrId: "REPORTS-TO-ME", managerHrId: "DM-1" }),
        seat({ hrId: "REPORTS-ELSEWHERE", managerHrId: "DM-2" }),
      ],
      rows: [
        vacancyRow({ id: 501, vacancyCode: "VAC-MINE", managerHrId: "DM-1", status: "open" }),
        vacancyRow({ id: 502, vacancyCode: "VAC-NOT-MINE", managerHrId: "DM-2", status: "open" }),
      ],
      summary: { areasAffected: 0, linesAffected: 0, openVacancies: 0, positionsAffected: 0, totalVacancies: 0 },
    };
    const districtManager: AccessContext = { hrId: "DM-1", role: "District Manager", scope: "team", source: "session" };
    const scoped = scopeAuVacancyReportToTeam(report, districtManager);
    assert.deepEqual(scoped.organogramRows.map((row) => row.hrId), ["REPORTS-TO-ME"]);
    assert.deepEqual(scoped.rows.map((row) => row.vacancyCode), ["VAC-MINE"]);

    const unresolved = scopeAuVacancyReportToTeam(report, { ...districtManager, hrId: null });
    assert.equal(unresolved.diagnostic?.code, "team_unresolved");
  }
}
