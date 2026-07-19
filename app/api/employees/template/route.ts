import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { systemDocuments } from "@/config/system-settings";
import { assertPermission, filterEmployeeDirectoryForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployeeMasterExportSalary } from "@/lib/employees/employee-master-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phoenix brand tokens (src/styles/tokens.css) — kept in sync manually since ExcelJS
// styling can't read CSS custom properties.
const BRAND = {
  primary: "FFF97316",
  primaryDark: "FFEA580C",
  navy: "FF0F172A",
  slate: "FF475569",
  border: "FFE2E8F0",
  bgSoft: "FFF8FAFC",
  success: "FF22C55E",
  warning: "FFF59E0B",
  danger: "FFEF4444",
};

type ExportColumn = {
  header: string;
  key: keyof ExportRow;
  section: string;
  width?: number;
};

type ExportRow = {
  employeeId: string;
  fullName: string;
  nickname: string | null;
  arabicName: string | null;
  nationalId: string | null;
  gender: string | null;
  birthDate: string | null;
  department: string | null;
  line: string | null;
  area: string | null;
  team: string | null;
  jobTitle: string | null;
  position: string | null;
  directManagerId: string | null;
  directManagerName: string | null;
  hireDate: string | null;
  employmentStatus: string | null;
  contractType: string | null;
  workEmail: string | null;
  mobileNumber: string | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  residenceArea: string | null;
  crmId: string | null;
  crmUsername: string | null;
  education: string | null;
  hasBankAccount: string | null;
  bankName: string | null;
  bankAccount: string | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  basicSalary: number | null;
  baseSalary: number | null;
  netSalary: number | null;
  socialInsurance: number | null;
  taxes: number | null;
  medicalInsurance: number | null;
  fuelAllowance: number | null;
  extraCostOfLiving: number | null;
  grossSalary: number | null;
  paymentMode: string;
  payrollEligible: string;
  organogramVisible: string;
  region: string | null;
  lastUpdated: string;
};

const columns: ExportColumn[] = [
  { header: "Employee ID", key: "employeeId", section: "Identity", width: 16 },
  { header: "Full Name", key: "fullName", section: "Identity", width: 28 },
  { header: "Nickname", key: "nickname", section: "Identity", width: 20 },
  { header: "Arabic Name", key: "arabicName", section: "Identity", width: 24 },
  { header: "National ID", key: "nationalId", section: "Identity", width: 20 },
  { header: "Gender", key: "gender", section: "Identity", width: 14 },
  { header: "Birth Date", key: "birthDate", section: "Identity", width: 14 },
  { header: "Department", key: "department", section: "Organization", width: 22 },
  { header: "Line", key: "line", section: "Organization", width: 20 },
  { header: "Area", key: "area", section: "Organization", width: 22 },
  { header: "Team", key: "team", section: "Organization", width: 18 },
  { header: "Title", key: "jobTitle", section: "Organization", width: 24 },
  { header: "Position", key: "position", section: "Organization", width: 24 },
  { header: "Manager HR_ID", key: "directManagerId", section: "Organization", width: 18 },
  { header: "Direct Manager (auto)", key: "directManagerName", section: "Organization", width: 28 },
  { header: "Hiring Date", key: "hireDate", section: "Organization", width: 14 },
  { header: "Employment Status", key: "employmentStatus", section: "Organization", width: 18 },
  { header: "Contract Type", key: "contractType", section: "Organization", width: 18 },
  { header: "Email", key: "workEmail", section: "Contact & Residence", width: 30 },
  { header: "Phone", key: "mobileNumber", section: "Contact & Residence", width: 18 },
  { header: "Residence Address", key: "residenceAddress", section: "Contact & Residence", width: 36 },
  { header: "Residence City", key: "residenceCity", section: "Contact & Residence", width: 18 },
  { header: "Residence Area", key: "residenceArea", section: "Contact & Residence", width: 18 },
  { header: "CRM ID", key: "crmId", section: "CRM", width: 16 },
  { header: "CRM Username", key: "crmUsername", section: "CRM", width: 20 },
  { header: "Basic Salary", key: "basicSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Base Salary", key: "baseSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Gross Salary", key: "grossSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Net Salary", key: "netSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Fuel Allowance", key: "fuelAllowance", section: "Payroll Reference Information", width: 16 },
  { header: "Extra Cost Of Living", key: "extraCostOfLiving", section: "Payroll Reference Information", width: 22 },
  { header: "Medical Insurance", key: "medicalInsurance", section: "Payroll Reference Information", width: 18 },
  { header: "Social Insurance", key: "socialInsurance", section: "Payroll Reference Information", width: 18 },
  { header: "Taxes", key: "taxes", section: "Payroll Reference Information", width: 14 },
  { header: "Payment Mode", key: "paymentMode", section: "Payroll Reference Information", width: 16 },
  { header: "Has Bank Account", key: "hasBankAccount", section: "Payroll Reference Information", width: 18 },
  { header: "Bank Name", key: "bankName", section: "Payroll Reference Information", width: 20 },
  { header: "Bank Account", key: "bankAccount", section: "Payroll Reference Information", width: 22 },
  { header: "In Medical Insurance", key: "medicalInsuranceStatus", section: "Payroll Reference Information", width: 22 },
  { header: "Medical Insurance Number", key: "medicalInsuranceNumber", section: "Payroll Reference Information", width: 24 },
  { header: "In Social Insurance", key: "socialInsuranceStatus", section: "Payroll Reference Information", width: 22 },
  { header: "Social Insurance Number", key: "socialInsuranceNumber", section: "Payroll Reference Information", width: 24 },
  { header: "Payroll Eligible", key: "payrollEligible", section: "Lifecycle/System", width: 16 },
  { header: "Organogram Visible", key: "organogramVisible", section: "Lifecycle/System", width: 18 },
  { header: "Region", key: "region", section: "Lifecycle/System", width: 18 },
  { header: "Last Updated", key: "lastUpdated", section: "Lifecycle/System", width: 18 },
];

const sectionColors: Record<string, string> = {
  "Identity": BRAND.navy,
  "Organization": BRAND.primaryDark,
  "Contact & Residence": "FF7C3AED",
  "CRM": "FF4338CA",
  "Payroll Reference Information": "FFC2410C",
  "Lifecycle/System": BRAND.slate,
};

// Columns that are live formulas, not user-entered data — protected against edits.
const FORMULA_COLUMN_KEYS = new Set<keyof ExportRow>(["directManagerName"]);

type LookupValues = {
  departments: string[];
  teams: Array<{ label: string; areaId: number | null }>;
  lines: Array<{ label: string; id: number | null }>;
  areas: Array<{ label: string; value: string }>;
  positions: string[];
  managerDirectory: Array<{ hrId: string; fullName: string }>;
};

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : null;
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function employeeToExportRow(employee: EmployeeDirectoryRow): ExportRow {
  const exportSalary = resolveEmployeeMasterExportSalary(employee);

  return {
    arabicName: employee.nameAr,
    area: employee.areaName,
    bankAccount: employee.bankAccount,
    bankName: employee.bankName,
    hasBankAccount: employee.hasBankAccount ?? (employee.bankAccount ? "yes" : null),
    baseSalary: exportSalary.baseSalary,
    basicSalary: exportSalary.basicSalary,
    birthDate: dateOnly(employee.birthDate),
    contractType: employee.contractType,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    department: employee.departmentName,
    directManagerId: employee.managerHrId,
    directManagerName: employee.managerName,
    education: employee.education,
    employeeId: employee.hrId,
    employmentStatus: employee.employmentStatus ?? "active",
    extraCostOfLiving: employee.extraCostOfLiving,
    fuelAllowance: employee.fuelAllowance,
    fullName: employee.fullName,
    nickname: employee.nickname,
    gender: employee.gender,
    grossSalary: exportSalary.grossSalary,
    hireDate: dateOnly(employee.hireDate),
    jobTitle: employee.jobTitle,
    lastUpdated: dateOnly(employee.updatedAt) ?? employee.updatedAt,
    line: employee.lineName,
    medicalInsuranceNumber: employee.medicalInsuranceNumber,
    medicalInsurance: employee.medicalInsurance,
    medicalInsuranceStatus: employee.medicalInsuranceStatus,
    mobileNumber: employee.mobileNumber,
    nationalId: employee.nationalId,
    netSalary: exportSalary.netSalary,
    organogramVisible: yesNo(employee.organogramVisible),
    paymentMode: employee.salaryPaymentMode,
    payrollEligible: yesNo(employee.payrollEligible),
    position: employee.positionTitle,
    region: employee.regionName,
    residenceAddress: employee.residenceAddress,
    residenceArea: employee.residenceArea,
    residenceCity: employee.residenceCity,
    socialInsurance: employee.socialInsurance,
    socialInsuranceNumber: employee.socialInsuranceNumber,
    socialInsuranceStatus: employee.socialInsuranceStatus,
    taxes: employee.taxes,
    team: employee.teamName,
    workEmail: employee.workEmail,
  };
}

// Deterministic sanitizer shared between the TS-side defined-name registration and the
// live Excel formula (SUBSTITUTE chain below) — both MUST transform a Line/Area label
// into the identical token, or the INDIRECT() cascade resolves to a dead reference.
function definedNameToken(prefix: string, label: string) {
  const token = label
    .toUpperCase()
    .replace(/[-\s]+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .replace(/^_+|_+$/g, "");
  return `${prefix}_${token || "NA"}`;
}

// The live formula equivalent of definedNameToken(), so a dropdown picked from a cell
// resolves via INDIRECT to the matching named range built below.
function indirectTokenFormula(prefix: string, cellRef: string) {
  return `"${prefix}_"&SUBSTITUTE(SUBSTITUTE(UPPER(${cellRef}),"-","_")," ","_")`;
}

function columnLetter(index: number) {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// Hidden reference sheet: a flat Lines list, a flat Areas list (Area is independent of
// Line — see the note below), one column per Area listing its Teams (the only real
// cascade level), a Positions list, and a flat Manager directory (HR_ID -> Full Name)
// driving the live "Direct Manager (auto)" lookup.
function addLookupDataSheet(workbook: ExcelJS.Workbook, lookups: LookupValues) {
  const sheet = workbook.addWorksheet("Lookup Data", { state: "veryHidden" });
  let col = 1;

  function writeList(name: string, header: string, values: string[]) {
    const letter = columnLetter(col);
    sheet.getCell(1, col).value = header;
    values.forEach((value, index) => {
      sheet.getCell(2 + index, col).value = value;
    });
    if (values.length > 0) {
      workbook.definedNames.add(`'Lookup Data'!$${letter}$2:$${letter}$${1 + values.length}`, name);
    }
    col += 1;
  }

  writeList("LINES_LIST", "Lines", lookups.lines.map((line) => line.label));
  writeList("POSITIONS_LIST", "Positions", lookups.positions);

  // Area is NOT cascaded from Line: areas are geographic territories, and (verified
  // against live data) nearly every area has a dedicated rep per line — CNS, Anti, and
  // Pedia reps commonly share the same area name. A per-line area cascade would either
  // wrongly hide valid areas or, once corrected for real overlap, degrade to "show all
  // areas anyway" — so Area is one flat list, consistent for every Line.
  writeList("AREAS_LIST", "Areas", lookups.areas.map((area) => area.label));

  // Area -> Teams: each team carries its owning area's numeric id; resolve that id back
  // to the area's label (the same label the cascade formula keys off of) via `value`.
  const areaLabelById = new Map(lookups.areas.map((area) => [Number(area.value), area.label]));
  const teamsByAreaLabel = new Map<string, string[]>();
  for (const area of lookups.areas) teamsByAreaLabel.set(area.label, []);
  for (const team of lookups.teams) {
    if (team.areaId == null) continue;
    const areaLabel = areaLabelById.get(team.areaId);
    if (!areaLabel) continue;
    teamsByAreaLabel.get(areaLabel)?.push(team.label);
  }
  for (const area of lookups.areas) {
    writeList(definedNameToken("TEAMS", area.label), `Teams (${area.label})`, teamsByAreaLabel.get(area.label) ?? []);
  }

  // Flat manager directory for the live VLOOKUP-driven "Direct Manager (auto)" column.
  const managerHeaderRow = 1;
  const hrIdCol = col;
  const nameCol = col + 1;
  sheet.getCell(managerHeaderRow, hrIdCol).value = "Manager HR_ID";
  sheet.getCell(managerHeaderRow, nameCol).value = "Manager Full Name";
  lookups.managerDirectory.forEach((manager, index) => {
    sheet.getCell(2 + index, hrIdCol).value = manager.hrId;
    sheet.getCell(2 + index, nameCol).value = manager.fullName;
  });
  const hrIdLetter = columnLetter(hrIdCol);
  const nameLetter = columnLetter(nameCol);
  const lastRow = Math.max(2, 1 + lookups.managerDirectory.length);
  workbook.definedNames.add(`'Lookup Data'!$${hrIdLetter}$2:$${nameLetter}$${lastRow}`, "MANAGER_DIRECTORY");

  return sheet;
}

async function styleWorksheet(sheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook, lookups: LookupValues, recordCount: number) {
  const titleRowNumber = 1;
  const subtitleRowNumber = 2;
  const sectionRowNumber = 3;
  const headerRowNumber = 4;
  const firstDataRowNumber = 5;

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { column: 1, row: headerRowNumber },
    to: { column: columns.length, row: headerRowNumber },
  };
  sheet.properties.defaultRowHeight = 20;

  // --- Title bar: logo + wordmark + generation metadata (Phoenix brand identity) ---
  sheet.getRow(titleRowNumber).height = 40;
  sheet.mergeCells(titleRowNumber, 2, titleRowNumber, columns.length);
  const titleCell = sheet.getCell(titleRowNumber, 2);
  titleCell.value = systemDocuments.titles.activeEmployeeMasterData;
  titleCell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos Display", size: 18 };
  titleCell.fill = { fgColor: { argb: BRAND.navy }, pattern: "solid", type: "pattern" };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getCell(titleRowNumber, 1).fill = { fgColor: { argb: BRAND.navy }, pattern: "solid", type: "pattern" };

  try {
    const logoPath = path.join(process.cwd(), "public", "brand", "phoenix-primary-logo.png");
    const logoBase64 = readFileSync(logoPath).toString("base64");
    const imageId = workbook.addImage({ base64: logoBase64, extension: "png" });
    sheet.addImage(imageId, {
      tl: { col: 0.15, row: 0.08 },
      ext: { width: 110, height: 32 },
    });
  } catch {
    // Logo asset optional — brand color bar still applies without it.
  }

  sheet.mergeCells(subtitleRowNumber, 1, subtitleRowNumber, columns.length);
  const subtitleCell = sheet.getCell(subtitleRowNumber, 1);
  subtitleCell.value = `${recordCount} active employee record${recordCount === 1 ? "" : "s"} · Generated ${new Date().toISOString().slice(0, 10)} · Team cascades from Area · Direct Manager auto-fills from HR_ID`;
  subtitleCell.font = { italic: true, color: { argb: "FFFFFFFF" }, name: "Aptos", size: 9 };
  subtitleCell.fill = { fgColor: { argb: BRAND.primaryDark }, pattern: "solid", type: "pattern" };
  subtitleCell.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(subtitleRowNumber).height = 18;

  columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.width ?? 18;
    excelColumn.outlineLevel = column.section === "Lifecycle/System" ? 1 : 0;
  });

  const sectionRow = sheet.getRow(sectionRowNumber);
  sectionRow.height = 22;
  columns.forEach((column, index) => {
    const cell = sectionRow.getCell(index + 1);
    cell.value = column.section;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos", size: 9 };
    cell.fill = { fgColor: { argb: sectionColors[column.section] ?? BRAND.navy }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const headerRow = sheet.getRow(headerRowNumber);
  headerRow.height = 26;
  headerRow.eachCell((cell, columnNumber) => {
    const section = columns[columnNumber - 1]?.section ?? "Lifecycle/System";
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos", size: 11 };
    cell.fill = { fgColor: { argb: sectionColors[section] ?? BRAND.navy }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFFFFFFF" } },
      right: { style: "thin", color: { argb: BRAND.border } },
    };
  });

  const lastDataRow = Math.max(sheet.rowCount, firstDataRowNumber + recordCount - 1);
  const bufferedLastRow = Math.max(lastDataRow, firstDataRowNumber + 999);

  for (let rowNumber = firstDataRowNumber; rowNumber <= lastDataRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.eachCell((cell) => {
      cell.font = { color: { argb: BRAND.navy }, name: "Aptos", size: 10 };
      cell.alignment = { vertical: "middle", wrapText: false };
      cell.border = { bottom: { style: "thin", color: { argb: BRAND.border } } };
      if (rowNumber % 2 === 0) {
        cell.fill = { fgColor: { argb: BRAND.bgSoft }, pattern: "solid", type: "pattern" };
      }
    });
  }

  const moneyColumns = new Set([
    "netSalary", "basicSalary", "baseSalary", "socialInsurance", "taxes",
    "medicalInsurance", "fuelAllowance", "extraCostOfLiving", "grossSalary",
  ]);
  columns.forEach((column, index) => {
    if (moneyColumns.has(column.key)) sheet.getColumn(index + 1).numFmt = "#,##0.00";
  });

  const dateColumns = new Set(["birthDate", "hireDate", "lastUpdated"]);
  columns.forEach((column, index) => {
    if (dateColumns.has(column.key)) sheet.getColumn(index + 1).numFmt = "yyyy-mm-dd";
  });

  const colIndex = (key: keyof ExportRow) => columns.findIndex((c) => c.key === key) + 1;
  const employeeIdCol = colIndex("employeeId");
  const lineCol = colIndex("line");
  const areaCol = colIndex("area");
  const teamCol = colIndex("team");
  const positionCol = colIndex("position");
  const managerHrIdCol = colIndex("directManagerId");
  const managerNameCol = colIndex("directManagerName");
  const paymentModeCol = colIndex("paymentMode");
  const departmentCol = colIndex("department");
  const genderCol = colIndex("gender");
  const contractCol = colIndex("contractType");
  const statusCol = colIndex("employmentStatus");
  const hasBankAccountCol = colIndex("hasBankAccount");
  const medicalInsuranceStatusCol = colIndex("medicalInsuranceStatus");
  const socialInsuranceStatusCol = colIndex("socialInsuranceStatus");

  const areaLetter = columnLetter(areaCol);
  const managerHrIdLetter = columnLetter(managerHrIdCol);

  const departmentFormula = lookups.departments.length ? `"${lookups.departments.join(",")}"` : null;

  for (let rowNumber = firstDataRowNumber; rowNumber <= bufferedLastRow; rowNumber += 1) {
    if (departmentFormula) {
      sheet.getCell(rowNumber, departmentCol).dataValidation = { allowBlank: true, formulae: [departmentFormula], type: "list" };
    }
    // Team cascades from Area, same INDIRECT technique as Area cascading from Line.
    sheet.getCell(rowNumber, teamCol).dataValidation = {
      allowBlank: true,
      formulae: [`=INDIRECT(${indirectTokenFormula("TEAMS", `${areaLetter}${rowNumber}`)})`],
      type: "list",
      promptTitle: "Select Team",
      prompt: "Pick an Area first — only that area's teams are shown.",
      showInputMessage: true,
      showErrorMessage: false,
    };

    sheet.getCell(rowNumber, lineCol).dataValidation = {
      allowBlank: true,
      formulae: ["LINES_LIST"],
      type: "list",
      promptTitle: "Select Line",
      prompt: "Choose one of the active field lines.",
      showInputMessage: true,
    };
    sheet.getCell(rowNumber, areaCol).dataValidation = {
      allowBlank: true,
      formulae: ["AREAS_LIST"],
      type: "list",
      promptTitle: "Select Area",
      prompt: "All currently active areas. Not filtered by Line — most areas have a dedicated rep per line.",
      showInputMessage: true,
    };
    if (lookups.positions.length) {
      sheet.getCell(rowNumber, positionCol).dataValidation = { allowBlank: true, formulae: ["POSITIONS_LIST"], type: "list" };
    }

    sheet.getCell(rowNumber, paymentModeCol).dataValidation = { allowBlank: true, formulae: ['"two_parts,one_part"'], type: "list" };
    sheet.getCell(rowNumber, genderCol).dataValidation = { allowBlank: true, formulae: ['"Male,Female,Other,Not specified"'], type: "list" };
    sheet.getCell(rowNumber, contractCol).dataValidation = {
      allowBlank: true,
      formulae: ['"Permanent,Fixed-term,Temporary,Consultant,Internship,Not specified"'],
      type: "list",
    };
    sheet.getCell(rowNumber, statusCol).dataValidation = {
      allowBlank: true,
      formulae: ['"active,on_leave"'],
      type: "list",
      promptTitle: "Lifecycle-protected",
      prompt: "Only active/on_leave are importable here. Use the Resignation workflow to exit an employee.",
      showInputMessage: true,
    };
    sheet.getCell(rowNumber, hasBankAccountCol).dataValidation = { allowBlank: true, formulae: ['"yes,no"'], type: "list" };
    sheet.getCell(rowNumber, medicalInsuranceStatusCol).dataValidation = { allowBlank: true, formulae: ['"yes,no,pending"'], type: "list" };
    sheet.getCell(rowNumber, socialInsuranceStatusCol).dataValidation = { allowBlank: true, formulae: ['"yes,no,pending"'], type: "list" };

    // Auto-populate: Direct Manager name resolves live from the Manager HR_ID typed in
    // the adjacent column — retype/clear the HR_ID and the name updates immediately.
    const managerHrIdRef = `${managerHrIdLetter}${rowNumber}`;
    sheet.getCell(rowNumber, managerNameCol).value = {
      formula: `IFERROR(IF(${managerHrIdRef}="","",VLOOKUP(${managerHrIdRef},MANAGER_DIRECTORY,2,FALSE)),"(not found)")`,
    };
  }

  // Duplicate Employee ID -> instant red highlight (a paste-in typo is visible before upload).
  sheet.addConditionalFormatting({
    ref: `${columnLetter(employeeIdCol)}${firstDataRowNumber}:${columnLetter(employeeIdCol)}${bufferedLastRow}`,
    rules: [
      {
        type: "expression",
        formulae: [`COUNTIF($${columnLetter(employeeIdCol)}$${firstDataRowNumber}:$${columnLetter(employeeIdCol)}$${bufferedLastRow},${columnLetter(employeeIdCol)}${firstDataRowNumber})>1`],
        priority: 1,
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: BRAND.danger } }, font: { color: { argb: "FFFFFFFF" }, bold: true } },
      },
    ],
  });

  const approvedDepartmentSet = new Set(lookups.departments.map((name) => name.toLowerCase()));
  for (let rowNumber = firstDataRowNumber; rowNumber <= lastDataRow; rowNumber += 1) {
    const cell = sheet.getCell(rowNumber, departmentCol);
    const value = String(cell.value ?? "").trim();
    if (value && !approvedDepartmentSet.has(value.toLowerCase())) {
      cell.note = "Legacy department value. Choose an approved department before re-uploading if this employee should be remapped.";
      cell.fill = { fgColor: { argb: "FFFFF7ED" }, pattern: "solid", type: "pattern" };
    }
  }

  // Protect the auto-populated formula column so a manual overwrite doesn't silently
  // desync it from the Manager HR_ID it mirrors — every other cell stays editable.
  for (let rowNumber = 1; rowNumber <= bufferedLastRow; rowNumber += 1) {
    columns.forEach((column, index) => {
      sheet.getCell(rowNumber, index + 1).protection = { locked: FORMULA_COLUMN_KEYS.has(column.key) };
    });
  }
  await sheet.protect("", { selectLockedCells: false, selectUnlockedCells: true, formatCells: true, sort: true, autoFilter: true });
}

function addInstructionsSheet(workbook: ExcelJS.Workbook, lookups: LookupValues) {
  const sheet = workbook.addWorksheet("Instructions");
  sheet.columns = [
    { header: "Topic", key: "topic", width: 28 },
    { header: "Guidance", key: "guidance", width: 110 },
  ];
  sheet.addRows([
    { topic: "Purpose", guidance: "Use the Active Employee Master sheet to complete or correct fixed employee master data, then upload it from Employees." },
    { topic: "Lifecycle protection", guidance: "Only active and on_leave statuses are accepted by import. Resigned, terminated, inactive, hidden, and payroll-ineligible employees are blocked from reactivation." },
    { topic: "Upsert rule", guidance: "Employee ID / HR_ID is the key. Existing HR_ID rows update; new HR_ID rows create new active employee records." },
    { topic: "Cascading dropdowns", guidance: "Area is one flat list of all active canonical areas — Line does not filter it, since CNS, Anti-Infective, and Pedia reps commonly share the same area. Pick an Area and the Team dropdown then only shows that area's teams. This mirrors the 42-canonical-area model and prevents mistyped/legacy area names." },
    { topic: "Auto-populate", guidance: "Direct Manager (auto) is a live formula, not typed text: type or change the Manager HR_ID and the manager's name resolves automatically from the current directory. This cell is protected — edit the HR_ID, not the name." },
    { topic: "Duplicate Employee ID", guidance: "Any Employee ID repeated more than once highlights red automatically, before you upload." },
    { topic: "Master data fields", guidance: "All workbook columns are fixed Employee Master fields stored on employees. Users & Access fields and retired wage fields are intentionally excluded." },
    { topic: "Department dropdown", guidance: `Department uses active global lookup values: ${lookups.departments.join(", ")}. Inactive legacy departments are excluded from the dropdown.` },
    { topic: "Team values", guidance: lookups.teams.length ? "Team dropdowns cascade from the selected Area." : "Team is accepted as text. Upload validates Team and maps or creates global team rows safely." },
    { topic: "Blank optional values", guidance: "Blank optional cells do not erase existing values during import; provide a value only when you want to create or update it." },
  ]);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos" };
  sheet.getRow(1).fill = { fgColor: { argb: BRAND.navy }, pattern: "solid", type: "pattern" };
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: BRAND.border } } };
    });
  });
}

function fileName() {
  return `phoenix-active-employee-master-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "export");

    const directory = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);

    const lines = Array.from(
      new Map(
        (directory.lookups.lines ?? [])
          .filter((line) => line.label)
          .map((line) => [line.label, { label: line.label, id: line.id ?? null }]),
      ).values(),
    ).sort((left, right) => left.label.localeCompare(right.label));

    const areas = (directory.lookups.areas ?? [])
      .filter((area) => area.label)
      .map((area) => ({ label: area.label, value: area.value }));

    const teams = (directory.lookups.teams ?? [])
      .filter((team) => team.label)
      .map((team) => ({ label: team.label, areaId: team.areaId ?? null }));

    const lookupValues: LookupValues = {
      departments: Array.from(new Set(directory.lookups.departments.map((d) => d.label).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      teams,
      lines,
      areas,
      positions: Array.from(new Set((directory.lookups.positions ?? []).map((p) => p.label).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      managerDirectory: directory.employees
        .filter((employee) => employee.employmentStatus === "active" || employee.employmentStatus === "on_leave" || !employee.employmentStatus)
        .map((employee) => ({ hrId: employee.hrId, fullName: employee.fullName })),
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = systemDocuments.workbookCreator;
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.subject = "Active Employee Master Data";
    workbook.title = systemDocuments.titles.activeEmployeeMasterDataWorkbook;

    const sheet = workbook.addWorksheet("Active Employee Master");
    sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }));
    // 4 header rows precede data (title, subtitle, section, header) — matches
    // firstDataRowNumber=5 in styleWorksheet.
    sheet.spliceRows(1, 0, [], [], columns.map((column) => column.section));
    const exportRows = directory.employees.map(employeeToExportRow);
    sheet.addRows(exportRows);

    addLookupDataSheet(workbook, lookupValues);
    await styleWorksheet(sheet, workbook, lookupValues, exportRows.length);
    addInstructionsSheet(workbook, lookupValues);

    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to export employees." }, { status: 403 });
    }

    return NextResponse.json(
      {
        error: "employee_export_failed",
        message: error instanceof Error ? error.message : "Unable to export employee master data.",
      },
      { status: 500 },
    );
  }
}
