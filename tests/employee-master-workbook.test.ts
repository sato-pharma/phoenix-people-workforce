import assert from "node:assert/strict";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import {
  buildEmployeeMasterWorkbook,
  buildRowCheckFormula,
  employeeMasterWorkbookContract,
} from "../src/lib/employees/employee-master-workbook.ts";
import {
  documentColumnHeader,
  FORMULA_KEYS,
  HIRING_DOCUMENTS_SUMMARY_KEY,
  HIRING_DOCUMENT_GROUP_ORDER,
  HIRING_DOCUMENT_GROUP_SECTIONS,
  isReadOnlyMasterColumn,
  masterColumnsFor,
} from "../src/lib/employees/employee-master-columns.ts";
import { createEmployeeColumnLookup } from "../src/lib/imports/employee-column-map.ts";
import { normalizeHeaderName } from "../src/lib/imports/employee-normalizers.ts";
import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import {
  EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS,
  EMPLOYEE_UPLOAD_NAME_HEADERS,
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
    healthCardStatus: null,
    healthCardNumber: null,
    healthCardReceivedDate: null,
    birthPlace: "Giza",
    qualification: "Bachelor - license",
    universityName: "Cairo University",
    collegeMajor: "Pharmacology",
    seniorYear: "2019",
    totalExperienceYears: 2.5,
    contractDuration: "1 Year",
    probationEndDate: "2022-09-01T00:00:00Z",
    medicalInsuranceCardReceivedDate: "2022-07-01T00:00:00Z",
    socialInsuranceStartDate: "2022-06-01T00:00:00Z",
    kaabElamaalNumber: "KE-1",
    kaabElamaalIssuer: "Giza Labour Office",
    kaabElamaalIssueDate: "2022-05-20T00:00:00Z",
    kaabElamaalRefund: "no",
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

// Two real document names and one deliberately hostile one. "Position" is an alias in
// employee-column-map.ts, so an unsuffixed document column with that name would be read back on
// upload and overwrite everybody's seat with the word "Submitted".
// Deliberately listed OUT of band order — offboarding first — so the grouping in
// buildHiringDocumentColumns is doing real work rather than agreeing with the input.
const DOCUMENTS = [
  { group: 'offboarding' as const, id: 'doc-hostile', name: 'Position' },
  { group: 'required' as const, id: 'doc-nid', name: 'National ID copy' },
  // Carries a sheet_header override, the way "Medical check S 111" does on production: HR typed the
  // form number AFTER the "(document)" suffix on her own sheet and the owner asked for it verbatim.
  {
    group: 'onboarding' as const,
    id: 'doc-medical',
    name: 'Medical check',
    sheetHeader: 'Medical check (document) S 111',
  },
];

export async function buildFixtureWorkbook() {
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
    hiringDocuments: {
      definitions: DOCUMENTS,
      byHrId: new Map([
        [
          'A-1',
          new Map([
            ['doc-nid', { fileCount: 2, status: 'submitted' as const }],
            ['doc-medical', { fileCount: 0, status: 'submitted' as const }],
            ['doc-hostile', { fileCount: 0, status: 'missing' as const }],
          ]),
        ],
      ]),
    },
    socialInsuranceJobTitles: new Map([['A-1', 'مندوب دعاية طبية']]),
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

  // ── 1b. THE HEADER ROW IS FOUND BY NAME, AND THE NAME IS RENAMEABLE ──────────
  //
  // This is the regression that took HR's own rebuilt sheet out of service. The parser finds the
  // header row by looking for a cell carrying an id header AND a cell carrying a name header. That
  // name header was the single literal "full name"; HR renamed the column "Full English Name", and
  // the pair test stopped matching in a file that was otherwise perfect. No row in the first ten
  // qualified, the parser fell back to row 1 — the masthead — and every column mapped to nothing,
  // so a file full of correct data read as empty with no error naming the cause.
  //
  // So: the template's OWN name header has to be one the parser accepts. Rename the column without
  // adding the new spelling to EMPLOYEE_UPLOAD_NAME_HEADERS and this assertion is what fails,
  // rather than the next export HR fills in.
  const nameColumnHeader = employeeMasterWorkbookContract.columns.find(
    (column) => column.key === "fullName",
  )?.header;
  assert.ok(nameColumnHeader, "the contract must still carry a full-name column");
  assert.ok(
    (EMPLOYEE_UPLOAD_NAME_HEADERS as readonly string[]).includes(nameColumnHeader.toLowerCase()),
    `the template's name header "${nameColumnHeader}" is not one the upload parser accepts — ` +
      "the header row would not be found and the whole file would read as empty",
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
    "the importer scans only the first rows for a row carrying BOTH an id header and one of " +
      `EMPLOYEE_UPLOAD_NAME_HEADERS (${EMPLOYEE_UPLOAD_NAME_HEADERS.join(", ")}) — falling back to row 1 ` +
      "means it read the masthead as the header and every column mapped to nothing",
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
  assert.equal((rows[0] as Record<string, unknown>)["Full English Name"], "Person 1");


  // ── 4. an imported column's header is an API ─────────────────────────────────
  const lookup = createEmployeeColumnLookup();
  const resolves = (header: string) => lookup.get(normalizeHeaderName(header)) ?? null;

  // A LOCKED COLUMN MUST ALSO BE AN UNIMPORTED ONE, and vice versa. Until HR's layout landed this
  // was read off the section name, which held only while every locked column sat in a section
  // called "(read-only)". Social Insurance Wage now sits inside the payroll block and the document
  // columns sit in three bands of their own, so the flag is the only thing carrying that fact.
  // `locked` is the builder's own test, verbatim (styleMasterSheet): a formula column is locked by
  // FORMULA_KEYS, everything else by its own read-only flag.
  const locked = (column: (typeof employeeMasterWorkbookContract.columns)[number]) =>
    FORMULA_KEYS.has(column.key) || isReadOnlyMasterColumn(column);
  for (const column of employeeMasterWorkbookContract.columns) {
    assert.equal(
      locked(column),
      !column.imported,
      `"${column.header}" is ${column.imported ? "imported but locked" : "unlocked but not imported"} — ` +
        "a locked cell the upload reads, or an editable cell it ignores, both teach people to distrust the sheet",
    );
  }

  // The statutory filing figure keeps HR's header and HR's position, and stays locked anyway.
  const wage = employeeMasterWorkbookContract.columns.find(
    (column) => column.key === "socialInsuranceWage",
  );
  assert.ok(wage, "the Social Insurance Wage column must still exist");
  assert.equal(wage.header, "Social Insurance Wage");
  assert.equal(wage.section, "PAYROLL REFERENCE INFORMATION");
  assert.equal(wage.imported, false, "the wage that decides the statutory filing is never set by an upload");
  assert.equal(isReadOnlyMasterColumn(wage), true);

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

  // ── 6b. the hiring-document columns ─────────────────────────────────────────
  //
  // The owner asked for the master and the hiring-documents checklist to meet, so one row holds
  // everything known about a person (2026-09-29). These columns are DATA, not contract: HR adds a
  // document and a column appears. Three things about them can break silently.
  const sheetColumns = masterColumnsFor(DOCUMENTS);
  const headerRowCells = sheet.getRow(employeeMasterWorkbookContract.headerRow);
  const headerAt = (index: number) => String(headerRowCells.getCell(index + 1).value ?? '');

  assert.equal(
    sheetColumns.length,
    employeeMasterWorkbookContract.columns.length + DOCUMENTS.length + 1,
    'every tracked document gets a column, plus the one summary column',
  );
  for (const [index, column] of sheetColumns.entries()) {
    assert.equal(
      headerAt(index),
      column.header,
      `the sheet's header row must match the computed column list at position ${index + 1}`,
    );
  }

  // (0) THE THREE BANDS COME OUT IN ORDER, whatever order the checklist hands them over in. The
  // section band is drawn from RUNS of equal section names, so a single document out of group order
  // would split its own band into two and the sheet would show "Onboarding Documents" twice.
  const documentSections = sheetColumns
    .filter((column) => column.documentColumn === true)
    .map((column) => column.section);
  assert.deepEqual(
    documentSections,
    HIRING_DOCUMENT_GROUP_ORDER.map((group) => HIRING_DOCUMENT_GROUP_SECTIONS[group]),
    "the document columns must be grouped required → onboarding → offboarding, one run per band",
  );

  // (i) A DOCUMENT NAME MUST NOT BE READ BACK AS A FIELD. "Position" is a live import alias; the
  // "(document)" suffix is what keeps every one of these headers outside the alias table.
  for (const document of DOCUMENTS) {
    const header = documentColumnHeader(document);
    assert.ok(
      sheetColumns.some((column) => column.header === header),
      `the document column for "${document.name}" must carry the (document) suffix`,
    );
    assert.equal(
      resolves(header),
      null,
      `"${header}" matches an import alias — an upload would write "Submitted" into that field`,
    );
  }

  // (ii) The values reach the sheet, including the one combination worth looking at: a ticked box
  // with nothing attached.
  const documentColumnIndex = (name: string) => {
    const document = DOCUMENTS.find((candidate) => candidate.name === name);
    assert.ok(document, `no fixture document named "${name}"`);
    return sheetColumns.findIndex((column) => column.header === documentColumnHeader(document)) + 1;
  };
  const firstDataRow = sheet.getRow(employeeMasterWorkbookContract.firstDataRow);
  assert.equal(String(firstDataRow.getCell(documentColumnIndex('National ID copy')).value ?? ''), 'Submitted · 2 files');
  assert.equal(String(firstDataRow.getCell(documentColumnIndex('Medical check')).value ?? ''), 'Submitted · no file');
  assert.equal(String(firstDataRow.getCell(documentColumnIndex('Position')).value ?? ''), 'Missing');
  const summaryColumn = sheetColumns.find((column) => column.header === 'Hiring Documents Complete (reference)');
  assert.ok(summaryColumn, 'the hiring-documents summary column must exist');
  assert.equal(summaryColumn.section, 'REFERENCE (READ-ONLY)', 'the summary sits with the other reference columns');
  const summaryIndex = sheetColumns.indexOf(summaryColumn) + 1;
  assert.equal(String(firstDataRow.getCell(summaryIndex).value ?? ''), '2 of 3');

  // (iii) An employee the checklist does not cover reads BLANK, never "Missing" — the export can be
  // wider than the checklist, and "Missing" would accuse a leaver of never filing a paper nobody
  // asked them for. Row 2 of the fixture has no checklist entry at all.
  const secondDataRow = sheet.getRow(employeeMasterWorkbookContract.firstDataRow + 1);
  for (const document of DOCUMENTS) {
    assert.equal(
      String(secondDataRow.getCell(documentColumnIndex(document.name)).value ?? ''),
      '',
      'an employee outside the checklist must read blank, not "Missing"',
    );
  }

  // (iv) The insurance job title is the hiring profile's Arabic title, merged in by HR_ID.
  const titleIndex = sheetColumns.findIndex((column) => column.header === 'Social Insurance Job Title') + 1;
  assert.equal(String(firstDataRow.getCell(titleIndex).value ?? ''), 'مندوب دعاية طبية');
  assert.equal(String(secondDataRow.getCell(titleIndex).value ?? ''), '');

  // ── 6c. the HR record fields reach the sheet ────────────────────────────────
  //
  // Twelve columns HR was keeping in a private spreadsheet until 2026-09-29. They are plain
  // records — nothing derives a payroll figure from any of them — but a column that exports blank
  // is a column HR fills in twice, so each one is checked against the fixture value.
  const cellByHeader = (row: typeof firstDataRow, header: string) => {
    const index = sheetColumns.findIndex((column) => column.header === header);
    assert.ok(index >= 0, `the sheet must carry a "${header}" column`);
    return String(row.getCell(index + 1).value ?? '');
  };
  for (const [header, expected] of [
    ['Birth Place', 'Giza'],
    ['Qualification (Bachelor - license)', 'Bachelor - license'],
    // "College Name" IS employees.education — Pharmacy in the fixture, which is what that column
    // has always held and what the eligible-degree rule reads.
    ['College Name', 'Pharmacy'],
    ['University Name', 'Cairo University'],
    ['College major', 'Pharmacology'],
    ['senior year', '2019'],
    ['Total years of experience', '2.5'],
    ['contract duration', '1 Year'],
    ['End date of probation period', '2022-09-01'],
    ['Contract Renewal Date', '2027-01-01'],
    ['Medical Insurance Card Receipt Date', '2022-07-01'],
    ['Social insurance start date', '2022-06-01'],
    ['Kaab Elamaal Number', 'KE-1'],
    ['Kaab Elamaal Issuer', 'Giza Labour Office'],
    ['Kaab Elamaal Issue Date', '2022-05-20'],
    ['Kaab Elamaal refund (Yes-No)', 'no'],
  ] as const) {
    assert.equal(cellByHeader(firstDataRow, header), expected, `"${header}" must carry its value`);
  }

  // ── 6c-bis. Total years of experience goes back in as a number ─────────────
  //
  // HR bulk-fills it for the Medical Reps from this sheet (owner, 2026-10-31), so the exported
  // cell has to read back through the real parser and validator as the same number. A blank cell
  // and an absent column both leave the saved value alone (null is omitted by the confirm step);
  // 0 is a value, not a blank; anything outside 0 to 60 blocks its row with the form's own sentence.
  const experienceHeader = 'Total years of experience';
  const exportedExperience = (rows[0] as Record<string, unknown>)[experienceHeader];
  assert.equal(exportedExperience, 2.5, 'the parser must read the exported cell back as the number 2.5');
  const experienceState = { employeeHrIds: new Set<string>(), employeeHrIdByCanonicalKey: new Map() };
  const experienceRow = (hrId: string, cell?: unknown) => ({
    'Employee ID': hrId,
    'Full English Name': `Person ${hrId}`,
    ...(cell === undefined ? {} : { [experienceHeader]: cell }),
  });
  const experience = validateEmployeeImportRows(
    [
      experienceRow('T-1', exportedExperience),
      experienceRow('T-2', '0'),
      experienceRow('T-3', ''),
      experienceRow('T-4', '-'),
      experienceRow('T-5', '3.27'),
      experienceRow('T-6', 'seven'),
      experienceRow('T-7', 61),
    ],
    { existingState: experienceState },
  );
  const yearsByHrId = new Map(experience.rowsToInsert.map((record) => [record.hrId, record.totalExperienceYears]));
  assert.equal(yearsByHrId.get('T-1'), 2.5, 'the exported value round-trips unchanged');
  assert.equal(yearsByHrId.get('T-2'), 0, '0 years is a value HR typed, not a blank cell');
  assert.equal(yearsByHrId.get('T-3'), null, 'a blank cell is null — the confirm step leaves the saved value alone');
  assert.equal(yearsByHrId.get('T-4'), null, '"-" is blank here exactly as it is in every other text column');
  assert.equal(yearsByHrId.get('T-5'), 3.3, 'kept to one decimal, the same rule the employee form saves with');
  const experienceErrors = experience.validationErrors.filter((issue) => issue.field === 'totalExperienceYears');
  assert.deepEqual(
    experienceErrors.map((issue) => issue.code),
    ['invalid_total_experience_years', 'invalid_total_experience_years'],
    '"seven" and 61 each block their own row; 0, a blank, "-" and 3.27 do not',
  );
  assert.ok(!yearsByHrId.has('T-6') && !yearsByHrId.has('T-7'), 'a blocked row is never planned for a write');
  assert.match(experienceErrors[0].message, /from 0 to 60, for example 2 or 0\.5/, "the row error is the rule's own sentence");
  const absent = validateEmployeeImportRows([experienceRow('T-8')], { existingState: experienceState });
  assert.equal(
    absent.rowsToInsert[0]?.totalExperienceYears,
    null,
    'a sheet without the column must leave the value untouched — null, never a cleared value',
  );
  assert.equal(absent.validationErrors.length, 0, 'a sheet without the column is not an error');

  // ── 6d. the section bands are HR's own words, not upper-cased ────────────────
  const sectionRowCells = sheet.getRow(employeeMasterWorkbookContract.sectionRow);
  const bandAt = (index: number) => String(sectionRowCells.getCell(index + 1).value ?? '');
  for (const [label, headerUnderIt] of [
    ['Personal Information', 'Employee ID'],
    ['Educational Qualifications', 'Qualification (Bachelor - license)'],
    ['Contract Data', 'Hiring Date'],
    ['Private Medical Insurance', 'Medical Insurance Card Number'],
    ['Government Medical Insurance', 'Health Insurance Card Number'],
    ['Government Social Insurance', 'In Social Insurance'],
    ['Registration certificate information', 'Kaab Elamaal Number'],
  ] as const) {
    const index = sheetColumns.findIndex((column) => column.header === headerUnderIt);
    assert.ok(index >= 0, `the sheet must carry "${headerUnderIt}"`);
    assert.equal(
      bandAt(index),
      label,
      `the band opening at "${headerUnderIt}" must read "${label}" — HR wrote these labels and the ` +
        'builder must not upper-case them',
    );
  }

  // ── 6d-bis. a sheet_header override is honoured, and CANNOT drop the suffix ──
  //
  // HR's sheet prints "Medical check (document) S 111" — the form number after the suffix, not
  // before it — and the owner asked for that cell verbatim (2026-09-30). The override exists so the
  // Hiring Documents screen can keep reading "Medical check S 111" while the sheet prints her
  // wording.
  //
  // THE SECOND HALF IS THE ONE THAT MATTERS. A column header is what the upload matches fields on,
  // so an override that dropped "(document)" would put a document name back into the alias table —
  // and "Position" is a live alias. The helper ignores such an override rather than honouring it,
  // which is why this asserts the FALLBACK and not an error.
  assert.equal(
    documentColumnHeader({ id: 'x', name: 'Medical check', sheetHeader: 'Medical check (document) S 111' }),
    'Medical check (document) S 111',
    'an override carrying the suffix is printed verbatim',
  );
  assert.equal(
    documentColumnHeader({ id: 'x', name: 'Position', sheetHeader: 'Position' }),
    'Position (document)',
    'an override that drops "(document)" must be IGNORED — honouring it would let a document ' +
      'named "Position" be read back on upload and overwrite every seat with the word "Submitted"',
  );
  assert.equal(
    resolves(documentColumnHeader({ id: 'x', name: 'Position', sheetHeader: 'Position' })),
    null,
    'the fallback header must still sit outside the import alias table',
  );
  assert.ok(
    sheetColumns.some((column) => column.header === 'Medical check (document) S 111'),
    "the fixture's override must reach the sheet",
  );

  // ── 6e. the reference band is SPLIT, the way HR's own sheet has it ──────────
  //
  // HR bands "REFERENCE (READ-ONLY)" over Last Updated alone and leaves the cell above "Hiring
  // Documents Complete" filled but blank — the two are not merged. The owner asked for her sheet
  // verbatim and named this merge himself (2026-09-30), so it is pinned rather than left to
  // whichever way the run-grouping happens to fall.
  //
  // Measured against her file before and after: with the band keyed on the SECTION the two merged
  // and her layout had 14 row-4 merge runs to our 15; keyed on the LABEL they match exactly.
  const summary = sheetColumns.find((column) => column.key === HIRING_DOCUMENTS_SUMMARY_KEY);
  assert.ok(summary, 'the hiring-documents summary column must exist');
  assert.equal(
    summary.bandLabel,
    '',
    'the summary column must carry an EMPTY band label — that empty label is the only thing that ' +
      'splits the reference run, and without it the band merges across both reference columns',
  );
  const summaryIndexInSheet = sheetColumns.indexOf(summary);
  const beforeSummary = sheetColumns[summaryIndexInSheet - 1];
  assert.equal(beforeSummary?.section, summary.section, 'the two reference columns share a section');
  assert.equal(
    String(sectionRowCells.getCell(summaryIndexInSheet + 1).value ?? ''),
    '',
    'the band cell above the summary column reads blank, exactly as HR has it',
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
