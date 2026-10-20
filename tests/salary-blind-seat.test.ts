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
import { parseEmployeeUploadRows } from "../src/lib/imports/employee-upload-parse.ts";
import { validateEmployeeImportRows } from "../src/lib/imports/employee-validator.ts";
import { canViewOrganogramSensitiveFields } from "../src/lib/reports/organogram.ts";
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
  assert.equal(updated.compensation.paymentMode, "one_part", "payment mode is not money and still imports");
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
}
