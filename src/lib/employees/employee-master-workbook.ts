/**
 * The Employee Master workbook — the file HR downloads, edits, and uploads back.
 *
 * This is both halves of one round trip. It is the EXPORT of every employee the caller may see, and
 * it is the IMPORT TEMPLATE those same rows come back in, so the sheet's job is not to look like a
 * report: it is to make a wrong upload visibly wrong while the person is still in Excel, before the
 * server has to say no.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * FOUR THINGS HERE ARE LOAD-BEARING. Change any of them and the import breaks silently.
 *
 * 1. THE MASTER SHEET MUST BE THE FIRST WORKSHEET. `app/api/imports/employees/dry-run/route.ts`
 *    takes `firstExcelWorksheet(workbook)` — literally `worksheets[0]` — and never looks at a tab
 *    by name. Moving the cover sheet to the front, which is the obvious way to make a workbook feel
 *    finished, would hand the importer a page of prose and it would answer "empty_worksheet".
 *    The cover is instead made the ACTIVE tab (`workbook.views.activeTab`), which looks the same on
 *    open and costs nothing.
 *
 * 2. THE HEADER ROW MUST SIT IN THE FIRST TEN ROWS, and must carry both "Employee ID" and
 *    "Full Name". That same route scans rows 1..10 for a row holding one of
 *    employee id / hr_id / hr id / employee code AND the exact text "full name". It stops at the
 *    first match. The masthead is three rows and the section band is one, so the header lands on
 *    row 5 — see HEADER_ROW. Four spare rows is the whole budget for anything added above it.
 *
 * 3. EVERY FORMULA MUST EVALUATE TO "" ON AN OTHERWISE-BLANK ROW. `excelWorksheetToJsonRows` drops
 *    a row only when EVERY cell reads empty, and it reads a formula cell through its cached result.
 *    Spare rows carry formulas so a newly typed row lights up immediately — but if one of those
 *    formulas returned any text on a blank row, all SPARE_ROWS of them would arrive at the importer
 *    as real rows, each failing with "missing_hr_id". Both formula columns therefore open with a
 *    COUNTA guard on the row. `tests/employee-master-workbook.test.ts` pins this.
 *
 * 4. A COLUMN HEADER IS AN API. `src/lib/imports/employee-column-map.ts` matches columns by header
 *    text against an alias list. Renaming "In Social Insurance" to something tidier does not fail —
 *    the column just stops being read, and the upload silently stops updating that field. Headers
 *    below are annotated with whether the importer reads them; the ones marked `imported: false`
 *    are deliberately named so they match NO alias.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE SHEET FLAGS, IT NEVER BLOCKS. Every dropdown is `showErrorMessage: false` and every check is a
 * formula or a conditional format, so nothing here can refuse a paste. That is deliberate and it
 * matches how the rest of the platform behaves — the system flags an expense, it never auto-rejects
 * one. A template that rejects a bulk paste gets worked around by pasting into a fresh sheet, which
 * loses every guard in this file at once.
 *
 * ROW CHECK ONLY REPORTS WHAT THE SERVER ACTUALLY REJECTS. Every clause in `buildRowCheckFormula`
 * corresponds to a real error code in `src/lib/imports/employee-validator.ts`. It is tempting to add
 * plausible-looking checks (a 14-digit national id, a phone shape) but a sheet that flags something
 * the server accepts teaches people to ignore the column, and then it stops working for the eight
 * checks that are real.
 */

import ExcelJS from "exceljs";
import { HOUSE_XLSX_DISPLAY_FONT, HOUSE_XLSX_FONT, HOUSE_XLSX_MONO_FONT } from "@/lib/export/house-xlsx-palette";

import { systemDocuments, systemLegalEntity } from "@/config/system-settings";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployeeMasterExportSalary } from "@/lib/employees/employee-master-export";
import {
  AREAS_LIST_NAME,
  areaTeamValidationFormula,
  buildAreaTeamRanges,
} from "@/lib/employees/template-lookup-names";
import {
  HOUSE_DOCUMENT_STANDARD,
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCalloutStyle,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import {
  columns,
  FIRST_DATA_ROW,
  FORMULA_KEYS,
  GENDER_VALUES,
  HEADER_ROW,
  type HiringDocumentColumnSpec,
  HIRING_DOCUMENTS_SUMMARY_KEY,
  hiringDocumentIdFromKey,
  isReadOnlyMasterColumn,
  CONTRACT_VALUES,
  type MasterColumn,
  masterColumnsFor,
  type MasterRow,
  PAYMENT_MODE_VALUES,
  SECTION_ROW,
  SPARE_ROWS,
  STATUS_VALUES,
  YES_NO,
  YES_NO_PENDING,
} from "@/lib/employees/employee-master-columns";
import {
  NEW_EMPLOYEE_NOT_ALLOWED_CODE,
  SALARY_BLIND_MONEY_COLUMNS_CODE,
} from "@/lib/imports/employee-import-salary-blind";
import { PAY_FLAG_KEPT_CODE } from "@/lib/employees/salary-blind-pay-flags";
import { BASIC_SALARY_RATE } from "@/lib/payroll/policy";

export type MasterLookups = {
  departments: string[];
  teams: Array<{ label: string; areaId: number | null }>;
  lines: Array<{ label: string; id: number | null }>;
  areas: Array<{ label: string; value: string }>;
  positions: string[];
  managerDirectory: Array<{ hrId: string; fullName: string }>;
};

export function columnLetter(index: number): string {
  let remaining = index;
  let out = "";
  while (remaining > 0) {
    const rest = (remaining - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

const columnIndex = (key: keyof MasterRow) => columns.findIndex((column) => column.key === key) + 1;
const letterOf = (key: keyof MasterRow) => columnLetter(columnIndex(key));

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : null;
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

/**
 * One employee's hiring-document checklist cell, as the master sheet reports it.
 *
 * `fileCount` travels with the status on purpose: "Submitted" with nothing attached is the single
 * combination worth looking at, because it means somebody ticked the box from memory.
 */
export type MasterHiringDocumentCell = { fileCount: number; status: "missing" | "pending" | "submitted" };

export type EmployeeMasterHiringDocuments = {
  definitions: HiringDocumentColumnSpec[];
  /** HR id -> document id -> cell. Absent keys read blank, never as "Missing". */
  byHrId: Map<string, Map<string, MasterHiringDocumentCell>>;
};

/**
 * What a hiring-document cell says.
 *
 * A BLANK, NOT A WORD, for an employee the checklist does not cover. The checklist tracks the
 * people Phoenix currently employs, and the master export can be wider than that — writing
 * "Missing" against a leaver would state, in the same words the checklist uses for a real gap, that
 * somebody never filed a paper nobody was asking them for.
 */
export function formatHiringDocumentCell(cell: MasterHiringDocumentCell | undefined): string {
  if (!cell) return "";
  if (cell.status === "submitted") {
    if (cell.fileCount === 0) return "Submitted · no file";
    return `Submitted · ${cell.fileCount} file${cell.fileCount === 1 ? "" : "s"}`;
  }
  const label = cell.status === "missing" ? "Missing" : "Pending";
  return cell.fileCount > 0 ? `${label} · ${cell.fileCount} file${cell.fileCount === 1 ? "" : "s"}` : label;
}

/** "12 of 17", or blank for an employee the checklist does not cover. */
export function formatHiringDocumentSummary(
  cells: Map<string, MasterHiringDocumentCell> | undefined,
  definitions: HiringDocumentColumnSpec[],
): string {
  if (!cells || definitions.length === 0) return "";
  const submitted = definitions.filter((document) => cells.get(document.id)?.status === "submitted").length;
  return `${submitted} of ${definitions.length}`;
}

export function employeeToMasterRow(
  employee: EmployeeDirectoryRow,
  socialInsuranceJobTitle: string | null = null,
): MasterRow {
  const salary = resolveEmployeeMasterExportSalary(employee);

  return {
    rowCheck: null,
    employeeId: employee.hrId,
    fullName: employee.fullName,
    nickname: employee.nickname,
    arabicName: employee.nameAr,
    nationalId: employee.nationalId,
    gender: employee.gender,
    birthDate: dateOnly(employee.birthDate),
    birthPlace: employee.birthPlace,
    education: employee.education,
    qualification: employee.qualification,
    universityName: employee.universityName,
    collegeMajor: employee.collegeMajor,
    seniorYear: employee.seniorYear,
    totalExperienceYears: employee.totalExperienceYears ?? null,
    department: employee.departmentName,
    line: employee.lineName,
    area: employee.areaName,
    team: employee.teamName,
    jobTitle: employee.jobTitle,
    position: employee.positionTitle,
    directManagerId: employee.managerHrId,
    directManagerName: null,
    hireDate: dateOnly(employee.hireDate),
    probationEndDate: dateOnly(employee.probationEndDate),
    employmentStatus: employee.employmentStatus ?? "active",
    contractType: employee.contractType,
    contractDuration: employee.contractDuration,
    workEmail: employee.workEmail,
    mobileNumber: employee.mobileNumber,
    residenceAddress: employee.residenceAddress,
    residenceCity: employee.residenceCity,
    residenceArea: employee.residenceArea,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    basicSalary: salary.basicSalary,
    baseSalary: salary.baseSalary,
    grossSalary: salary.grossSalary,
    netSalary: salary.netSalary,
    fuelAllowance: employee.fuelAllowance,
    extraCostOfLiving: employee.extraCostOfLiving,
    medicalInsurance: employee.medicalInsurance,
    socialInsurance: employee.socialInsurance,
    taxes: employee.taxes,
    paymentMode: employee.salaryPaymentMode,
    hasBankAccount: employee.hasBankAccount ?? (employee.bankAccount ? "yes" : null),
    bankName: employee.bankName,
    bankAccount: employee.bankAccount,
    medicalInsuranceStatus: employee.medicalInsuranceStatus,
    medicalInsuranceNumber: employee.medicalInsuranceNumber,
    medicalInsuranceCardReceivedDate: dateOnly(employee.medicalInsuranceCardReceivedDate),
    socialInsuranceStatus: employee.socialInsuranceStatus,
    socialInsuranceNumber: employee.socialInsuranceNumber,
    socialInsuranceJobTitle,
    socialInsuranceStartDate: dateOnly(employee.socialInsuranceStartDate),
    kaabElamaalNumber: employee.kaabElamaalNumber,
    kaabElamaalIssuer: employee.kaabElamaalIssuer,
    kaabElamaalIssueDate: dateOnly(employee.kaabElamaalIssueDate),
    kaabElamaalRefund: employee.kaabElamaalRefund,
    healthCardStatus: employee.healthCardStatus,
    healthCardNumber: employee.healthCardNumber,
    healthCardReceivedDate: dateOnly(employee.healthCardReceivedDate),
    payrollEligible: yesNo(employee.payrollEligible),
    organogramVisible: yesNo(employee.organogramVisible),
    region: employee.regionName,
    socialInsuranceWage: employee.socialInsuranceWage,
    contractRenewalDate: dateOnly(employee.contractRenewalDate),
    lastUpdated: dateOnly(employee.updatedAt) ?? employee.updatedAt,
  };
}

/**
 * The contiguous block of money columns, or null if a future edit ever splits them.
 *
 * The row check COUNTAs this block to notice cleared salary cells. If someone reorders the columns
 * and puts a text field in the middle, COUNTA would start counting that too and the check would
 * report cleared money that was never cleared — so it degrades to "no check" instead, which is
 * wrong-but-silent rather than wrong-but-loud.
 */
function resolveMoneyRange(): { first: number; last: number } | null {
  const indexes = columns
    .map((column, index) => (column.kind === "money" && column.imported ? index + 1 : null))
    .filter((index): index is number => index !== null);
  if (indexes.length === 0) return null;
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  return last - first + 1 === indexes.length ? { first, last } : null;
}

export type RowCheckInput = {
  rowNumber: number;
  /** Last row that carries formulas — the COUNTIF window for the duplicate test. */
  lastRow: number;
  /** How many money cells this row had when it was exported. 0 for a spare row. */
  originalMoneyFilled: number;
  hasAreas: boolean;
  hasDepartments: boolean;
  hasManagers: boolean;
  /**
   * The sheet carries no money (a salary-blind export — see BuildEmployeeMasterWorkbookInput). The
   * cleared-payroll advisory is dropped: there is nothing to clear, and its advice to "type 0" is
   * exactly what that seat's upload refuses.
   */
  omitMoney?: boolean;
};

/**
 * The live row check.
 *
 * Every clause maps to an error code the server really raises — missing_hr_id, missing_full_name,
 * a duplicate key, self_manager_assignment, invalid_email, lifecycle_status_import_blocked,
 * unmapped_area, invalid_department — plus one advisory about cleared money that is not an error at
 * all but is the mistake most worth catching, because it fails SILENTLY: a blank salary cell is
 * omitted from the update rather than written, so clearing a cell to zero someone's allowance does
 * nothing whatsoever and the number stays exactly as it was.
 *
 * THE FIRST CLAUSE IS THE INVARIANT FROM CONSTRAINT 3. A row with nothing typed in it returns the
 * empty string, so the importer's "every cell is empty" test still drops the spare rows.
 */
export function buildRowCheckFormula(input: RowCheckInput): string {
  const { rowNumber: row, lastRow, originalMoneyFilled, hasAreas, hasDepartments, hasManagers } = input;

  const id = `$${letterOf("employeeId")}${row}`;
  const name = `${letterOf("fullName")}${row}`;
  const manager = `${letterOf("directManagerId")}${row}`;
  const email = `${letterOf("workEmail")}${row}`;
  const status = `${letterOf("employmentStatus")}${row}`;
  const area = `${letterOf("area")}${row}`;
  const department = `${letterOf("department")}${row}`;

  const idColumn = letterOf("employeeId");
  const idRange = `$${idColumn}$${FIRST_DATA_ROW}:$${idColumn}$${lastRow}`;

  const clauses: Array<[condition: string, message: string]> = [
    [`${id}=""`, "Missing Employee ID — the upload cannot match this row"],
    [`${name}=""`, "Missing Full Name"],
    [`COUNTIF(${idRange},${id})>1`, "Duplicate Employee ID in this file"],
    [`AND(${manager}<>"",${manager}=${id})`, "An employee cannot be their own manager"],
  ];

  if (hasManagers) {
    clauses.push([
      `AND(${manager}<>"",ISNA(MATCH(${manager},MANAGER_HR_IDS,0)))`,
      "Manager HR_ID is not in the directory",
    ]);
  }

  clauses.push([
    `AND(${email}<>"",ISERROR(FIND("@",${email})))`,
    "Work email is not a valid address",
  ]);
  clauses.push([
    `AND(${status}<>"",${status}<>"active",${status}<>"on_leave")`,
    "Only active or on_leave can be uploaded — use the lifecycle workflow",
  ]);

  if (hasAreas) {
    clauses.push([
      `AND(${area}<>"",ISNA(MATCH(${area},${AREAS_LIST_NAME},0)))`,
      "Area is not an active area — the upload will block this row",
    ]);
  }
  if (hasDepartments) {
    clauses.push([
      `AND(${department}<>"",ISNA(MATCH(${department},DEPARTMENTS_LIST,0)))`,
      "Department is not an active department",
    ]);
  }

  const money = input.omitMoney ? null : resolveMoneyRange();
  if (money && originalMoneyFilled > 0) {
    const range = `${columnLetter(money.first)}${row}:${columnLetter(money.last)}${row}`;
    clauses.push([
      `COUNTA(${range})<${originalMoneyFilled}`,
      "A payroll cell was cleared — blanks are IGNORED on upload, so type 0 to actually zero it",
    ]);
  }

  // Nested IFs rather than IFS(): IFS needs Excel 2019+, and this file is opened in whatever is
  // installed on the machine that downloads it.
  const body = clauses.reduceRight(
    (inner, [condition, message]) => `IF(${condition},"${message}",${inner})`,
    '"Ready"',
  );

  return `=IF(COUNTA(${rowDataRanges(row)})=0,"",${body})`;
}

/**
 * The row's own cells, as COUNTA ranges, with the FORMULA columns cut out.
 *
 * COUNTA COUNTS A FORMULA THAT RETURNS THE EMPTY STRING. The cell is not empty — it holds a
 * formula — so a plain `COUNTA(B7:AX7)` over a blank spare row returned 1, not 0, purely because
 * the "Direct Manager (auto)" cell in the middle of that span carries one. The blank-row guard
 * therefore never fired and all 250 spare rows rendered "Missing Employee ID" in red down the
 * whole sheet. It was invisible in the source and obvious the moment the file was rendered.
 *
 * So the guard counts only the columns a PERSON types into, skipping every formula column, which
 * is derived from FORMULA_KEYS rather than hardcoded — adding a third formula column later would
 * otherwise silently bring the wall of red back.
 */
function rowDataRanges(row: number): string {
  const spans: Array<[number, number]> = [];
  for (let index = 2; index <= columns.length; index += 1) {
    if (FORMULA_KEYS.has(columns[index - 1].key)) continue;
    const previous = spans[spans.length - 1];
    if (previous && previous[1] === index - 1) previous[1] = index;
    else spans.push([index, index]);
  }
  return spans
    .map(([from, to]) => `${columnLetter(from)}${row}:${columnLetter(to)}${row}`)
    .join(",");
}

/** The live "Direct Manager (auto)" lookup. Also returns "" on a blank row — constraint 3. */
export function buildManagerNameFormula(rowNumber: number): string {
  const manager = `${letterOf("directManagerId")}${rowNumber}`;
  return `=IF(${manager}="","",IFERROR(VLOOKUP(${manager},MANAGER_DIRECTORY,2,FALSE),"(not found)"))`;
}

/**
 * The hidden machine sheet: flat lists, one range per area's teams, and the manager directory.
 *
 * Every list is registered even when EMPTY, pointing at the blank cell under its header. A missing
 * defined name makes the INDIRECT in the Team cascade resolve to #REF!, which kills that cell's
 * validation outright — which is how all 23 team-less areas once ended up with a dead dropdown.
 */
function addLookupSheet(workbook: ExcelJS.Workbook, lookups: MasterLookups) {
  const sheet = workbook.addWorksheet("Lookup Data", { state: "veryHidden" });
  let column = 1;

  function writeList(name: string, header: string, values: string[]) {
    const letter = columnLetter(column);
    sheet.getCell(1, column).value = header;
    values.forEach((value, index) => {
      sheet.getCell(2 + index, column).value = value;
    });
    const lastRow = Math.max(2, 1 + values.length);
    workbook.definedNames.add(`'Lookup Data'!$${letter}$2:$${letter}$${lastRow}`, name);
    column += 1;
  }

  writeList("LINES_LIST", "Lines", lookups.lines.map((line) => line.label));
  writeList("POSITIONS_LIST", "Positions", lookups.positions);
  writeList("DEPARTMENTS_LIST", "Departments", lookups.departments);

  // Area is NOT cascaded from Line: areas are geographic territories and nearly every area has a
  // dedicated rep per line, so a per-line cascade would either hide valid areas or degrade to
  // "show them all anyway".
  writeList(AREAS_LIST_NAME, "Areas", lookups.areas.map((area) => area.label));

  // Area -> Teams, numbered by the area's POSITION in AREAS_LIST rather than by a token derived
  // from its label, so the builder and the live MATCH cannot drift apart.
  for (const range of buildAreaTeamRanges({ areas: lookups.areas, teams: lookups.teams })) {
    writeList(range.name, range.header, range.teamLabels);
  }

  // MANAGER_HR_IDS is a single column for MATCH; MANAGER_DIRECTORY spans both for VLOOKUP.
  const hrIdColumn = column;
  const nameColumn = column + 1;
  sheet.getCell(1, hrIdColumn).value = "Manager HR_ID";
  sheet.getCell(1, nameColumn).value = "Manager Full Name";
  lookups.managerDirectory.forEach((manager, index) => {
    sheet.getCell(2 + index, hrIdColumn).value = manager.hrId;
    sheet.getCell(2 + index, nameColumn).value = manager.fullName;
  });
  const hrIdLetter = columnLetter(hrIdColumn);
  const nameLetter = columnLetter(nameColumn);
  const lastRow = Math.max(2, 1 + lookups.managerDirectory.length);
  workbook.definedNames.add(`'Lookup Data'!$${hrIdLetter}$2:$${nameLetter}$${lastRow}`, "MANAGER_DIRECTORY");
  workbook.definedNames.add(`'Lookup Data'!$${hrIdLetter}$2:$${hrIdLetter}$${lastRow}`, "MANAGER_HR_IDS");
}

function styleMasterSheet(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  lookups: MasterLookups,
  rows: MasterRow[],
  scopeNote: string,
  sheetColumns: MasterColumn[],
  options: { omitMoney?: boolean } = {},
) {
  const omitMoney = options.omitMoney === true;
  const recordCount = rows.length;
  const lastDataRow = FIRST_DATA_ROW + recordCount - 1;
  const lastFormulaRow = lastDataRow + SPARE_ROWS;
  const lastColumn = sheetColumns.length;

  writeHouseMasthead(workbook, sheet, {
    title: "Employee Master",
    subtitle:
      "Edit in place and upload from Employees. Column A checks each row as you type — nothing here blocks an edit.",
    provenance: [
      `${recordCount} record${recordCount === 1 ? "" : "s"}`,
      `Generated ${new Date().toISOString().slice(0, 10)}`,
      scopeNote,
    ],
    columns: lastColumn,
  });

  // Gridlines off: the format carries its own rules, and the default grid fights them.
  sheet.views = [{ state: "frozen", xSplit: 3, ySplit: HEADER_ROW, showGridLines: false }];
  sheet.autoFilter = {
    from: { column: 1, row: HEADER_ROW },
    to: { column: lastColumn, row: HEADER_ROW },
  };
  sheet.properties.defaultRowHeight = 18;

  sheetColumns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.width;
    // Reference columns collapse into an outline group — present for an audit, out of the way
    // the rest of the time.
    excelColumn.outlineLevel = isReadOnlyMasterColumn(column) ? 1 : 0;
  });

  // --- section band: type and a rule, never a filled block ---
  // ── the section band ────────────────────────────────────────────────────────
  //
  // Seventeen sections across ninety-odd columns, and until 2026-09-05 each was a 7.5pt label in the
  // FIRST cell of its run with the rest of the run left blank and unmerged — so "PAYROLL REFERENCE
  // INFORMATION" floated above one column of the nine it covers and told the reader nothing about
  // where the section ended. The owner said the sheet needed more, and this was the largest part of
  // what was missing: the grouping existed in the data and not on the page.
  //
  // Each run is now MERGED across its own columns and given the deep ground, which makes the header
  // two-tier — section over column — and lets a reader see at a glance that columns 24 to 32 are one
  // idea. The merge is what does the work; the ground is what makes the merge visible.
  //
  // THE LABEL IS NOT UPPER-CASED. It used to be, which was fine while the section names were the
  // code's own. They are HR's now — "Personal Information", "Registration certificate information" —
  // and the owner asked for her sheet verbatim (2026-09-29), so the band prints what the contract
  // says. The ones that read as shouting up there do so because she wrote them that way.
  const sectionRow = sheet.getRow(SECTION_ROW);
  sectionRow.height = 18;
  const runs: Array<{ from: number; label: string; to: number }> = [];
  const bandLabelOf = (column: MasterColumn) => column.bandLabel ?? column.section;
  sheetColumns.forEach((column, index) => {
    const previous = sheetColumns[index - 1];
    if (!previous || bandLabelOf(previous) !== bandLabelOf(column)) {
      runs.push({ from: index + 1, label: bandLabelOf(column), to: index + 1 });
    } else {
      runs[runs.length - 1].to = index + 1;
    }
  });
  for (const run of runs) {
    if (run.to > run.from) sheet.mergeCells(SECTION_ROW, run.from, SECTION_ROW, run.to);
    const cell = sectionRow.getCell(run.from);
    cell.value = run.label;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.white }, name: HOUSE_XLSX_FONT, size: 8 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    for (let column = run.from; column <= run.to; column += 1) {
      const banded = sectionRow.getCell(column);
      banded.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.deep }, pattern: "solid", type: "pattern" };
      // A hairline in the blue between sections, so two adjacent runs do not read as one long band.
      banded.border = {
        left: column === run.from ? { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } } : undefined,
        right: column === run.to ? { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } } : undefined,
      };
    }
  }

  // ── collapsible groups over the columns the upload does NOT read ─────────────
  //
  // Fifty columns is more than fits a screen, and a third of them are reference the importer
  // ignores. Those get an outline group, so a reader filling the sheet can fold away everything
  // that cannot affect the upload and keep what can.
  //
  // Grouped, NOT hidden: the +/- control appears and the columns stay visible until someone chooses
  // otherwise. Hiding a column on an upload template by default would be a way to lose a value
  // silently, which is the opposite of what this sheet is for.
  sheetColumns.forEach((column, index) => {
    if (!column.imported) sheet.getColumn(index + 1).outlineLevel = 1;
  });

  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 30;
  sheetColumns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    houseHeaderStyle(cell);
    if (!column.imported) {
      // Not read on upload — said quietly in the type rather than with a badge. Muted grey was that
      // quiet voice when the header was type on white; on the Brand Blue band it is simply hard to
      // read, so the distinction moves to italic at the same weight the rest of the header carries.
      cell.font = { ...cell.font, italic: true };
    }
  });

  // --- body ---
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastDataRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 17;
    const zebra = (rowNumber - FIRST_DATA_ROW) % 2 === 1;
    sheetColumns.forEach((_column, index) => {
      houseBodyStyle(row.getCell(index + 1), { zebra });
    });
  }

  sheetColumns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    if (column.kind === "money") excelColumn.numFmt = "#,##0.00";
    if (column.kind === "date") excelColumn.numFmt = "yyyy-mm-dd";
  });

  // ── a salary-blind export HIDES the money columns, it never REMOVES them ─────
  //
  // Every position on this sheet is computed from the static `columns` contract — `columnIndex`,
  // `letterOf`, the row check, the formats, the read-only marks — so dropping a column would shift
  // every letter after it and point the importer's alias map and the row check at the wrong cells.
  // Hidden and empty keeps every letter where it is. The sheet is unprotected, so a reader can
  // unhide them — and finds nothing: this seat's directory reaches the builder with every figure
  // redacted, so the money columns of a salary-blind export are hidden AND empty.
  if (omitMoney) {
    sheetColumns.forEach((column, index) => {
      if (column.kind === "money") sheet.getColumn(index + 1).hidden = true;
    });
  }

  // --- validations, on data and spare rows alike ---
  const areaLetter = letterOf("area");
  const listCell = (rowNumber: number, key: keyof MasterRow) => sheet.getCell(rowNumber, columnIndex(key));

  // Nothing here sets showErrorMessage — a dropdown that refuses a paste gets worked around by
  // pasting into a clean sheet, which drops every guard in this file at once.
  const inlineList = (values: string) => ({
    allowBlank: true,
    formulae: [`"${values}"`],
    showErrorMessage: false,
    type: "list" as const,
  });

  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastFormulaRow; rowNumber += 1) {
    listCell(rowNumber, "gender").dataValidation = inlineList(GENDER_VALUES);
    listCell(rowNumber, "contractType").dataValidation = inlineList(CONTRACT_VALUES);
    listCell(rowNumber, "paymentMode").dataValidation = inlineList(PAYMENT_MODE_VALUES);
    listCell(rowNumber, "hasBankAccount").dataValidation = inlineList(YES_NO);
    listCell(rowNumber, "medicalInsuranceStatus").dataValidation = inlineList(YES_NO_PENDING);
    listCell(rowNumber, "socialInsuranceStatus").dataValidation = inlineList(YES_NO_PENDING);
    listCell(rowNumber, "healthCardStatus").dataValidation = inlineList(YES_NO_PENDING);
    listCell(rowNumber, "payrollEligible").dataValidation = inlineList("Yes,No");
    listCell(rowNumber, "organogramVisible").dataValidation = inlineList("Yes,No");

    listCell(rowNumber, "employmentStatus").dataValidation = {
      ...inlineList(STATUS_VALUES),
      prompt: "Only active and on_leave can be uploaded. Exiting someone is a workflow, not an upload.",
      promptTitle: "Lifecycle-protected",
      showInputMessage: true,
    };

    if (lookups.lines.length) {
      listCell(rowNumber, "line").dataValidation = {
        allowBlank: true,
        formulae: ["LINES_LIST"],
        showErrorMessage: false,
        type: "list",
      };
    }
    if (lookups.departments.length) {
      listCell(rowNumber, "department").dataValidation = {
        allowBlank: true,
        formulae: ["DEPARTMENTS_LIST"],
        showErrorMessage: false,
        type: "list",
      };
    }
    if (lookups.positions.length) {
      listCell(rowNumber, "position").dataValidation = {
        allowBlank: true,
        formulae: ["POSITIONS_LIST"],
        showErrorMessage: false,
        type: "list",
      };
    }
    if (lookups.areas.length) {
      listCell(rowNumber, "area").dataValidation = {
        allowBlank: true,
        formulae: [AREAS_LIST_NAME],
        prompt: "Every active area. Not filtered by Line — most areas have a rep on more than one line.",
        promptTitle: "Select Area",
        showErrorMessage: false,
        showInputMessage: true,
        type: "list",
      };
      listCell(rowNumber, "team").dataValidation = {
        allowBlank: true,
        formulae: [areaTeamValidationFormula(`${areaLetter}${rowNumber}`)],
        prompt: "Pick an Area first — only that area's teams are shown.",
        promptTitle: "Select Team",
        showErrorMessage: false,
        showInputMessage: true,
        type: "list",
      };
    }

    // --- the two live formulas ---
    const originalMoneyFilled = rowNumber <= lastDataRow ? countMoneyFilled(rows[rowNumber - FIRST_DATA_ROW]) : 0;
    // `result: ""` IS NOT COSMETIC — it is what keeps a spare row out of the importer.
    //
    // ExcelJS writes a formula with no cached result as an `<f>` with no `<v>`, and reading that
    // back gives `{ formula }` with no `result` key at all. `readableExcelCellValue` then falls
    // past its `result` / `text` / `richText` branches and returns THE OBJECT, which
    // `excelCellText` stringifies to "[object Object]" — non-empty. Every one of the SPARE_ROWS
    // blank rows would therefore reach the validator as a real row failing "missing_hr_id".
    // Measured: 12 employees arrived as 262 rows. Caching the empty string gives the importer the
    // "" it expects, and `fullCalcOnLoad` below makes Excel replace it with the real verdict the
    // moment the file opens.
    sheet.getCell(rowNumber, columnIndex("rowCheck")).value = {
      formula: buildRowCheckFormula({
        hasAreas: lookups.areas.length > 0,
        hasDepartments: lookups.departments.length > 0,
        hasManagers: lookups.managerDirectory.length > 0,
        lastRow: lastFormulaRow,
        omitMoney,
        originalMoneyFilled,
        rowNumber,
      }).slice(1),
      result: "",
    };
    sheet.getCell(rowNumber, columnIndex("directManagerName")).value = {
      formula: buildManagerNameFormula(rowNumber).slice(1),
      result: "",
    };
  }

  // Row Check reads as a verdict, not as data.
  const rowCheckColumn = sheet.getColumn(columnIndex("rowCheck"));
  rowCheckColumn.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: HOUSE_XLSX_FONT, size: 9 };
  rowCheckColumn.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  // A COLUMN font covers the header cell too, and it is applied after the header row is styled — so
  // this muted grey silently overwrote the header's own type. Invisible while the header was type on
  // white and the two greys were close; on the Brand Blue band it is grey on blue, and unreadable.
  // The header is restyled here rather than by moving the column font, because the column font is
  // what keeps the verdict quiet down all 356 rows.
  const rowCheckHeader = sheet.getRow(HEADER_ROW).getCell(columnIndex("rowCheck"));
  houseHeaderStyle(rowCheckHeader);
  rowCheckHeader.value = "Row Check";
  rowCheckHeader.font = { ...rowCheckHeader.font, italic: true };

  // --- conditional formats. Every rule gets its OWN priority: ExcelJS does not assign them, and
  // duplicate priorities are one of the defects that makes Excel silently "repair" a workbook. ---
  const checkLetter = letterOf("rowCheck");
  const idLetter = letterOf("employeeId");
  const checkRange = `${checkLetter}${FIRST_DATA_ROW}:${checkLetter}${lastFormulaRow}`;

  sheet.addConditionalFormatting({
    ref: checkRange,
    rules: [
      {
        formulae: [`AND(${checkLetter}${FIRST_DATA_ROW}<>"",${checkLetter}${FIRST_DATA_ROW}<>"Ready")`],
        priority: 1,
        style: { font: { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag } } },
        type: "expression",
      },
      {
        formulae: [`${checkLetter}${FIRST_DATA_ROW}="Ready"`],
        priority: 2,
        style: { font: { color: { argb: HOUSE_XLSX_COLORS.light } } },
        type: "expression",
      },
    ],
  });

  // A duplicated key, marked in TYPE — the ink rule holds even for an error.
  sheet.addConditionalFormatting({
    ref: `${idLetter}${FIRST_DATA_ROW}:${idLetter}${lastFormulaRow}`,
    rules: [
      {
        formulae: [
          `AND(${idLetter}${FIRST_DATA_ROW}<>"",COUNTIF($${idLetter}$${FIRST_DATA_ROW}:$${idLetter}$${lastFormulaRow},${idLetter}${FIRST_DATA_ROW})>1)`,
        ],
        priority: 3,
        style: { font: { bold: true, color: { argb: HOUSE_XLSX_COLORS.flag } } },
        type: "expression",
      },
    ],
  });

  // --- legacy department values: a note, not a colour ---
  const approvedDepartments = new Set(lookups.departments.map((name) => name.toLowerCase()));
  const departmentColumn = columnIndex("department");
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= lastDataRow; rowNumber += 1) {
    const cell = sheet.getCell(rowNumber, departmentColumn);
    const value = String(cell.value ?? "").trim();
    if (value && !approvedDepartments.has(value.toLowerCase())) {
      cell.note = "Legacy department. Pick an approved department before uploading if this employee should be remapped.";
    }
  }

  // --- read-only marks: formulas and reference columns flagged locked, everything else open ---
  // The sheet is unprotected (owner, 2026-11-10), so these flags lock nothing; they only mark the
  // read-only columns, and the importer ignores those columns whatever is typed into them.
  for (let rowNumber = 1; rowNumber <= lastFormulaRow; rowNumber += 1) {
    sheetColumns.forEach((column, index) => {
      sheet.getCell(rowNumber, index + 1).protection = {
        locked:
          FORMULA_KEYS.has(column.key) ||
          isReadOnlyMasterColumn(column) ||
          (omitMoney && column.kind === "money"),
      };
    });
  }

  // --- print: nobody prints 48 columns, but if they do, it should not be 12 ragged pages ---
  sheet.pageSetup = {
    fitToHeight: 0,
    fitToPage: true,
    fitToWidth: 1,
    horizontalCentered: true,
    margins: { bottom: 0.4, footer: 0.2, header: 0.2, left: 0.3, right: 0.3, top: 0.4 },
    orientation: "landscape",
    paperSize: 9,
    printTitlesRow: `1:${HEADER_ROW}`,
  };
  sheet.headerFooter = {
    oddFooter: `&L&HOUSE_XLSX_FONT&8&K5A6B7C${HOUSE_DOCUMENT_STANDARD}&C&HOUSE_XLSX_FONT&8&K5A6B7CEmployee Master&R&HOUSE_XLSX_FONT&8&K5A6B7CPage &P of &N`,
  };

  return { lastDataRow, lastFormulaRow };
}

function countMoneyFilled(row: MasterRow | undefined): number {
  if (!row) return 0;
  const money = resolveMoneyRange();
  if (!money) return 0;
  return columns
    .slice(money.first - 1, money.last)
    .filter((column) => {
      const value = row[column.key as keyof MasterRow];
      return value !== null && value !== undefined && value !== "";
    }).length;
}

/**
 * "Start Here" — the cover, carrying a LIVE count of what still needs attention.
 *
 * It is the second tab rather than the first because of constraint 1, and it is made the active tab
 * so that opening the file still lands here.
 */
function addStartHereSheet(
  workbook: ExcelJS.Workbook,
  recordCount: number,
  lastFormulaRow: number,
  options: { canCreate: boolean; omitMoney: boolean } = { canCreate: true, omitMoney: false },
) {
  const { canCreate, omitMoney } = options;
  // The four guide tabs take the lighter blue: same family as the sheet you work in, plainly not it.
  const sheet = workbook.addWorksheet("Start Here", {
    properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.light } },
  });
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 30;
  sheet.getColumn(3).width = 96;
  sheet.views = [{ showGridLines: false }];

  writeHouseMasthead(workbook, sheet, {
    title: "Employee Master — Start Here",
    subtitle: "What this file is, how to fill it in, and what will stop it from uploading.",
    provenance: [`${recordCount} record${recordCount === 1 ? "" : "s"}`, systemLegalEntity.legalNameEn],
    columns: 3,
  });

  const checkLetter = letterOf("rowCheck");
  const idLetter = letterOf("employeeId");
  const master = "'Employee Master'";
  const checkRange = `${master}!$${checkLetter}$${FIRST_DATA_ROW}:$${checkLetter}$${lastFormulaRow}`;
  const idRange = `${master}!$${idLetter}$${FIRST_DATA_ROW}:$${idLetter}$${lastFormulaRow}`;

  let row = 5;

  function heading(text: string) {
    row += 1;
    // MERGED ACROSS BOTH COLUMNS. Ruling the cell beside it made that cell non-empty as far as the
    // renderer is concerned, so the heading stopped overflowing and every one of them was cut off
    // mid-word ("The things that actually blo"). Merging gives the text the full width AND keeps
    // the rule running the whole way under it.
    sheet.mergeCells(row, 2, row, 3);
    const cell = sheet.getCell(row, 2);
    cell.value = text;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 11 };
    cell.alignment = { horizontal: "left", vertical: "bottom" };
    cell.border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    sheet.getCell(row, 3).border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
    sheet.getRow(row).height = 20;
    row += 1;
  }

  function line(label: string, body: string) {
    const labelCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    labelCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    const bodyCell = sheet.getCell(row, 3);
    bodyCell.value = body;
    bodyCell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: HOUSE_XLSX_FONT, size: 9.5 };
    bodyCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    sheet.getRow(row).height = Math.max(18, Math.ceil(body.length / 105) * 14 + 6);
    row += 1;
  }

  function liveStat(label: string, formula: string, note: string) {
    const labelCell = sheet.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    const valueCell = sheet.getCell(row, 3);
    valueCell.value = { formula };
    valueCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_DISPLAY_FONT, size: 14 };
    valueCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
    houseCalloutStyle(valueCell, { emphasis: true });
    sheet.getCell(row, 3).note = note;
    sheet.getRow(row).height = 22;
    row += 1;
  }

  heading("Where this file stands right now");
  liveStat(
    "Rows with data",
    `COUNTA(${idRange})`,
    "Counts every row carrying an Employee ID, including any you add at the bottom.",
  );
  liveStat(
    "Rows ready to upload",
    `COUNTIF(${checkRange},"Ready")`,
    "A row is ready when nothing in it trips a rule the upload enforces.",
  );
  liveStat(
    "Rows needing attention",
    `SUMPRODUCT((${checkRange}<>"")*(${checkRange}<>"Ready"))`,
    "Filter column A on the Employee Master sheet to see exactly which ones, and why.",
  );
  line(
    "These update live",
    "They recalculate as you type. If they look stale, press F9. Getting \"Rows needing attention\" to zero is the whole job — the upload will then have nothing to complain about.",
  );

  heading("How to use it");
  line(
    "1 · Edit in place",
    canCreate
      ? "Type over what is here, or add new people on the empty rows at the bottom. The dropdowns, the row check and the formats all reach the spare rows already."
      : "Type over what is here. Adding a new employee is not part of your seat, so a row whose Employee ID is not already in the master is refused on upload.",
  );
  line("2 · Watch column A", "Column A on the Employee Master sheet checks each row as you type and names the first thing wrong with it. \"Ready\" means nothing will block it.");
  line("3 · Upload", "Employees → Import. The upload shows you a dry run first: what would change, per person, before anything is written.");

  heading("The things that actually block a row");
  line(
    "Employee ID",
    canCreate
      ? "It is the key. An existing HR_ID updates that person; a new one creates a new active employee. A missing or duplicated one blocks the row."
      : "It is the key. An existing HR_ID updates that person; one that is not in the master blocks the row, as does a missing or duplicated one.",
  );
  line("Lifecycle", "Only active and on_leave can be uploaded. Resignation, termination and reactivation are workflows — an upload cannot do them, by design.");
  line("Area", "Must be one of the active areas in the dropdown. Areas are never created by an upload, so a typo blocks the row rather than quietly inventing a territory.");
  line("Department", "Must be an active global department. Legacy values already in the file are marked with a note rather than removed.");
  line("Nickname", "The upload blocks a nickname that is another employee's real name, because that would rename someone. It usually means the file is shifted by a row.");

  if (omitMoney) {
    // The salary-blind export. Its money columns are hidden and empty, and its upload refuses any
    // figure typed into them, so the two salary paragraphs below would be instructions it cannot
    // follow — they are replaced, never merely skipped, so the file says why the money is absent.
    heading("Two things to know");
    line(
      "A blank cell changes nothing",
      "Clearing a cell does NOT erase the value. Blanks are skipped entirely on upload, so the stored value stays exactly as it was.",
    );
    line(
      "No salary figures",
      "Salary, allowance, insurance and tax amounts are not part of this file. Their columns are hidden and must stay empty: an upload with a figure in any of them is refused as a whole.",
    );
  } else {
    heading("Two things that surprise people");
    line(
      "A blank cell changes nothing",
      "Clearing a cell does NOT erase the value. Blanks are skipped entirely on upload, so emptying a salary cell leaves the salary exactly as it was. To actually set a number to nothing, type 0. Column A warns you when a row has fewer payroll figures than it was exported with.",
    );
    line(
      "Salary figures are normalized",
      `The upload recalculates Basic, Net and Gross from Base Salary using payroll policy — Basic is ${Math.round(BASIC_SALARY_RATE * 100)}% of Base — and tells you where your figure differed. Edit Base Salary; let the rest follow.`,
    );
  }

  heading("The other tabs");
  line("Employee Master", "The data. This must stay the first tab — the upload reads the first sheet in the file, by position, not by name.");
  line("Field Guide", "Every column: what it means, whether the upload reads it, and what values it accepts.");
  line("Upload Rules", "The checks the server runs, in its own words, with the code each one reports.");
  line("Reference Data", "The live lists behind the dropdowns — lines, areas, teams by area, departments, positions, managers.");

  row += 1;
  const footer = sheet.getCell(row, 2);
  footer.value = `${HOUSE_DOCUMENT_STANDARD} · ${systemDocuments.workbookExportScopeNote}`;
  footer.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 8 };
  sheet.mergeCells(row, 2, row, 3);
}

/** "Field Guide" — one row per column, so nobody has to guess what a header means. */
function addFieldGuideSheet(
  workbook: ExcelJS.Workbook,
  allSheetColumns: MasterColumn[],
  options: { omitMoney?: boolean } = {},
) {
  // A salary-blind export lists only the columns it shows: a guide row explaining how Base Salary
  // is derived would describe a hidden column she must leave empty. This sheet holds no positions
  // of the master sheet, so leaving rows out moves nothing there.
  const sheetColumns = options.omitMoney
    ? allSheetColumns.filter((column) => column.kind !== "money")
    : allSheetColumns;
  const sheet = workbook.addWorksheet("Field Guide", { properties: { tabColor: { argb: HOUSE_XLSX_COLORS.light } } });
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: HEADER_ROW }];
  const widths = [26, 22, 12, 34, 74];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  writeHouseMasthead(workbook, sheet, {
    title: "Field Guide",
    subtitle: "Every column on the Employee Master sheet, and what the upload does with it.",
    provenance: [`${sheetColumns.length} columns`, systemLegalEntity.legalNameEn],
    columns: widths.length,
  });

  const headers = ["Column", "Section", "Uploaded?", "Accepted values", "What it is"];
  sheet.getRow(SECTION_ROW).height = 6;
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 20;
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    houseHeaderStyle(cell);
  });

  sheetColumns.forEach((column, index) => {
    const rowNumber = FIRST_DATA_ROW + index;
    const row = sheet.getRow(rowNumber);
    const zebra = index % 2 === 1;
    const values = [
      column.header,
      column.section,
      column.imported ? "Yes" : "No — reference",
      column.allowed ?? (column.kind === "money" ? "A number" : column.kind === "date" ? "YYYY-MM-DD" : "Free text"),
      column.guide,
    ];
    values.forEach((value, valueIndex) => {
      const cell = row.getCell(valueIndex + 1);
      cell.value = value;
      houseBodyStyle(cell, { size: 9.5, zebra });
      cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    });
    row.getCell(1).font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9.5 };
    if (!column.imported) {
      row.getCell(3).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 9.5 };
    }
    row.height = Math.max(18, Math.ceil(column.guide.length / 88) * 13 + 6);
  });

  sheet.autoFilter = {
    from: { column: 1, row: HEADER_ROW },
    to: { column: widths.length, row: FIRST_DATA_ROW + sheetColumns.length - 1 },
  };
}

/**
 * "Upload Rules" — the server's own checks, with the code each reports.
 *
 * Transcribed from `src/lib/imports/employee-validator.ts`. Keeping the CODE beside each rule is the
 * point: when someone gets an error back from a dry run, this sheet is what turns "invalid_hr_id"
 * into a sentence.
 */
function addUploadRulesSheet(
  workbook: ExcelJS.Workbook,
  options: { canCreate: boolean; omitMoney: boolean } = { canCreate: true, omitMoney: false },
) {
  const sheet = workbook.addWorksheet("Upload Rules", { properties: { tabColor: { argb: HOUSE_XLSX_COLORS.light } } });
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: HEADER_ROW }];
  const widths = [16, 30, 30, 76];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  writeHouseMasthead(workbook, sheet, {
    title: "Upload Rules",
    subtitle: "What the server checks, what it calls each result, and whether it stops the row.",
    provenance: ["Employee import", systemLegalEntity.legalNameEn],
    columns: widths.length,
  });

  type Rule = {
    effect: "Blocks the file" | "Blocks the row" | "Warns only" | "Normalizes";
    code: string;
    rule: string;
    detail: string;
  };
  const rules: Rule[] = [
    { effect: "Blocks the row", code: "missing_hr_id", rule: "Employee ID is required", detail: "Every row needs an HR_ID — it is what the upload matches on." },
    { effect: "Blocks the row", code: "invalid_hr_id", rule: "Employee ID must be a valid HR_ID", detail: "HR_IDs are matched case-insensitively, so casing in the file does not matter." },
    { effect: "Blocks the row", code: "missing_full_name", rule: "Full Name is required", detail: "Used on payroll documents, so it cannot be left to the nickname." },
    { effect: "Blocks the row", code: "invalid_email", rule: "Work email must be a valid address", detail: "Checked only when the cell has something in it." },
    { effect: "Blocks the row", code: "nickname_is_another_employees_name", rule: "A nickname cannot be someone else's real name", detail: "A nickname is what every screen shows, so this would rename a person. It usually means a column in the file is shifted by one row." },
    { effect: "Blocks the row", code: "invalid_date", rule: "Hiring Date and Birth Date must be real dates", detail: "YYYY-MM-DD." },
    { effect: "Blocks the row", code: "lifecycle_status_import_blocked", rule: "Only active and on_leave can be uploaded", detail: "Resigned, terminated and inactive are lifecycle workflows. An upload can never reactivate someone." },
    { effect: "Blocks the row", code: "self_manager_assignment", rule: "Nobody can be their own manager", detail: "Manager HR_ID must differ from Employee ID." },
    { effect: "Blocks the row", code: "invalid_numeric_value", rule: "Money columns must be numbers", detail: "A stray space or currency symbol makes the cell text — clear it and retype the number." },
    { effect: "Blocks the row", code: "unmapped_area", rule: "Area must be an active area", detail: "Areas are never created by an upload. Fix the spelling or pick from the dropdown." },
    { effect: "Blocks the row", code: "canonical_area_unavailable", rule: "Areas could not be verified", detail: "The area reference did not load, so the upload refuses rather than importing unverified territories. Retry." },
    { effect: "Blocks the row", code: "ambiguous_team_area", rule: "A team name under several areas needs its Area", detail: "Fill Area in and the upload can tell which team you mean." },
    { effect: "Blocks the row", code: "invalid_department", rule: "Department must be an active department", detail: "Legacy departments already in the file are noted, not silently accepted." },
    { effect: "Blocks the row", code: "invalid_gender", rule: `Gender must be ${GENDER_VALUES}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_contract_type", rule: `Contract Type must be ${CONTRACT_VALUES}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_payment_mode", rule: `Payment Mode must be ${PAYMENT_MODE_VALUES}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_has_bank_account", rule: `Has Bank Account must be ${YES_NO}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_medical_insurance_status", rule: `In Medical Insurance must be ${YES_NO_PENDING}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_social_insurance_status", rule: `In Social Insurance must be ${YES_NO_PENDING}, or blank`, detail: "" },
    { effect: "Blocks the row", code: "invalid_total_experience_years", rule: "Total years of experience must be a number from 0 to 60", detail: "For example 2 or 0.5. One decimal is kept." },
    { effect: "Normalizes", code: "base_salary_formula_mismatch", rule: "Base Salary is recalculated to policy", detail: "Your figure is replaced by the policy figure and the difference is reported back to you." },
    { effect: "Normalizes", code: "basic_salary_formula_mismatch", rule: `Basic Salary is recalculated as ${Math.round(BASIC_SALARY_RATE * 100)}% of Base`, detail: "Edit Base Salary; Basic follows." },
    { effect: "Normalizes", code: "net_salary_formula_mismatch", rule: "Net is recalculated from Base plus cost of living and fuel", detail: "" },
    { effect: "Normalizes", code: "gross_salary_formula_mismatch", rule: "Gross is recalculated from Base plus social insurance and tax", detail: "" },
    { effect: "Normalizes", code: "fuel_allowance_policy_mismatch", rule: "Fuel Allowance is set by payroll policy", detail: "The standard amount for the position wins over the typed one." },
    { effect: "Normalizes", code: "extra_cost_of_living_policy_mismatch", rule: "Extra Cost Of Living is set by position policy", detail: "" },
    { effect: "Warns only", code: "nickname_shared_with_another_employee", rule: "A nickname the employee already carries is kept", detail: "Even when it is also someone else's real name: uploading it again renames nobody, so the row imports. Give the employee a nickname of their own to tell the two apart." },
    { effect: "Warns only", code: "—", rule: "A blank cell is skipped, never written", detail: "Clearing a cell does not erase the stored value. Type 0 to actually zero a number." },
  ];

  // The salary-blind export's own rules, in the same codes its upload reports. Its money rules
  // (the number check, the policy normalizations, "type 0") describe columns it hides and refuses,
  // so they leave the list; the refusals that replace them join it.
  const MONEY_RULE_CODES = new Set([
    "invalid_numeric_value",
    "base_salary_formula_mismatch",
    "basic_salary_formula_mismatch",
    "net_salary_formula_mismatch",
    "gross_salary_formula_mismatch",
    "fuel_allowance_policy_mismatch",
    "extra_cost_of_living_policy_mismatch",
  ]);
  if (options.omitMoney) {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      if (MONEY_RULE_CODES.has(rules[index].code)) rules.splice(index, 1);
    }
    const blank = rules.find((rule) => rule.code === "—");
    if (blank) blank.detail = "Clearing a cell does not erase the stored value.";
    // Payment mode is held with the HR Manager for this seat, so the "must be one of" check is
    // replaced by the rule that she never changes it (salary-blind-pay-flags.ts).
    const paymentModeRule = rules.findIndex((rule) => rule.code === "invalid_payment_mode");
    if (paymentModeRule >= 0) rules.splice(paymentModeRule, 1);
    rules.unshift({
      effect: "Blocks the row",
      code: PAY_FLAG_KEPT_CODE,
      rule: "Payment Mode, Payroll Eligible and Employment Status stay as they are",
      detail: "All three stay with the HR Manager. A cell that matches the master is ignored; a cell that changes it refuses that row. Bank name and bank account import as usual.",
    });
    rules.unshift({
      effect: "Blocks the file",
      code: SALARY_BLIND_MONEY_COLUMNS_CODE,
      rule: "No salary figures in this file",
      detail: "Salary, allowance, insurance and tax columns must stay empty. One filled cell in any of them refuses the whole file.",
    });
  }
  if (!options.canCreate) {
    rules.unshift({
      effect: "Blocks the row",
      code: NEW_EMPLOYEE_NOT_ALLOWED_CODE,
      rule: "Only employees already in the master",
      detail: "Adding a new employee is not part of this seat, so a row whose Employee ID is not in the master is refused.",
    });
  }

  const headers = ["Effect", "Code", "Rule", "What it means"];
  sheet.getRow(SECTION_ROW).height = 6;
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 20;
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    houseHeaderStyle(cell);
  });

  rules.forEach((rule, index) => {
    const rowNumber = FIRST_DATA_ROW + index;
    const row = sheet.getRow(rowNumber);
    const zebra = index % 2 === 1;
    [rule.effect, rule.code, rule.rule, rule.detail].forEach((value, valueIndex) => {
      const cell = row.getCell(valueIndex + 1);
      cell.value = value;
      houseBodyStyle(cell, { size: 9.5, zebra });
      cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    });
    row.getCell(1).font = {
      bold: true,
      color: {
        argb: rule.effect === "Blocks the row" || rule.effect === "Blocks the file" ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.deep,
      },
      name: HOUSE_XLSX_FONT,
      size: 9,
    };
    row.getCell(2).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: HOUSE_XLSX_MONO_FONT, size: 8.5 };
    row.height = 18;
  });

  sheet.autoFilter = {
    from: { column: 1, row: HEADER_ROW },
    to: { column: headers.length, row: FIRST_DATA_ROW + rules.length - 1 },
  };
}

/** "Reference Data" — the dropdown lists, visible and searchable. */
function addReferenceDataSheet(workbook: ExcelJS.Workbook, lookups: MasterLookups) {
  const sheet = workbook.addWorksheet("Reference Data", { properties: { tabColor: { argb: HOUSE_XLSX_COLORS.light } } });
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: HEADER_ROW }];

  const blocks: Array<{ title: string; values: string[] }> = [
    { title: "Lines", values: lookups.lines.map((line) => line.label) },
    { title: "Departments", values: lookups.departments },
    { title: "Positions", values: lookups.positions },
    { title: "Areas", values: lookups.areas.map((area) => area.label) },
    {
      title: "Managers (HR_ID — Name)",
      values: lookups.managerDirectory.map((manager) => `${manager.hrId} — ${manager.fullName}`),
    },
  ];

  blocks.forEach((_block, index) => {
    sheet.getColumn(index + 1).width = index === blocks.length - 1 ? 38 : 26;
  });

  writeHouseMasthead(workbook, sheet, {
    title: "Reference Data",
    subtitle: "The live lists behind the dropdowns, as they stood when this file was generated.",
    provenance: [`${lookups.areas.length} areas`, systemLegalEntity.legalNameEn],
    columns: blocks.length,
  });

  sheet.getRow(SECTION_ROW).height = 6;
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.height = 20;
  blocks.forEach((block, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = `${block.title}  (${block.values.length})`;
    houseHeaderStyle(cell);
  });

  const deepest = Math.max(0, ...blocks.map((block) => block.values.length));
  for (let offset = 0; offset < deepest; offset += 1) {
    const row = sheet.getRow(FIRST_DATA_ROW + offset);
    row.height = 15;
    blocks.forEach((block, index) => {
      const cell = row.getCell(index + 1);
      cell.value = block.values[offset] ?? null;
      houseBodyStyle(cell, { size: 9, zebra: offset % 2 === 1 });
    });
  }

  // Teams, laid out under their area — the cascade made readable.
  let teamsRow = FIRST_DATA_ROW + deepest + 2;
  const teamsHeader = sheet.getCell(teamsRow, 1);
  teamsHeader.value = "Teams, by area";
  houseHeaderStyle(teamsHeader);
  sheet.getCell(teamsRow, 2).value = "Only these appear in the Team dropdown once that Area is picked.";
  sheet.getCell(teamsRow, 2).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 9 };
  teamsRow += 1;

  const ranges = buildAreaTeamRanges({ areas: lookups.areas, teams: lookups.teams })
    .filter((range) => range.areaLabel !== null);
  ranges.forEach((range, index) => {
    const row = sheet.getRow(teamsRow + index);
    row.height = 15;
    const areaCell = row.getCell(1);
    areaCell.value = range.areaLabel;
    houseBodyStyle(areaCell, { size: 9, zebra: index % 2 === 1 });
    areaCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 9 };
    const teamsCell = row.getCell(2);
    teamsCell.value = range.teamLabels.length ? range.teamLabels.join(", ") : "— no teams yet —";
    houseBodyStyle(teamsCell, { size: 9, zebra: index % 2 === 1 });
    if (!range.teamLabels.length) {
      teamsCell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: HOUSE_XLSX_FONT, size: 9 };
    }
    sheet.mergeCells(teamsRow + index, 2, teamsRow + index, blocks.length);
  });
}

export type BuildEmployeeMasterWorkbookInput = {
  employees: EmployeeDirectoryRow[];
  lookups: MasterLookups;
  /** Free-text note about whose scope produced this file — printed in the masthead. */
  scopeNote?: string;
  /**
   * The hiring-document checklist, so one row holds everything known about a person.
   *
   * OPTIONAL, AND ITS ABSENCE IS NOT AN ERROR. The checklist lives in three tables the export does
   * not otherwise touch; the route loads it defensively and passes nothing when it cannot. The
   * workbook is then exactly the sheet it was before, rather than a failed download.
   */
  hiringDocuments?: EmployeeMasterHiringDocuments;
  /**
   * HR id -> the Arabic job title filed with the Social Insurance Authority
   * (`employee_hiring_profile.job_title_ar`). Lives beside the employee record rather than in it,
   * so it is loaded by the caller and merged here.
   */
  socialInsuranceJobTitles?: Map<string, string | null>;
  /**
   * The salary-blind export (isSalaryBlindRole — the HR Operations Specialist). Every money column
   * stays in its place, HIDDEN, LOCKED and EMPTY, and no guidance in the file tells the reader to
   * fill one. Never removed: see the note in `styleMasterSheet`.
   */
  omitMoney?: boolean;
  /**
   * False for a viewer who may not add an employee. Only the guidance changes — the importer is
   * what refuses a new Employee ID. Defaults to true, the sheet exactly as it always was.
   */
  canCreate?: boolean;
};

/** Builds the whole workbook. Sheet ORDER is load-bearing — see constraint 1 at the top. */
export async function buildEmployeeMasterWorkbook(
  input: BuildEmployeeMasterWorkbookInput,
): Promise<ExcelJS.Workbook> {
  const { employees, lookups } = input;
  const scopeNote = input.scopeNote ?? "Scoped to your access";
  const omitMoney = input.omitMoney === true;
  const canCreate = input.canCreate !== false;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = "Employee Master";
  workbook.title = systemDocuments.titles.activeEmployeeMasterDataWorkbook;
  workbook.company = systemDocuments.workbookCompany;
  // Every formula ships with an empty cached result (see the note in `styleMasterSheet`), so Excel
  // must be told to calculate on load or the sheet would open showing nothing in Row Check.
  workbook.calcProperties.fullCalcOnLoad = true;

  // FIRST, ALWAYS. The importer reads worksheets[0].
  const sheet = workbook.addWorksheet("Employee Master", {
    properties: { defaultRowHeight: 18, tabColor: { argb: HOUSE_XLSX_COLORS.deep } },
  });
  const documentDefinitions = input.hiringDocuments?.definitions ?? [];
  const sheetColumns = masterColumnsFor(documentDefinitions);
  sheet.columns = sheetColumns.map((column) => ({ key: column.key, width: column.width }));

  const rows = employees.map((employee) =>
    employeeToMasterRow(employee, input.socialInsuranceJobTitles?.get(employee.hrId) ?? null),
  );
  // Rows 1-5 are the masthead, the section band and the headers; data starts at FIRST_DATA_ROW.
  for (let index = 0; index < rows.length; index += 1) {
    const row = sheet.getRow(FIRST_DATA_ROW + index);
    const documentCells = input.hiringDocuments?.byHrId.get(employees[index].hrId);
    sheetColumns.forEach((column, columnIndexZeroBased) => {
      if (FORMULA_KEYS.has(column.key)) return;
      const cell = row.getCell(columnIndexZeroBased + 1);
      if (column.key === HIRING_DOCUMENTS_SUMMARY_KEY) {
        // `|| null` rather than the empty string: an empty inline string is a VALUE in the file,
        // and constraint 3 only holds while an unfilled cell is genuinely nothing.
        cell.value = formatHiringDocumentSummary(documentCells, documentDefinitions) || null;
        return;
      }
      if (column.documentColumn === true) {
        const documentId = hiringDocumentIdFromKey(column.key);
        cell.value = formatHiringDocumentCell(documentCells?.get(documentId)) || null;
        return;
      }
      // Belt and braces: the salary-blind directory arrives redacted, so this only ever writes the
      // null that was already there — but the file must not depend on the caller having redacted.
      if (omitMoney && column.kind === "money") {
        cell.value = null;
        return;
      }
      cell.value = rows[index][column.key as keyof MasterRow] as ExcelJS.CellValue;
    });
  }

  addLookupSheet(workbook, lookups);
  const { lastFormulaRow } = styleMasterSheet(workbook, sheet, lookups, rows, scopeNote, sheetColumns, {
    omitMoney,
  });

  addStartHereSheet(workbook, rows.length, lastFormulaRow, { canCreate, omitMoney });
  addFieldGuideSheet(workbook, sheetColumns, { omitMoney });
  addUploadRulesSheet(workbook, { canCreate, omitMoney });
  addReferenceDataSheet(workbook, lookups);

  // The export is deliberately UNPROTECTED on the owner's word (2026-11-10): no sheet and no workbook protection.

  // Open on the cover, even though the data sheet has to be first in the file.
  const startHereIndex = workbook.worksheets.findIndex((worksheet) => worksheet.name === "Start Here");
  // `Workbook.views` is WorkbookView[], not Partial — the window geometry is required even though
  // Excel overrides it with whatever the reader's window actually is.
  workbook.views = [
    {
      activeTab: startHereIndex < 0 ? 0 : startHereIndex,
      firstSheet: 0,
      height: 18000,
      visibility: "visible",
      width: 29000,
      x: 0,
      y: 0,
    },
  ];

  return workbook;
}

/** The download filename. */
export function employeeMasterFileName(now: Date = new Date()): string {
  return `sato-employee-master-${now.toISOString().slice(0, 10)}.xlsx`;
}

export {
  columns,
  employeeMasterWorkbookContract,
  FIRST_DATA_ROW,
  HEADER_ROW,
  SECTION_ROW,
  SPARE_ROWS,
} from "@/lib/employees/employee-master-columns";
