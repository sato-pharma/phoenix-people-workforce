// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module's three workbooks.
//
// The invoice and the register wear the house identity. The movement file does NOT: it is the insurer's own
// form, sent to the insurer, and their system reads it by column. Its layout is theirs, so the columns
// below are in their order and with their headings, blank ones included.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";

import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { spreadsheetSafeText } from "@/lib/export/spreadsheet-safe";

import { COMPARISON_STATUS_WORDS, type InvoiceComparison } from "./compare";
import { MEDICAL_INSURANCE_PRODUCT_LABELS, MEDICAL_INSURANCE_PRODUCTS } from "./cost";
import type { MedicalInsuranceAction } from "./eligibility";
import { billedByProduct, type ParsedInvoice } from "./invoice-parser";
import { MEMBER_TYPE_WORDS, type MedicalInsuranceMemberRow, type MedicalInsurancePolicyView } from "./view";

const MONEY = "#,##0.00";

function day(value: string | null | undefined): string {
  if (!value) return "";
  const [year, month, date] = value.slice(0, 10).split("-");
  return `${date}/${month}/${year}`;
}

const text = (value: string | null | undefined): string => spreadsheetSafeText(value ?? "");

function moneyColumn(label: string, width = 14): TableColumn {
  return { label, numFmt: MONEY, right: true, width };
}

function finish(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

function newWorkbook(generatedAtIso: string): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  workbook.creator = "Phoenix Workforce";
  return workbook;
}

/** The invoice as the insurer stated it, every person, and how it stood against the plan. */
export async function buildMedicalInsuranceInvoiceWorkbook(input: {
  comparison: InvoiceComparison;
  comparedAt: string;
  exportedByName: string;
  generatedAtIso: string;
  parsed: ParsedInvoice;
  policy: MedicalInsurancePolicyView;
}): Promise<ArrayBuffer> {
  const { comparison, parsed, policy } = input;
  const workbook = newWorkbook(input.generatedAtIso);

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Confidential. This workbook names employees and their dates of birth.",
    rows: [
      ["Insurer", policy.insurer],
      ["Policy", policy.policyNumber],
      ["Bill number", parsed.billNumber],
      ["Issued", day(parsed.issuedOn)],
      ["Period covered", `${day(parsed.periodStart)} to ${day(parsed.periodEnd)}`],
      ["Total due", parsed.totalDue.toLocaleString("en-US", { minimumFractionDigits: 2 })],
      ["Planned", comparison.plannedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })],
      ["Difference", comparison.difference.toLocaleString("en-US", { minimumFractionDigits: 2 })],
      ["Compared", day(input.comparedAt.slice(0, 10))],
      ["Exported by", input.exportedByName],
      houseGeneratedRow(input.generatedAtIso),
    ],
    sheetName: "Cover",
    subtitle: `${policy.insurer} policy ${policy.policyNumber}, bill ${parsed.billNumber}`,
    title: "Medical insurance invoice",
  });

  const statement = workbook.addWorksheet("Invoice");
  statement.views = [{ showGridLines: false }];
  const productTotals = parsed.products.map((entry): CellValue[] => [
    entry.label,
    entry.premium,
    entry.adjustments,
    entry.issueFee + entry.nominalStamp,
    entry.fees,
    entry.stamp,
    entry.productTotal,
    entry.outstanding,
    entry.totalDue,
  ]);
  let row = writeHouseTable(statement, 1, {
    columns: [
      { label: "Cover", width: 38 },
      moneyColumn("Premium"),
      moneyColumn("Adjustments"),
      moneyColumn("Issue fee and stamp"),
      moneyColumn("Supervisory and service fees"),
      moneyColumn("Proportional stamp duty"),
      moneyColumn("Product total"),
      moneyColumn("Outstanding"),
      moneyColumn("Total due"),
    ],
    rows: productTotals,
    title: "Premium statement",
    totals: [
      "Total",
      parsed.premiumTotal,
      null,
      null,
      null,
      null,
      null,
      null,
      parsed.totalDue,
    ],
  });
  row += 1;
  writeHouseTable(statement, row, {
    columns: [{ label: "Cover", width: 38 }, { label: "Plan" }, { label: "Type" }, { label: "People billed", right: true }, moneyColumn("Premium")],
    rows: parsed.products.flatMap((entry) => entry.rows.map((item): CellValue[] => [entry.label, item.plan, item.coverType, item.billed, item.premium])),
    title: "Billed by plan",
  });

  const members = workbook.addWorksheet("Members");
  members.views = [{ showGridLines: false }, { state: "frozen", ySplit: 2 }];
  const memberRows = parsed.members.map((member): CellValue[] => {
    const billed = billedByProduct(member);
    return [
      member.certificate,
      text(member.name),
      day(member.birthDate),
      ...MEDICAL_INSURANCE_PRODUCTS.map((product) => billed[product]),
      member.statedTotal,
    ];
  });
  writeHouseTable(members, 1, {
    columns: [
      { label: "Certificate", width: 12 },
      { label: "Name on the invoice", width: 30 },
      { label: "Date of birth", width: 13 },
      ...MEDICAL_INSURANCE_PRODUCTS.map((product) => moneyColumn(MEDICAL_INSURANCE_PRODUCT_LABELS[product])),
      moneyColumn("Member total"),
    ],
    rows: memberRows,
    title: `${parsed.members.length} certificates`,
    totals: ["Total", null, null, ...MEDICAL_INSURANCE_PRODUCTS.map((product) => parsed.products.find((entry) => entry.code === product)?.premium ?? 0), parsed.premiumTotal],
  });

  const against = workbook.addWorksheet("Against the plan");
  against.views = [{ showGridLines: false }];
  let next = writeHouseTable(against, 1, {
    columns: [
      { label: "Cover", width: 26 },
      { label: "People planned", right: true },
      { label: "People billed", right: true },
      moneyColumn("Planned premium"),
      moneyColumn("Billed premium"),
      moneyColumn("Planned with fees"),
      moneyColumn("Billed with fees"),
      moneyColumn("Difference"),
    ],
    rows: comparison.products.map((entry): CellValue[] => [
      entry.label,
      entry.plannedPeople,
      entry.billedPeople,
      entry.plannedPremium,
      entry.billedPremium,
      entry.plannedTotal,
      entry.billedTotal,
      entry.difference,
    ]),
    title: "By cover",
    totals: ["Total", null, null, comparison.plannedPremium, comparison.billedPremium, comparison.plannedTotal, comparison.billedTotal, comparison.difference],
  });
  next += 1;
  writeHouseTable(against, next, {
    columns: [
      { label: "Certificate", width: 26 },
      { label: "Name", width: 30 },
      { label: "Category" },
      moneyColumn("Planned"),
      moneyColumn("Billed"),
      moneyColumn("Difference"),
      { label: "Result", width: 24 },
      { label: "Why", width: 52 },
    ],
    note: "Premium per person, before fees. A family is one row, as the insurer bills it.",
    rows: comparison.rows.map((entry): CellValue[] => [
      entry.certificate ?? "None yet",
      text(entry.name),
      entry.category,
      entry.plannedTotal,
      entry.billedTotal,
      entry.difference,
      COMPARISON_STATUS_WORDS[entry.status],
      text(entry.note),
    ]),
    title: "Person by person",
  });

  return finish(workbook);
}

/** The register, with no amount on it: the HR seats hold this export. */
export async function buildMedicalInsuranceRegisterWorkbook(input: {
  exportedByName: string;
  generatedAtIso: string;
  members: readonly MedicalInsuranceMemberRow[];
  policy: MedicalInsurancePolicyView;
}): Promise<ArrayBuffer> {
  const workbook = newWorkbook(input.generatedAtIso);
  const open = input.members.filter((member) => member.open).length;
  buildHouseCoverSheet(workbook, {
    confidentialNote: "Confidential. This workbook names employees and their family members.",
    rows: [
      ["Insurer", input.policy.insurer],
      ["Policy", input.policy.policyNumber],
      ["Covered today", String(open)],
      ["Ended", String(input.members.length - open)],
      ["Exported by", input.exportedByName],
      houseGeneratedRow(input.generatedAtIso),
    ],
    subtitle: `${input.policy.insurer} policy ${input.policy.policyNumber}`,
    title: "Medical insurance register",
  });

  const sheet = workbook.addWorksheet("Register");
  sheet.views = [{ showGridLines: false }];
  writeHouseTable(sheet, 1, {
    columns: [
      { label: "Certificate", width: 12 },
      { label: "Name", width: 32 },
      { label: "Type", width: 10 },
      { label: "Under", width: 30 },
      { label: "Job", width: 28 },
      { label: "Category", width: 10 },
      { label: "Cover from", width: 12 },
      { label: "Cover to", width: 12 },
      { label: "Why it ended", width: 36 },
      { label: "Notes", width: 36 },
    ],
    rows: input.members.map((member): CellValue[] => [
      member.certificateNumber ?? "None yet",
      text(member.name),
      MEMBER_TYPE_WORDS[member.memberType],
      text(member.principalName),
      text(member.jobTitle),
      member.category,
      day(member.coverageStart),
      day(member.coverageEnd),
      text(member.endReason),
      text(member.notes),
    ]),
    title: `${input.members.length} people`,
  });
  return finish(workbook);
}

function splitName(name: string): [string, string, string] {
  const parts = name.trim().split(/\s+/);
  return [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join(" ")];
}

function dayParts(value: string | null | undefined): [number | null, number | null, number | null] {
  if (!value) return [null, null, null];
  const [year, month, date] = value.slice(0, 10).split("-").map(Number);
  return [date || null, month || null, year || null];
}

function sexLetter(gender: string | null | undefined): string {
  const value = String(gender ?? "").trim().toLowerCase();
  if (value.startsWith("m")) return "M";
  if (value.startsWith("f")) return "F";
  return "";
}

function writeFormHeading(sheet: ExcelJS.Worksheet, title: string, policy: MedicalInsurancePolicyView) {
  sheet.getCell(1, 3).value = title;
  sheet.getCell(1, 3).font = { bold: true, size: 14 };
  sheet.getCell(3, 1).value = "COMPANY NAME :";
  sheet.getCell(3, 3).value = "Sato Pharma";
  sheet.getCell(4, 1).value = "POLICY NO. :";
  sheet.getCell(4, 3).value = policy.policyNumber;
}

/**
 * The insurer's additions and deletions form, filled from today's list. It goes to the insurer by a
 * person's hand: nothing here sends it, and the register does not change until someone records the change.
 * Marital status and salary stay blank: Phoenix holds no marital status, and the sum insured is flat.
 */
export async function buildMedicalInsuranceMovementWorkbook(input: {
  actions: readonly MedicalInsuranceAction[];
  employees: readonly EmployeeDirectoryRow[];
  generatedAtIso: string;
  members: readonly MedicalInsuranceMemberRow[];
  policy: MedicalInsurancePolicyView;
}): Promise<{ buffer: ArrayBuffer; additions: number; deletions: number }> {
  const workbook = newWorkbook(input.generatedAtIso);
  const employees = new Map(input.employees.map((employee) => [employee.hrId, employee]));

  const additions = workbook.addWorksheet("Additions");
  writeFormHeading(additions, "A D D I T I O N S  L I S T", input.policy);
  const addHeaders = [
    "Dep. Type (M/S/C)", "Cert No. / Emp No.", "First Name", "Second Name", "Third Name", "ID number", "Hiring Date", "", "Categories",
    "DOB Day", "DOB Month", "DOB Year", "Sex (M/F)", "Marital Status (M/S)", "Basic Salary (Monthly)", "Curr.",
    "Effective Day", "Effective Month", "Effective Year", "Type of card (PDF/ E-Card)", "Nationality", "Mobile number", "E-mail",
  ];
  addHeaders.forEach((header, index) => {
    const cell = additions.getCell(8, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    cell.alignment = { vertical: "middle", wrapText: true };
    additions.getColumn(index + 1).width = header.length > 12 ? 18 : 12;
  });

  const adds = input.actions.filter((action) => action.kind === "add");
  adds.forEach((action, index) => {
    const employee = action.hrId ? employees.get(action.hrId) : undefined;
    const [first, second, third] = splitName(employee?.fullName ?? action.name);
    const birth = dayParts(employee?.birthDate);
    const effective = dayParts(action.effectiveOn);
    const values: Array<string | number | null> = [
      "M",
      action.hrId,
      text(first),
      text(second),
      text(third),
      text(employee?.nationalId),
      day(employee?.hireDate),
      null,
      action.category ?? action.suggestedCategory,
      ...birth,
      sexLetter(employee?.gender),
      null,
      null,
      "EGP",
      ...effective,
      "E-Card",
      null,
      text(employee?.mobileNumber),
      text(employee?.workEmail),
    ];
    values.forEach((value, column) => {
      if (value !== null && value !== "") additions.getCell(9 + index, column + 1).value = value;
    });
  });

  const deletions = workbook.addWorksheet("Deletions");
  writeFormHeading(deletions, "D E L E T I O N S  L I S T", input.policy);
  ["Dep. Type (M/S/C)", "Cert No. / Emp No.", "Insured Name", "Day", "Month", "Year"].forEach((header, index) => {
    const cell = deletions.getCell(6, index + 1);
    cell.value = header;
    cell.font = { bold: true };
    deletions.getColumn(index + 1).width = index === 2 ? 36 : 14;
  });

  // A leaver's spouse and children go with them, each on a line of their own as the form asks. Family
  // already listed in their own right is not listed twice.
  const typeLetter = { child: "C", employee: "M", spouse: "S" } as const;
  const listed = new Set(input.actions.map((action) => action.memberId));
  const lines = input.actions
    .filter((action) => action.kind === "remove")
    .flatMap((action) => [
      { certificate: action.certificateNumber, day: action.effectiveOn, name: action.name, type: typeLetter[action.memberType] },
      ...input.members
        .filter((member) => member.principalMemberId === action.memberId && member.open && !listed.has(member.id))
        .map((member) => ({ certificate: member.certificateNumber, day: action.effectiveOn, name: member.name, type: typeLetter[member.memberType] })),
    ]);
  lines.forEach((line, index) => {
    const values: Array<string | number | null> = [line.type, line.certificate, text(line.name), ...dayParts(line.day)];
    values.forEach((value, column) => {
      if (value !== null && value !== "") deletions.getCell(7 + index, column + 1).value = value;
    });
  });

  return { additions: adds.length, buffer: await finish(workbook), deletions: lines.length };
}

export function medicalInsuranceFileDay(generatedAtIso: string): string {
  const at = new Date(generatedAtIso);
  return Number.isNaN(at.getTime()) ? "export" : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
}
