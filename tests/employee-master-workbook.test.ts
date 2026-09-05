import assert from "node:assert/strict";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import {
  buildEmployeeMasterWorkbook,
  buildRowCheckFormula,
  employeeMasterWorkbookContract,
} from "../src/lib/employees/employee-master-workbook.ts";
import { createEmployeeColumnLookup } from "../src/lib/imports/employee-column-map.ts";
import { normalizeHeaderName } from "../src/lib/imports/employee-normalizers.ts";
import {
  EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS,
  parseEmployeeUploadRows,
} from "../src/lib/imports/employee-upload-parse.ts";
import { firstExcelWorksheet, loadExcelWorkbook } from "../src/lib/uploads/exceljs-rows.ts";

// The Employee Master workbook is both the export and the import template, so its SHAPE is a
// contract with `app/api/imports/employees/dry-run/route.ts` rather than a matter of taste. Four
// things in it are load-bearing and none of them fail loudly when broken:
//
//   1. the data sheet must be worksheets[0]      — the importer takes the first sheet by POSITION
//   2. the header row must land within rows 1-10 — the importer scans no further
//   3. every formula must read as EMPTY on a blank row — or the spare rows arrive as real ones
//   4. an imported column's header must stay an ALIAS — or that field silently stops updating
//
// Number 3 is the one that had actually shipped. ExcelJS writes a formula with no cached result,
// which used to read back as the literal text "[object Object]" — non-empty — so every spare row
// looked like data. Measured on this fixture before the fix: 12 employees arrived as 262 rows.

const AREAS = [
  { label: "Delta (3)", value: "1" },
  { label: "Gharbia 1 (Tanta)", value: "2" },
  { label: "Port said - Domiat", value: "3" },
];

function fixtureEmployee(index: number) {
  return {
    areaId: 1,
    areaName: "Delta (3)",
    bankAccount: "EG1234567890",
    bankName: "CIB",
    baseSalary: 10000,
    basicSalary: 7000,
    birthDate: "1990-04-11T00:00:00Z",
    contractRenewalDate: "2027-01-01T00:00:00Z",
    contractType: "Full time",
    createdAt: "2024-01-01T00:00:00Z",
    crmId: `C-${index}`,
    crmUsername: `user${index}`,
    departmentId: 2,
    departmentName: "Sales",
    displayName: `Person ${index}`,
    education: "Pharmacy",
    employmentStatus: "active",
    extraCostOfLiving: 500,
    fuelAllowance: 800,
    fullName: `Person ${index}`,
    gender: "Male",
    grossSalary: 11500,
    hasBankAccount: "yes",
    hasPhoto: false,
    hireDate: "2022-06-01T00:00:00Z",
    hrId: `A-${index}`,
    jobTitle: "Medical Rep",
    lastWorkingDate: null,
    lineId: 3,
    lineName: "CNS",
    managerHrId: index > 1 ? "A-1" : null,
    managerName: index > 1 ? "Person 1" : null,
    medicalInsurance: 200,
    medicalInsuranceNumber: "M1",
    medicalInsuranceStatus: "yes",
    mobileNumber: "01000000000",
    nameAr: "اسم عربي",
    nationalId: "29004110100011",
    netSalary: 11300,
    nickname: null,
    organogramVisible: true,
    payrollEligible: true,
    pendingManagerReplacementForHrId: null,
    positionId: 5,
    positionTitle: "Medical Rep",
    regionName: "Delta",
    residenceAddress: "1 Some Street",
    residenceArea: "Dokki",
    residenceCity: "Giza",
    residenceGeocodeStatus: null,
    residenceLatitude: null,
    residenceLongitude: null,
    resignationDate: null,
    salaryPaymentMode: "two_parts" as const,
    socialInsurance: 300,
    socialInsuranceNumber: "S1",
    socialInsuranceStatus: "yes",
    socialInsuranceWage: 6000,
    taxes: 400,
    teamId: 9,
    teamName: "Team A",
    updatedAt: "2026-09-01T00:00:00Z",
    workEmail: `person${index}@example.com`,
  };
}

const EMPLOYEE_COUNT = 12;

async function buildFixtureWorkbook() {
  const employees = Array.from({ length: EMPLOYEE_COUNT }, (_, index) => fixtureEmployee(index + 1));
  const workbook = await buildEmployeeMasterWorkbook({
    employees: employees as never,
    lookups: {
      areas: AREAS,
      departments: ["Sales", "Marketing", "Head Office"],
      lines: [
        { id: 3, label: "CNS" },
        { id: 4, label: "Pedia" },
      ],
      managerDirectory: employees.map((employee) => ({
        fullName: employee.fullName,
        hrId: employee.hrId,
      })),
      positions: ["Medical Rep", "District Manager"],
      teams: [
        { areaId: 1, label: "Team A" },
        { areaId: 2, label: "Team B" },
      ],
    },
  });
  const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
  return { buffer, employees };
}

export async function runEmployeeMasterWorkbookTests() {
  const { buffer } = await buildFixtureWorkbook();

  // ── 1. the data sheet is first, by position ──────────────────────────────────
  const reloaded = await loadExcelWorkbook(buffer);
  const sheet = firstExcelWorksheet(reloaded);
  assert.ok(sheet, "the workbook must have a first worksheet");
  assert.equal(
    sheet.name,
    employeeMasterWorkbookContract.masterSheetName,
    "the importer reads worksheets[0] by POSITION — putting the cover sheet first would hand it a page of prose",
  );

  // ── 2 & 3. THE REAL PARSER READS IT ─────────────────────────────────────────
  //
  // This runs `parseEmployeeUploadRows` — the exact function both the dry-run and the confirm
  // route call — rather than a copy of its logic. A test that re-implements the thing it is
  // checking agrees with itself by construction; this one can actually fail.
  const parsed = await parseEmployeeUploadRows<Record<string, unknown>>(
    new File([buffer], "employee-master.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  assert.ok(!("error" in parsed), `the production parser must read the template: ${JSON.stringify(parsed)}`);

  assert.equal(
    parsed.headerRowNumber,
    employeeMasterWorkbookContract.headerRow,
    "the importer scans only the first rows for a row carrying both Employee ID and Full Name",
  );
  assert.ok(
    parsed.headerRowNumber <= EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS,
    `the header must sit within the parser's ${EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS}-row scan`,
  );

  const rows = parsed.rows;
  assert.equal(
    rows.length,
    EMPLOYEE_COUNT,
    `the importer must see exactly the ${EMPLOYEE_COUNT} employees, not the ${employeeMasterWorkbookContract.spareRows} spare rows as well — ` +
      "a formula cell with no cached result used to read as [object Object], which made every blank row look like data",
  );
  assert.equal((rows[0] as Record<string, unknown>)["Employee ID"], "A-1");
  assert.equal((rows[0] as Record<string, unknown>)["Full Name"], "Person 1");

  // ── 4. an imported column's header is an API ─────────────────────────────────
  const lookup = createEmployeeColumnLookup();
  const resolves = (header: string) => lookup.get(normalizeHeaderName(header)) ?? null;

  for (const column of employeeMasterWorkbookContract.columns) {
    if (column.imported) {
      assert.ok(
        resolves(column.header),
        `"${column.header}" is marked as uploaded but matches no alias in employee-column-map.ts — ` +
          "the upload would silently stop writing that field",
      );
    } else {
      assert.equal(
        resolves(column.header),
        null,
        `"${column.header}" is a display-only column but DOES match an import alias — ` +
          "a formula or reference value would be written to the database",
      );
    }
  }

  // ── 5. every formula opens with the blank-row guard ──────────────────────────
  const formula = buildRowCheckFormula({
    hasAreas: true,
    hasDepartments: true,
    hasManagers: true,
    lastRow: 300,
    originalMoneyFilled: 9,
    rowNumber: 42,
  });
  assert.ok(
    formula.startsWith("=IF(COUNTA("),
    "the row check must open with a COUNTA guard so a blank row evaluates to the empty string",
  );
  assert.ok(
    /^=IF\(COUNTA\((?:[A-Z]+42:[A-Z]+42,?)+\)=0,"",/.test(formula),
    `the guard must test THIS row and return "" — got: ${formula.slice(0, 80)}`,
  );
  // COUNTA counts a formula that returns "" — so the guard must SKIP the formula columns, or a
  // blank spare row counts as 1 and the whole sheet fills with red "Missing Employee ID".
  const guard = formula.slice(0, formula.indexOf(")=0"));
  for (const column of employeeMasterWorkbookContract.columns) {
    if (column.kind !== "formula") continue;
    const index = employeeMasterWorkbookContract.columns.indexOf(column) + 1;
    let letters = "";
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
      letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    }
    assert.ok(
      !new RegExp(`(^|[,(])${letters}42:`).test(guard) && !guard.endsWith(`:${letters}42`),
      `the blank-row guard must not COUNTA the formula column "${column.header}" (${letters})`,
    );
  }
  // Each clause below is a real error code in employee-validator.ts. A check the server does not
  // make teaches people to ignore the column.
  for (const fragment of ["Missing Employee ID", "Duplicate Employee ID", "own manager", "Ready"]) {
    assert.ok(formula.includes(fragment), `row check should report "${fragment}"`);
  }

  // ── 6. the cleared-payroll advisory needs its columns contiguous ─────────────
  const moneyIndexes = employeeMasterWorkbookContract.columns
    .map((column, index) => (column.kind === "money" && column.imported ? index : null))
    .filter((index): index is number => index !== null);
  assert.ok(moneyIndexes.length > 0, "there should be money columns");
  assert.equal(
    moneyIndexes[moneyIndexes.length - 1] - moneyIndexes[0] + 1,
    moneyIndexes.length,
    "the money columns must stay contiguous — the cleared-cell advisory COUNTAs them as one range, " +
      "and a text column moved into the middle would make it count cells that are not money",
  );

  // ── 7. the EMITTED ARTIFACT parses, and Excel will not repair it ─────────────
  const problems = await checkWorkbook(Buffer.from(buffer), { quiet: true });
  assert.deepEqual(
    problems,
    [],
    `the generated workbook must be structurally clean — Excel repairs silently, and a repair drops ` +
      `the dropdowns and defined names this file depends on. Problems: ${problems.join("; ")}`,
  );
}
