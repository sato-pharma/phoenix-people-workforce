import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isSalaryBlindRole } from "../src/lib/auth/hr-functions.ts";
import {
  canAccess,
  createAccessContext,
  filterEmployeeDirectoryForAccess,
  isSalaryRedactedForViewer,
} from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildImportChangePreview } from "../src/lib/employees/employee-import-change-preview.ts";
import { buildEmployeeImportFixListWorkbook } from "../src/lib/employees/employee-import-fix-list-workbook.ts";
import {
  buildEmployeeMasterWorkbook,
  buildRowCheckFormula,
  employeeMasterWorkbookContract,
  FIRST_DATA_ROW,
} from "../src/lib/employees/employee-master-workbook.ts";
import {
  MONEY_IMPORT_FIELDS,
  NEW_EMPLOYEE_NOT_ALLOWED_CODE,
  SALARY_BLIND_MONEY_COLUMNS_CODE,
  salaryBlindImportRefusal,
} from "../src/lib/imports/employee-import-salary-blind.ts";
import {
  PAY_FLAG_KEPT_CODE,
  PAY_FLAGS_NOT_COMPARED_MESSAGE,
  storedPayFlagsFromRow,
  type StoredPayFlags,
  withStoredPayFlags,
} from "../src/lib/employees/salary-blind-pay-flags.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { parseEmployeeUploadRows } from "../src/lib/imports/employee-upload-parse.ts";
import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import { canViewOrganogramSensitiveFields } from "../src/lib/reports/organogram.ts";
import {
  canChangeResignationDates,
  isResignationDatesKeptFromViewer,
  RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE,
} from "../src/lib/resignations/service.ts";
import { buildOrganogramEmployeeDetail } from "../src/lib/reports/organogram-employee-detail.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE SEAT THAT NEVER SEES A SALARY — the HR Operations Specialist (role key "HR Administration").
 *
 * Owner, 2026-10-20: she never sees a salary, an allowance, an insurance amount or a tax amount;
 * bank name, bank account, has-bank-account and payment mode stay visible; she imports and exports
 * the Employee Master "with no salary"; the organogram hides salary; she follows resignations he
 * submits without seeing a settlement; and she does not add an employee.
 *
 * Every one of those is enforced where the data leaves the server, so this pins the server half:
 * the redaction, the export, the import (refusal, validator, write), the organogram popup and the
 * resignations read — then the few screen gates that would otherwise offer her a 403.
 */

const SEAT = "HR Administration";
const MONEY_LABELS = [
  "Base salary",
  "Basic salary",
  "Gross salary",
  "Net salary",
  "Fuel allowance",
  "Extra cost of living",
  "Medical insurance",
  "Social insurance",
  "Social insurance wage",
  "Taxes",
];

function source(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

function employee(index: number) {
  return {
    areaId: 1,
    areaName: "Cairo",
    bankAccount: `EG-ACCOUNT-${index}`,
    bankName: "SENTINEL_BANK",
    baseSalary: 16000,
    basicSalary: 11200,
    birthDate: "1990-04-11",
    birthPlace: "Giza",
    collegeMajor: "Pharmacology",
    contractDuration: "1 Year",
    contractRenewalDate: "2027-01-01",
    contractType: "Full time",
    createdAt: "2024-01-01T00:00:00Z",
    crmId: `C-${index}`,
    crmUsername: `user${index}`,
    departmentId: 2,
    departmentName: "Sales",
    displayName: `Person ${index}`,
    education: "Pharmacy",
    employmentStatus: "active",
    extraCostOfLiving: 2000,
    fuelAllowance: 500,
    fullName: `Person ${index}`,
    gender: "Male",
    grossSalary: 20358.35,
    hasBankAccount: "yes",
    hasPhoto: false,
    healthCardNumber: null,
    healthCardReceivedDate: null,
    healthCardStatus: null,
    hireDate: "2022-06-01",
    hrId: `PD-09${String(index).padStart(2, "0")}`,
    jobTitle: "Medical Representative",
    kaabElamaalIssueDate: null,
    kaabElamaalIssuer: null,
    kaabElamaalNumber: null,
    kaabElamaalRefund: null,
    lastWorkingDate: null,
    lineId: 4,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    medicalInsurance: 200,
    medicalInsuranceCardReceivedDate: null,
    medicalInsuranceNumber: "M1",
    medicalInsuranceStatus: "yes",
    mobileNumber: "01000000000",
    nameAr: "اسم عربي",
    nationalId: "29004110100011",
    netSalary: 18500,
    nickname: null,
    organogramVisible: true,
    payrollEligible: true,
    pendingManagerReplacementForHrId: null,
    positionId: 5,
    positionTitle: "Medical Representative",
    probationEndDate: null,
    qualification: "Bachelor",
    regionName: "Cairo",
    residenceAddress: "1 Some Street",
    residenceArea: "Dokki",
    residenceCity: "Giza",
    residenceGeocodeStatus: null,
    residenceLatitude: null,
    residenceLongitude: null,
    resignationDate: null,
    salaryDetails: [{ amount: 1000, label: "Car" }],
    salaryPaymentMode: "two_parts" as const,
    seniorYear: "2019",
    socialInsurance: 1837,
    socialInsuranceNumber: "S1",
    socialInsuranceStartDate: null,
    socialInsuranceStatus: "yes",
    socialInsuranceWage: 6000,
    taxes: 2521.35,
    teamId: 9,
    teamName: "Team A",
    universityName: "Cairo University",
    updatedAt: "2026-09-01T00:00:00Z",
    workEmail: `person${index}@example.com`,
  };
}

const EMPLOYEES = [employee(1), employee(2)];

function directory(): EmployeeDirectoryData {
  return {
    employees: EMPLOYEES as unknown as EmployeeDirectoryRow[],
    lookups: {
      areas: [],
      departments: [],
      lines: [],
      managers: [],
      medicalRepVacancies: [],
      positions: [],
      statuses: [],
      teams: [],
      workforceVacancies: [],
    },
    summary: { activeEmployees: 2, employeesWithoutManagers: 2, totalEmployees: 2, uniqueAreas: 1, uniqueLines: 1 },
  };
}

function workbookText(sheet: { eachRow: (callback: (row: { eachCell: (cb: (cell: { value: unknown }) => void) => void }) => void) => void }) {
  const texts: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => texts.push(String(cell.value ?? ""))));
  return texts;
}

const importState = {
  canonicalAreas: [{ code: "AB1", name: "Cairo" }],
  employeeHrIdByCanonicalKey: new Map(),
  employeeHrIds: new Set(EMPLOYEES.map((row) => row.hrId)),
};

function importRow(hrId: string, overrides: Record<string, unknown> = {}) {
  return {
    Area: "Cairo",
    "Full Name": `Person ${hrId}`,
    HR_ID: hrId,
    "Job Title": "Medical Representative",
    Line: "Pedia",
    "Payment Mode": "one_part",
    Position: "Medical Representative",
    // One region per person, so no two rows of this file claim the same seat (a duplicate-seat
    // block would hide the rule under test).
    Region: `Cairo ${hrId}`,
    ...overrides,
  };
}

export async function runSalaryBlindSeatTests() {
  const seat = createAccessContext({ hrId: "HR-SEAT", role: SEAT });
  const ops = createAccessContext({ hrId: "HR-OPS", role: "HR Operations" });

  // ── 1. the grants: the master without adding to it, departures followed but never recorded ──
  assert.equal(isSalaryBlindRole(SEAT), true);
  assert.equal(isSalaryBlindRole("HR Operations"), false, "HR Operations keeps the salary columns she maintains");
  for (const action of ["read", "update", "export", "import"] as const) {
    assert.equal(await canAccess(seat, "employees", action), true, `the seat keeps employees:${action}`);
  }
  assert.equal(await canAccess(seat, "employees", "create"), false, "she does not add an employee");
  assert.equal(await canAccess(seat, "resignations", "create"), false, "the owner submits a resignation");
  assert.equal(await canAccess(seat, "resignations", "update"), true, "she follows it to the completed cycle");
  assert.equal(await canAccess(seat, "organogram", "read"), true);
  assert.equal(await canAccess(seat, "payroll", "read"), false, "no payroll grant, anywhere");

  // ── 2. the directory: every figure withheld, bank and payment mode kept ──────────────────────
  assert.equal(isSalaryRedactedForViewer(seat, "PD-0901"), true);
  assert.equal(isSalaryRedactedForViewer(ops, "PD-0901"), false);
  const seen = filterEmployeeDirectoryForAccess(directory(), seat).employees;
  assert.equal(seen.length, EMPLOYEES.length, "salary is withheld, people are not");
  for (const row of seen) {
    for (const field of [...MONEY_IMPORT_FIELDS, "socialInsuranceWage"] as const) {
      assert.equal(row[field], null, `${field} must reach the seat as null`);
    }
    assert.equal(row.salaryDetails, null, "the flexible salary details are money too");
    assert.equal(row.bankName, "SENTINEL_BANK", "bank name is not money");
    assert.ok(row.bankAccount?.startsWith("EG-ACCOUNT"), "bank account is not money");
    assert.equal(row.salaryPaymentMode, "two_parts", "payment mode is not money");
    assert.equal(row.hasBankAccount, "yes");
  }
  assert.equal(
    filterEmployeeDirectoryForAccess(directory(), ops).employees[0].baseSalary,
    16000,
    "HR Operations still sees the figures — the seat rule must not leak onto her",
  );

  // ── 3. the export: money columns hidden, empty and locked, letters unchanged ─────────────────
  const workbook = await buildEmployeeMasterWorkbook({
    // The real directory reaches the builder redacted; these carry figures on purpose, so the
    // builder is shown to blank them itself rather than trusting its caller.
    canCreate: false,
    employees: EMPLOYEES as never,
    lookups: { areas: [], departments: [], lines: [], managerDirectory: [], positions: [], teams: [] },
    omitMoney: true,
  });
  const master = workbook.getWorksheet(employeeMasterWorkbookContract.masterSheetName);
  assert.ok(master, "the master sheet exists");
  const moneyColumns = employeeMasterWorkbookContract.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.kind === "money");
  assert.ok(moneyColumns.length >= 10, "AL..AU: nine imported money columns plus the insurance wage");
  for (const { column, index } of moneyColumns) {
    const letterColumn = master.getColumn(index + 1);
    assert.equal(letterColumn.hidden, true, `${column.header} must be HIDDEN, never removed — removing shifts every letter`);
    assert.equal(
      String(master.getRow(employeeMasterWorkbookContract.headerRow).getCell(index + 1).value),
      column.header,
      `${column.header} keeps its header, so the column letters the importer reads never move`,
    );
    for (let row = FIRST_DATA_ROW; row < FIRST_DATA_ROW + EMPLOYEES.length; row += 1) {
      assert.equal(master.getCell(row, index + 1).value, null, `${column.header} row ${row} must be empty`);
      assert.equal(master.getCell(row, index + 1).protection?.locked, true, `${column.header} must be locked`);
    }
  }
  const startHere = workbookText(workbook.getWorksheet("Start Here") as never).join("\n");
  assert.ok(!/type 0/i.test(startHere), "the salary-blind guide never advises typing 0 into a money cell");
  assert.ok(startHere.includes("No salary figures"), "it says in words why the money is absent");
  assert.ok(!startHere.includes("add new people"), "a seat without employees:create is not invited to add anyone");
  const uploadRules = workbookText(workbook.getWorksheet("Upload Rules") as never);
  assert.ok(uploadRules.includes(SALARY_BLIND_MONEY_COLUMNS_CODE), "the refusal is listed under its own code");
  assert.ok(uploadRules.includes(NEW_EMPLOYEE_NOT_ALLOWED_CODE), "so is the no-add rule");
  assert.ok(uploadRules.includes(PAY_FLAG_KEPT_CODE), "so is the rule that payment mode and payroll eligible stay as they are");
  assert.ok(!uploadRules.includes("invalid_payment_mode"), "the payment-mode spelling rule leaves her list — she never sets one");
  for (const code of ["invalid_numeric_value", "base_salary_formula_mismatch", "fuel_allowance_policy_mismatch"]) {
    assert.ok(!uploadRules.includes(code), `${code} describes a column she cannot fill — it leaves her rules`);
  }
  const fieldGuide = workbookText(workbook.getWorksheet("Field Guide") as never);
  for (const { column } of moneyColumns) {
    assert.ok(!fieldGuide.includes(column.header), `the Field Guide must not explain ${column.header} to her`);
  }

  // The row check's cleared-payroll clause COUNTAs the money cells and says "type 0".
  const rowCheckInput = {
    hasAreas: false,
    hasDepartments: false,
    hasManagers: false,
    lastRow: 300,
    originalMoneyFilled: 9,
    rowNumber: FIRST_DATA_ROW,
  };
  assert.ok(buildRowCheckFormula(rowCheckInput).includes("type 0"), "the full sheet keeps its advisory");
  assert.ok(
    !buildRowCheckFormula({ ...rowCheckInput, omitMoney: true }).includes("type 0"),
    "the salary-blind sheet drops the COUNTA money clause",
  );

  // ── 4. the round trip: her own export re-imports with no refusal and no figure ───────────────
  const buffer = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
  const parsed = await parseEmployeeUploadRows<Record<string, unknown>>(
    new File([buffer], "her-export.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  assert.ok(!("error" in parsed), `the importer must read her export: ${JSON.stringify(parsed)}`);
  assert.equal(salaryBlindImportRefusal(parsed.rows), null, "her own export must never be refused");

  const typed = parsed.rows.map((row, index) => (index === 0 ? { ...row, "Base Salary": 5000 } : row));
  const refusal = salaryBlindImportRefusal(typed);
  assert.ok(refusal, "one typed figure refuses the whole file");
  assert.equal(refusal.error, SALARY_BLIND_MONEY_COLUMNS_CODE);
  assert.deepEqual(refusal.filledColumns, ["Base Salary"], "the refusal names the column to clear");
  assert.ok(refusal.message.includes("Base Salary"));
  assert.equal(
    salaryBlindImportRefusal([{ HR_ID: "PD-0901", "Net Salary": " - " }]),
    null,
    "a dash is the importer's own empty value, not a figure",
  );
  assert.deepEqual(
    salaryBlindImportRefusal([{ HR_ID: "PD-0901", "base salary": 1, "Base Salary": null }])?.filledColumns,
    ["base salary"],
    "EVERY header that maps to a money field is checked, not only the first the validator keeps",
  );

  // ── 5. the validator: no money planned, no policy step, no new person ────────────────────────
  const blind = validateEmployeeImportRows(
    [
      importRow("PD-0901"),
      importRow("PD-0902", { "Fuel Allowance": 900 }),
      importRow("PD-0999"),
    ],
    { allowNewEmployees: false, existingState: importState, salaryBlind: true },
  );
  const updated = blind.rowsToUpdate.find((record) => record.hrId === "PD-0901");
  assert.ok(updated, "a known employee with no figure updates");
  for (const field of MONEY_IMPORT_FIELDS) {
    assert.equal(updated.compensation[field], null, `${field} is never planned for her`);
  }
  // Owner, 2026-10-20: "can change bank account but never a paymode" — so the mode in her file is
  // never planned for a write (section 12 has the comparison with the master).
  assert.equal(updated.compensation.paymentMode, null, "payment mode is never written from her file");
  assert.equal(updated.payrollEligible, null, "nor payroll eligible");
  assert.equal(updated.employmentStatus, null, "nor employment status — an inactive status turns pay off with it");
  assert.ok(
    !blind.validationWarnings.some((issue) => /_(policy|formula)_mismatch$/.test(issue.code)),
    "the position-policy step is skipped — its warnings print amounts",
  );
  assert.ok(
    blind.validationErrors.some(
      (issue) => issue.code === SALARY_BLIND_MONEY_COLUMNS_CODE && issue.field === "fuelAllowance",
    ),
    "a row carrying a figure is blocked even when a caller skipped the file-level refusal",
  );
  assert.ok(!blind.rowsToUpdate.some((record) => record.hrId === "PD-0902"), "and it is not written");
  assert.equal(blind.rowsToInsert.length, 0, "nobody is created by an importer without employees:create");
  assert.ok(
    blind.validationErrors.some((issue) => issue.code === NEW_EMPLOYEE_NOT_ALLOWED_CODE && issue.field === "hrId"),
    "the unknown Employee ID is refused by name, not inserted",
  );

  // The same rows for HR Operations: the policy step runs, and the unknown ID is a new hire.
  const full = validateEmployeeImportRows([importRow("PD-0901"), importRow("PD-0999")], { existingState: importState });
  const fullRow = full.rowsToUpdate.find((record) => record.hrId === "PD-0901");
  assert.ok(fullRow);
  assert.notEqual(fullRow.compensation.fuelAllowance, null, "without the seat rule the policy fills the allowances");
  assert.equal(full.rowsToInsert.length, 1, "and an unknown ID is still a new employee for a seat that may add one");

  // The change preview she approves from carries no money line.
  const preview = buildImportChangePreview({
    employees: filterEmployeeDirectoryForAccess(directory(), seat).employees,
    records: blind.rowsToUpdate,
  });
  assert.equal(preview.moneyChangeCount, 0, "the preview never shows her a money change");
  assert.ok(
    preview.people.every((person) => person.changes.every((change) => !change.isMoney)),
    "not one money line in the preview",
  );

  // The fix list's guidance says nothing about recalculated salaries.
  const fixList = await buildEmployeeImportFixListWorkbook({ omitMoney: true, result: blind });
  const summary = workbookText(fixList.getWorksheet("Summary") as never).join("\n");
  assert.ok(!summary.includes("Salary figures are recalculated"));
  assert.ok(!/type 0/i.test(summary));

  // ── 6. the import routes decide both flags on the server, before planning, and write no money ─
  for (const route of ["dry-run", "fix-list", "confirm"]) {
    const body = source(`app/api/imports/employees/${route}/route.ts`);
    assert.ok(body.includes("isSalaryBlindRole(access.role)"), `${route} reads the seat from the access context`);
    assert.ok(body.includes('canAccess(access, "employees", "create")'), `${route} reads employees:create`);
    const refusalAt = body.indexOf("salaryBlindImportRefusal(parsed.rows)");
    const planAt = body.indexOf("createEmployeeImportPlan(parsed.rows");
    assert.ok(refusalAt > 0 && planAt > refusalAt, `${route} refuses a file with figures BEFORE planning it`);
    assert.match(body.slice(planAt), /allowNewEmployees,[\s\S]{0,200}?salaryBlind,/, `${route} plans with both flags`);
  }
  assert.ok(source("app/api/imports/employees/fix-list/route.ts").includes("omitMoney: salaryBlind"));
  assert.ok(source("app/api/imports/employees/confirm/route.ts").includes("withoutMoney(record)"));
  assert.match(
    source("app/api/imports/employees/confirm/route.ts"),
    /if \(salaryBlind\) \{\s*for \(const record of \[\.\.\.dryRunResult\.rowsToInsert, \.\.\.dryRunResult\.rowsToUpdate\]\) \{\s*withoutMoney\(record\);\s*withoutPayFlags\(record\);/,
    "the write blanks payment mode and payroll eligible for her again, beside the money",
  );
  const template = source("app/api/employees/template/route.ts");
  assert.ok(template.includes("const omitMoney = isSalaryBlindRole(access.role)"), "the export is salary-blind for her");
  assert.match(template, /buildEmployeeMasterWorkbook\(\{[\s\S]*?canCreate,[\s\S]*?omitMoney,/);

  // ── 7. the employee save: no money key, and an add needs employees:create ────────────────────
  const save = source("app/api/employees/route.ts");
  assert.match(
    save,
    /if \(!payload\.employee\.originalHrId\?\.trim\(\)\) \{\s*await assertPermission\(access, "employees", "create"\);/,
    "a save with no original Employee ID is an ADD and asserts employees:create",
  );
  const blindSave = save.slice(save.indexOf("if (isSalaryBlindRole(access.role))"));
  for (const key of ["baseSalary", "netSalary", "salaryDetails", "socialInsuranceWage", "taxes"]) {
    assert.ok(blindSave.includes(`${key}: undefined`), `${key} is dropped as UNDEFINED — null would wipe salary details`);
  }

  // ── 8. the organogram: her popup shows what her master shows, minus every figure ─────────────
  assert.equal(canViewOrganogramSensitiveFields(seat), true);
  const detail = buildOrganogramEmployeeDetail(EMPLOYEES[0] as unknown as EmployeeDirectoryRow, {
    canViewSensitive: true,
    omitSalary: true,
    redactSalary: true,
  });
  const compensation = detail.sections.find((section) => section.title === "Compensation");
  assert.ok(compensation, "bank and payment mode still have a home");
  const labels = compensation.items.map((item) => item.label);
  for (const label of MONEY_LABELS) {
    assert.ok(!labels.includes(label), `${label} is left out of her popup, not shown blank`);
  }
  assert.ok(labels.includes("Bank") && labels.includes("Bank account") && labels.includes("Payment mode"));
  const payload = JSON.stringify(detail);
  assert.ok(!payload.includes("EGP") && !payload.includes("16,000"), "no figure leaves the server in her payload");
  for (const route of [
    "app/api/reports/organogram/employee/[hrId]/route.ts",
    "app/api/reports/organogram/employee/[hrId]/pdf/route.ts",
  ]) {
    assert.ok(source(route).includes("omitSalary: isSalaryBlindRole(access.role)"), `${route} drops her money rows`);
  }

  // ── 9. resignations: no settlement, no signed device value, and a sentence instead ───────────
  const service = source("src/lib/resignations/service.ts");
  assert.ok(service.includes("const settlementWithheld = isSalaryBlindRole(scopedAccess.role)"));
  assert.match(service, /settlement: settlementWithheld\s*\?\s*null/, "the settlement preview is null for her");
  assert.match(service, /agreedValueEgp: null/, "a held device's signed value is null for her");
  assert.match(service, /return \{ employees, payrollCandidates, records, settlementWithheld, summary \};/);
  for (const caller of [
    "app/api/resignations/route.ts",
    "app/api/resignations/[id]/workflow/route.ts",
    "app/api/resignations/[id]/dates/route.ts",
    "app/(admin)/resignations/page.tsx",
    "app/employee-portals/resignations/page.tsx",
  ]) {
    assert.ok(source(caller).includes("getResignationsDashboardData(access)"), `${caller} threads the viewer's access`);
  }
  const workspace = source("src/components/resignations/resignations-workspace.tsx");
  assert.ok(workspace.includes("Salary and settlement amounts are not shown for your seat."), "a plain line, never a 0");
  assert.match(workspace, /\{settlementWithheld \? null : \(\s*<>\s*<RgTh align="right">Base salary<\/RgTh>/);
  // She exports nothing from Resignations (owner, 2026-10-20). The per-tab Export is built in the
  // browser with no route behind it, so the page is the only gate — it rendered for her on production.
  assert.match(workspace, /canExportTab = true,/, "every other reader keeps the tab export");
  assert.match(
    workspace,
    /\{canExportTab \? \(\s*<RgButton disabled=\{busy === "export-tab"\}/,
    "the tab Export renders only when the page allows it",
  );
  assert.ok(
    source("app/(admin)/resignations/page.tsx").includes("canExportTab={!isSalaryBlindRole(access.role)}"),
    "the Resignations page withholds the tab export from the salary-blind seat",
  );

  // ── 10. the screens offer her no door the server refuses ─────────────────────────────────────
  const screen = source("src/components/employees/employee-management.tsx");
  assert.match(screen, /canStartResignation = false,/, "Resign and Declined fail closed");
  assert.match(screen, /\{canEdit && canStartResignation \? \(/, "the card's Resign needs resignations:create");
  assert.match(screen, /\{canStartResignation \? \(\s*<Button[\s\S]{0,400}?Mark as Resigned/, "the table's Resign too");
  for (const page of ["app/(admin)/employees/page.tsx", "app/employee-portals/employees/page.tsx"]) {
    const body = source(page);
    assert.ok(body.includes('canAccess(access, "resignations", "create")'), `${page} reads resignations:create`);
    assert.ok(body.includes("canStartResignation={canStartResignation}"), `${page} hands the screen that answer`);
    assert.ok(body.includes("salaryBlind={isSalaryBlindRole(access.role)}"), `${page} tells the screen she is salary-blind`);
    assert.ok(body.includes("canCreate={canCreate}"), `${page} hides Add Employee from a seat that cannot add`);
  }

  // ── 11. resignations: re-dating moves money, and Approve / Complete / Reject are his ──────────
  // `updateResignationDates` writes employees.last_working_date, which the leaver's payroll basis
  // reads, so the seat that never decides money may not re-date — although she holds
  // resignations:update to follow the resignation. And the owner, 2026-10-20: "You press Complete".
  const admin = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  assert.equal(
    RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE,
    "Changing resignation dates changes the leaver's pay, so it stays with the HR Manager.",
    "she is refused in plain words",
  );
  assert.equal(isResignationDatesKeptFromViewer(seat), true, "the seat is refused re-dating by name");
  assert.equal(await canChangeResignationDates(seat), false, "no Dates control for her, though she holds resignations:update");
  assert.equal(isResignationDatesKeptFromViewer(ops), false, "HR Operations is not refused by the seat rule");
  assert.equal(
    await canChangeResignationDates(ops),
    await canAccess(ops, "resignations", "update"),
    "HR Operations keeps exactly what resignations:update gives her",
  );
  assert.equal(await canChangeResignationDates(admin), true, "the control: the Super Admin re-dates");
  assert.equal(await canAccess(seat, "resignations", "approve"), false, "she never approves, rejects or completes");
  assert.equal(await canAccess(admin, "resignations", "approve"), true, "the control: the Super Admin decides");

  const datesRoute = source("app/api/resignations/[id]/dates/route.ts");
  const permissionAt = datesRoute.indexOf('assertPermission(access, "resignations", "update")');
  const refusalAt = datesRoute.indexOf("if (isResignationDatesKeptFromViewer(access))");
  const writeAt = datesRoute.indexOf("updateResignationDates(id, dates, actor)");
  assert.ok(permissionAt > 0 && refusalAt > permissionAt && writeAt > refusalAt, "the PATCH refuses her before it writes a date");
  assert.match(
    datesRoute.slice(refusalAt, writeAt),
    /message: RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE \},\s*\{ status: 403 \}/,
    "with a 403 carrying the plain sentence",
  );

  const workflowRoute = source("app/api/resignations/[id]/workflow/route.ts");
  assert.ok(
    workflowRoute.includes('action === "approve" || action === "reject" || action === "complete" ? "approve" : "update"'),
    "Approve, Reject and Complete each assert resignations:approve — the permission the buttons follow",
  );

  assert.match(workspace, /canDecide = false,/, "Approve, Complete and Reject fail closed");
  assert.match(workspace, /canEditDates = false,/, "Dates fails closed");
  assert.match(
    workspace,
    /\{canEditDates \? \(\s*<RgButton[\s\S]{0,400}?setEditing\(record\)[\s\S]{0,400}?Dates\s*<\/RgButton>\s*\) : null\}/,
    "the Dates button renders only on canEditDates",
  );
  assert.match(
    workspace,
    /\{canDecide \? \(\s*<>[\s\S]*?runAction\(record, "complete"\)[\s\S]*?runAction\(record, "approve"\)[\s\S]*?Reject\s*<\/RgButton>\s*<\/>\s*\) : null\}/,
    "Complete, Approve and Reject render only on canDecide",
  );
  for (const [needle, what] of [
    ['runAction(record, "complete")', "Complete"],
    ['runAction(record, "approve")', "Approve"],
    ["setRejecting(record)", "Reject"],
    ["setEditing(record)", "Dates"],
  ] as const) {
    assert.equal(workspace.split(needle).length - 1, 1, `exactly one ${what} control, so no ungated copy survives`);
  }
  for (const page of ["app/(admin)/resignations/page.tsx", "app/employee-portals/resignations/page.tsx"]) {
    const body = source(page);
    assert.ok(
      body.includes('canDecide={await canAccess(access, "resignations", "approve")}'),
      `${page} resolves Approve / Complete / Reject on resignations:approve`,
    );
    assert.ok(body.includes("canEditDates={await canChangeResignationDates(access)}"), `${page} resolves Dates on the server`);
  }

  // The seat's migration grants her the review step only — never resignation completion.
  const seatMigration = readFileSync("supabase/migrations/20261020064831_hr_operations_specialist_seat.sql", "utf8");
  assert.ok(!seatMigration.includes("resignation_complete"), "her workflow actions do not include completing a resignation");
  assert.equal(
    (seatMigration.match(/\('resignations', 'resignation_mark_review'\)/g) ?? []).length,
    2,
    "the review step is granted and proved",
  );
  assert.match(seatMigration, /if v_actions <> 5 then/, "the proof block counts five actions");

  // ── 12. payment mode and payroll eligible: hers to see, never to change ─────────────────────
  // Owner, 2026-10-20: "can change bank account but never a paymode". Payroll eligible decides
  // whether the person is paid at all, so it is held the same way. Both doors close on the server.
  assert.deepEqual(
    storedPayFlagsFromRow({ employment_status: "active", payment_mode: "two_parts", payroll_eligible: null }),
    { employmentStatus: "active", paymentMode: "two_parts", payrollEligible: true },
    "derived as the directory derives it: a blank eligibility on an active person is eligible",
  );
  assert.deepEqual(
    storedPayFlagsFromRow({ employment_status: "active", payment_mode: null, payroll_eligible: false }, "one_part"),
    { employmentStatus: "active", paymentMode: "one_part", payrollEligible: false },
    "the compensation row's mode when the employee row has none, and a deliberate No is kept",
  );

  // The save: the master's two values go back over whatever the form sent; bank details do not.
  const keptSave = withStoredPayFlags(
    {
      bankAccount: "EG-NEW-ACCOUNT",
      bankName: "NEW_BANK",
      employmentStatus: "inactive",
      payrollEligible: true,
      salaryPaymentMode: "two_parts",
    },
    { employmentStatus: "on_leave", paymentMode: "one_part", payrollEligible: false },
  );
  assert.equal(keptSave.salaryPaymentMode, "one_part", "the form's payment mode is replaced by the stored one");
  assert.equal(keptSave.payrollEligible, false, "and its payroll eligible too");
  assert.equal(keptSave.employmentStatus, "on_leave", "and its employment status — inactive would stop the person's pay");
  assert.equal(keptSave.bankAccount, "EG-NEW-ACCOUNT", "bank account saves as she typed it");
  assert.equal(keptSave.bankName, "NEW_BANK", "bank name too");

  const blindBranch = save.slice(
    save.indexOf("if (isSalaryBlindRole(access.role))"),
    save.indexOf("isSalaryRedactedForViewer(access, payload.employee.hrId)"),
  );
  assert.ok(
    blindBranch.includes('readStoredPayFlags(payload.employee.originalHrId ?? "")'),
    "her save reads the master's two values fresh",
  );
  assert.match(
    blindBranch,
    /if \(!storedPayFlags\) \{\s*return NextResponse\.json\(\s*\{ error: "pay_flags_unreadable", message: PAY_FLAGS_UNREADABLE_MESSAGE \},\s*\{ status: 409 \},?\s*\);/,
    "an unreadable master saves nothing rather than a guess",
  );
  assert.match(blindBranch, /payload\.employee = withStoredPayFlags\(/, "the stored values are written back");
  assert.ok(
    !/salaryPaymentMode: undefined|payrollEligible: undefined/.test(blindBranch),
    "never dropped as undefined — employeePayload would write two parts and eligible in their place",
  );
  const directorySource = source("src/lib/employees/employee-directory.ts");
  const readerAt = directorySource.indexOf("export async function readStoredPayFlags(");
  assert.ok(readerAt > 0, "the directory exports the fresh reader");
  const reader = directorySource.slice(readerAt, directorySource.indexOf("\n}\n", readerAt));
  assert.ok(reader.includes("select=employment_status,payment_mode,payroll_eligible"), "it reads the row itself, not the cache");
  assert.ok(reader.includes("storedPayFlagsFromRow(rows[0], compensation?.payment_mode)"), "and derives as the directory does");

  // The import: an equal cell is ignored, a differing cell blocks its row in plain words.
  const payState = {
    ...importState,
    storedPayFlagsByCanonicalKey: new Map<string, StoredPayFlags>([
      [canonicalHrIdKey("PD-0901") as string, { employmentStatus: "active", paymentMode: "two_parts", payrollEligible: true }],
      [canonicalHrIdKey("PD-0902") as string, { employmentStatus: "active", paymentMode: "one_part", payrollEligible: false }],
    ]),
  };
  const modeChange = validateEmployeeImportRows(
    [
      importRow("PD-0901", { "Payment Mode": "two_parts", "Payroll Eligible": "Yes" }),
      importRow("PD-0902", { "Payment Mode": "two parts", "Payroll Eligible": "No" }),
    ],
    { allowNewEmployees: false, existingState: payState, salaryBlind: true },
  );
  const equalRow = modeChange.rowsToUpdate.find((record) => record.hrId === "PD-0901");
  assert.ok(equalRow, "a row whose two cells match the master imports");
  assert.equal(equalRow.compensation.paymentMode, null, "and its payment mode is still not written");
  assert.equal(equalRow.payrollEligible, null, "nor its payroll eligible");
  assert.ok(!modeChange.rowsToUpdate.some((record) => record.hrId === "PD-0902"), "a row that changes the mode is not written");
  assert.deepEqual(
    modeChange.validationErrors
      .filter((issue) => issue.code === PAY_FLAG_KEPT_CODE)
      .map((issue) => ({ field: issue.field, message: issue.message })),
    [
      {
        field: "paymentMode",
        message: "Payment mode stays with the HR Manager — this row changes it from One Part to Two Parts.",
      },
    ],
    "exactly one refusal, on the changed column, in the owner's words",
  );

  const eligibleChange = validateEmployeeImportRows(
    [
      importRow("PD-0901", { "Payment Mode": "three parts" }),
      importRow("PD-0902", { "Payment Mode": "one_part", "Payroll Eligible": "Yes" }),
    ],
    { allowNewEmployees: false, existingState: payState, salaryBlind: true },
  );
  const keptIssues = eligibleChange.validationErrors
    .filter((issue) => issue.code === PAY_FLAG_KEPT_CODE)
    .map((issue) => issue.message);
  assert.ok(
    keptIssues.includes("Payroll eligible stays with the HR Manager — this row changes it from No to Yes."),
    "putting someone on payroll is refused the same way",
  );
  assert.ok(
    keptIssues.includes('Payment mode stays with the HR Manager — this row changes it from Two Parts to "three parts".'),
    "a mode the importer does not recognise is a change too, named as she typed it",
  );
  assert.equal(eligibleChange.rowsToUpdate.length, 0, "neither row is written");

  // Employment status is held the same way: on leave is a change of status, so the row is refused
  // by name; a matching status imports and is still never written.
  const statusChange = validateEmployeeImportRows(
    [
      importRow("PD-0901", { "Employment Status": "active", "Payment Mode": "two_parts" }),
      importRow("PD-0902", { "Employment Status": "on_leave" }),
    ],
    { allowNewEmployees: false, existingState: payState, salaryBlind: true },
  );
  assert.ok(
    statusChange.validationErrors.some(
      (issue) =>
        issue.code === PAY_FLAG_KEPT_CODE &&
        issue.field === "employmentStatus" &&
        issue.message === "Employment status stays with the HR Manager — this row changes it from Active to On leave.",
    ),
    "changing a person's status is refused in plain words",
  );
  assert.ok(!statusChange.rowsToUpdate.some((record) => record.hrId === "PD-0902"), "and that row is not written");
  assert.equal(
    statusChange.rowsToUpdate.find((record) => record.hrId === "PD-0901")?.employmentStatus,
    null,
    "a matching status imports and is still never written",
  );

  // No master to compare with: both columns are ignored, said once, and still never written.
  const unchecked = validateEmployeeImportRows([importRow("PD-0901")], {
    allowNewEmployees: false,
    existingState: importState,
    salaryBlind: true,
  });
  assert.equal(
    unchecked.validationWarnings.filter((issue) => issue.message === PAY_FLAGS_NOT_COMPARED_MESSAGE).length,
    1,
    "one file-level warning that the two columns were ignored",
  );
  assert.equal(unchecked.rowsToUpdate[0]?.compensation.paymentMode, null);

  // Her own export round-trips with no pay-flag refusal: the cells are the master's own values.
  const exportState = {
    ...importState,
    storedPayFlagsByCanonicalKey: new Map<string, StoredPayFlags>(
      EMPLOYEES.map((row): [string, StoredPayFlags] => [
        canonicalHrIdKey(row.hrId) as string,
        {
          employmentStatus: row.employmentStatus ?? "active",
          paymentMode: row.salaryPaymentMode,
          payrollEligible: row.payrollEligible,
        },
      ]),
    ),
  };
  const roundTrip = validateEmployeeImportRows(parsed.rows, {
    allowNewEmployees: false,
    existingState: exportState,
    salaryBlind: true,
  });
  assert.ok(
    !roundTrip.validationErrors.some((issue) => issue.code === PAY_FLAG_KEPT_CODE),
    "her own export never trips the pay-flag rule",
  );

  // The control: HR Operations is not held by this rule — the same change plans a write for her.
  const opsChange = validateEmployeeImportRows([importRow("PD-0902", { "Payment Mode": "two_parts" })], {
    existingState: payState,
  });
  assert.ok(!opsChange.validationErrors.some((issue) => issue.code === PAY_FLAG_KEPT_CODE));
  assert.equal(
    opsChange.rowsToUpdate.find((record) => record.hrId === "PD-0902")?.compensation.paymentMode,
    "two_parts",
    "HR Operations still sets the payment mode",
  );

  // The screen shows both, read only, and leaves the bank fields open.
  assert.match(screen, /disabled=\{salaryBlind\}\s*label="Salary Payout Mode"/, "her payout mode is read only");
  assert.match(screen, /disabled=\{salaryBlind\}\s*label="Employment Status"/, "her employment status is read only");
  assert.match(
    screen,
    /disabled=\{salaryBlind \|\| !canSelectPayrollEligibility\}\s*label="Payroll Eligible"/,
    "her payroll eligible is read only",
  );
  for (const label of ["Bank Name", "Bank Account"]) {
    const at = screen.indexOf(`label="${label}"`);
    assert.ok(at > 0, `${label} is on the form`);
    assert.ok(!screen.slice(Math.max(0, at - 120), at).includes("disabled"), `${label} stays editable for her`);
  }
}
