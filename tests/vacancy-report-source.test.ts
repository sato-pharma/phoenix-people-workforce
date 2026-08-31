import { strict as assert } from "node:assert";

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
}
