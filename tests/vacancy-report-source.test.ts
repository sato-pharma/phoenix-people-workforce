import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { publicVacancyLabel } from "../src/lib/reports/organogram-safety.ts";
import {
  dedupeVacancyReportRows,
  type VacancySeatRow,
} from "../src/lib/reports/vacancy-report-safety.ts";
import {
  generateShortVacancyCode,
  generateVacancySeatCode,
} from "../src/lib/workforce/vacancy-code.ts";

type TestVacancyRow = VacancySeatRow & {
  createdAt: string;
  departmentId: number | null;
  departmentName: string | null;
  id: number;
  note: string | null;
  sourceRowNumber: number | null;
  vacancyCode: string;
};

function vacancy(overrides: Partial<TestVacancyRow>): TestVacancyRow {
  return {
    areaId: 1,
    areaName: "Cairo",
    createdAt: "2026-05-19T10:00:00.000Z",
    departmentId: 1,
    departmentName: "Sales",
    id: 1,
    jobTitle: "District Sales Manager",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: "NSM-1",
    managerName: "National Manager",
    note: null,
    positionId: 10,
    positionTitle: "District Sales Manager",
    regionName: "Cairo",
    sourceRowNumber: 10,
    status: "open",
    teamId: null,
    teamName: null,
    vacancyCode: "VAC-DSM-001",
    ...overrides,
  };
}

export function runVacancyReportSourceTests() {
  const rows = dedupeVacancyReportRows([
    vacancy({ id: 1, vacancyCode: "VAC-DSM-001" }),
    vacancy({ id: 2, sourceRowNumber: 20, vacancyCode: "VAC-DSM-002" }),
    vacancy({
      id: 3,
      jobTitle: "Medical Representative",
      positionId: 11,
      positionTitle: "Medical Representative",
      vacancyCode: "VAC-MR-001",
    }),
    vacancy({
      id: 4,
      jobTitle: "Medical Representative",
      positionId: 11,
      positionTitle: "Medical Representative",
      sourceRowNumber: 21,
      vacancyCode: "VAC-MR-002",
    }),
    vacancy({ id: 5, status: "closed", vacancyCode: "VAC-DSM-CLOSED" }),
    vacancy({ id: 6, status: "filled", vacancyCode: "VAC-DSM-FILLED" }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.vacancyCode),
    ["VAC-DSM-001", "VAC-MR-001"],
  );

  const importedDsmDuplicates = dedupeVacancyReportRows([
    vacancy({
      id: 21,
      managerHrId: "PHASE15_MPBNGR14_FEACB21D",
      managerName: "PHASE15_MPBNGR14_FEACB21D Manager",
      status: "filled",
      vacancyCode: "VAC-1DTERM",
    }),
    vacancy({
      id: 22,
      managerHrId: "PHASE15_MPBNGR14_FEACB21D",
      managerName: "PHASE15_MPBNGR14_FEACB21D Manager",
      status: "filled",
      vacancyCode: "VAC-1DHIRE",
    }),
    vacancy({
      id: 23,
      managerHrId: "PHASE15_MPBNF8MG",
      managerName: "PHASE15_MPBNF8MG Manager",
      status: "open",
      vacancyCode: "VAC-B9HIRE",
    }),
    vacancy({
      id: 24,
      managerHrId: "PHASE15_MPBNDXKQ",
      managerName: "PHASE15_MPBNDXKQ Manager",
      status: "closed",
      vacancyCode: "VAC-58HIRE",
    }),
  ]);

  // Still exactly one row for the seat — that is what this case has always guarded. Which one
  // changed on 2026-08-31: the OPEN row now speaks for the seat instead of the newest row, so four
  // import-noise rows collapse onto the one that says somebody can still be hired into it.
  assert.deepEqual(
    importedDsmDuplicates.map((row) => row.vacancyCode),
    ["VAC-B9HIRE"],
  );

  // The production shape that forced the rule, verbatim: the Anti Infective rep seat in Nasr City
  // carried a filled row from May, an open row from 18 July and a cancelled row from 20 July, while
  // the organogram called the seat VACANT. Rows reach the dedupe newest-first, so before this the
  // cancelled row won and the seat disappeared from every send-a-CV and requisition picker.
  const nasrCityRepSeat = dedupeVacancyReportRows([
    vacancy({
      areaId: 1095,
      areaName: "Nasr City",
      id: 300,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      positionId: 2,
      positionTitle: "Medical Representative",
      status: "cancelled",
      vacancyCode: "VAC-CA2-CANCELLED",
    }),
    vacancy({
      areaId: 1095,
      areaName: "Nasr City",
      id: 298,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      positionId: 2,
      positionTitle: "Medical Representative",
      status: "open",
      vacancyCode: "VAC-CA2-OPEN",
    }),
    vacancy({
      areaId: 1095,
      areaName: "Nasr City",
      id: 174,
      jobTitle: "Medical Representative",
      lineName: "Anti Infective",
      positionId: 2,
      positionTitle: "Medical Representative",
      status: "filled",
      vacancyCode: "VAC-CA2-FILLED",
    }),
  ]);

  assert.deepEqual(
    nasrCityRepSeat.map((row) => row.vacancyCode),
    ["VAC-CA2-OPEN"],
    "an open seat must survive a newer cancelled or filled row claiming the same seat",
  );

  // …and the rule must not invent an opening. A seat with no open row at all still collapses to the
  // newest row, so nothing here can turn a filled seat into a vacancy.
  const noOpenRowAtAll = dedupeVacancyReportRows([
    vacancy({ id: 400, status: "filled", vacancyCode: "VAC-NEWEST-FILLED" }),
    vacancy({ id: 401, status: "cancelled", vacancyCode: "VAC-OLDER-CANCELLED" }),
  ]);

  assert.deepEqual(
    noOpenRowAtAll.map((row) => row.vacancyCode),
    ["VAC-NEWEST-FILLED"],
    "with no open row for the seat, the newest row still speaks for it",
  );

  const cairoDsmRows = dedupeVacancyReportRows([
    vacancy({
      areaId: 101,
      areaName: "Cairo East 1",
      id: 11,
      teamId: 301,
      teamName: "Nasr City",
      vacancyCode: "VAC-DSM-CAIRO-1",
    }),
    vacancy({
      areaId: 102,
      areaName: "Cairo East 2",
      id: 12,
      teamId: 302,
      teamName: "Heliopolis",
      vacancyCode: "VAC-DSM-CAIRO-2",
    }),
  ]);

  assert.deepEqual(
    cairoDsmRows.map((row) => row.vacancyCode),
    ["VAC-DSM-CAIRO-1"],
  );

  const generated = generateShortVacancyCode({
    parts: ["2026-05-19"],
    primary: "B-180",
  });

  assert.match(generated, /^VAC-B180-[A-Z0-9]{3}$/);
  assert.ok(generated.length <= 13);
  assert.equal(
    generateVacancySeatCode({
      areaCode: "cairo-east",
      departmentCode: "sales",
      lineCode: "pedia",
      positionCode: "medical_rep",
      teamCode: null,
    }),
    generateVacancySeatCode({
      areaCode: "cairo-east",
      departmentCode: "sales",
      lineCode: "pedia",
      positionCode: "medical_rep",
      teamCode: null,
    }),
  );
  // Suffix is a base-36 hash of the full raw code (MD-6/LO-6 fix), not a
  // truncated substring of the timestamp — see organogram-safety.ts.
  assert.equal(publicVacancyLabel("resignation_vac_20260517123456_B180"), "VAC-RES-PIBHHX");
  assert.equal(publicVacancyLabel("resignation_b-180_20260101000000"), "VAC-RES-PH8AE7");

  runVacancyListLightReadTests();
}

/** The source of one top-level function: from its signature to the next top-level declaration. */
function functionSource(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n(?:export |async function |function |const |type )/);
  return signature + (end < 0 ? rest : rest.slice(0, end));
}

// The Recruitment page's new-requisition list reads the vacancy LIST, never the whole vacancy report
// (19 Oct 2026: the report also builds the employee directory, and the page missed the list at 10:37
// and 11:42 Cairo). The light read asks the database for open rows only, so the one thing it rests on
// is that de-duplicating the open rows alone keeps exactly the open rows the full report keeps.
function runVacancyListLightReadTests() {
  const seatRows = [
    // District Sales Manager seat, newest first: a filled row, then two open ones.
    vacancy({ id: 31, status: "filled", vacancyCode: "VAC-DSM-FILLED" }),
    vacancy({ id: 32, vacancyCode: "VAC-DSM-OPEN-NEW" }),
    vacancy({ id: 33, vacancyCode: "VAC-DSM-OPEN-OLD" }),
    // Medical Representative seat: a closed row in front of the open one.
    vacancy({
      id: 34,
      jobTitle: "Medical Representative",
      positionId: 11,
      positionTitle: "Medical Representative",
      status: "closed",
      vacancyCode: "VAC-MR-CLOSED",
    }),
    vacancy({
      id: 35,
      jobTitle: "Medical Representative",
      positionId: 11,
      positionTitle: "Medical Representative",
      vacancyCode: "VAC-MR-OPEN",
    }),
    // Two open rows that map to no structural seat: neither is anybody's duplicate.
    vacancy({ id: 36, jobTitle: "Pharmacist", lineId: null, lineName: null, positionId: null, positionTitle: null, vacancyCode: "VAC-FREE-1" }),
    vacancy({ id: 37, jobTitle: "Pharmacist", lineId: null, lineName: null, positionId: null, positionTitle: null, vacancyCode: "VAC-FREE-2" }),
  ];
  const isOpen = (row: { status: string }) => row.status === "open";
  const fromFullReport = dedupeVacancyReportRows(seatRows).filter(isOpen).map((row) => row.vacancyCode);
  const fromOpenRowsOnly = dedupeVacancyReportRows(seatRows.filter(isOpen)).filter(isOpen).map((row) => row.vacancyCode);
  assert.deepEqual(fromFullReport, ["VAC-DSM-OPEN-NEW", "VAC-MR-OPEN", "VAC-FREE-1", "VAC-FREE-2"]);
  assert.deepEqual(fromOpenRowsOnly, fromFullReport);

  const vacanciesSource = readFileSync(new URL("../src/lib/reports/vacancies.ts", import.meta.url), "utf8");
  const listRows = functionSource(vacanciesSource, "export async function getVacancyListRows(");
  // The light read never builds what only the organogram half of the report and its hire button use.
  for (const heavy of ["getEmployeeDirectory", "loadEmployeePendingManagerReplacements", "loadOfferOutBySeat", "getVacancyReport"]) {
    assert.doesNotMatch(listRows, new RegExp(`\\b${heavy}\\(`), `getVacancyListRows must not call ${heavy}`);
  }
  // One mapping for both, so the list and the report can never describe a seat differently.
  assert.match(listRows, /mapVacancyReportRow\(/);
  assert.match(listRows, /dedupeVacancyReportRows\(/);
  assert.match(functionSource(vacanciesSource, "export async function getVacancyReport("), /mapVacancyReportRow\(/);
  assert.equal(vacanciesSource.match(/areaName: row\.area_id/g)?.length, 1, "the vacancy row is mapped in one place");
  // openOnly filters in the database, on every fallback select alike.
  const loadRows = functionSource(vacanciesSource, "async function loadVacancyRows(");
  assert.match(loadRows, /filter\.openOnly \? \{ status: "eq\.open" \} : \{\}/);
  assert.equal(loadRows.match(/new URLSearchParams\(/g)?.length, 1, "every select goes through the one filtered params builder");

  const requisitionsSource = readFileSync(new URL("../src/lib/recruitment/requisitions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(requisitionsSource, /\bawait getVacancyReport\(|getVacancyReport\(\),/, "requisitions read the vacancy list, never the whole report");
  assert.match(requisitionsSource, /import \{ getVacancyListRows, type VacancyReportRow \} from "@\/lib\/reports\/vacancies";/);
  assert.match(
    functionSource(requisitionsSource, "export async function listOpenVacanciesForRequisition("),
    /getVacancyListRows\(\{ openOnly: true \}\)/,
  );
  assert.match(
    functionSource(requisitionsSource, "export async function createRequisition("),
    /\(await getVacancyListRows\(\)\)\.find\(\(row\) => row\.id === vacancyId\)/,
  );
}
