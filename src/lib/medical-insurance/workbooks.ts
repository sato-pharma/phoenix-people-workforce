// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module's three workbooks.
//
// The invoice and the register wear the house identity. The EDI form does NOT: it is the insurer's own
// workbook, sent to the insurer, and their system reads it by column. It is filled into a blank copy of
// their file, so its layout stays theirs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { spreadsheetSafeText } from "@/lib/export/spreadsheet-safe";

import { COMPARISON_STATUS_WORDS, type InvoiceComparison } from "./compare";
import { MEDICAL_INSURANCE_PRODUCT_LABELS, MEDICAL_INSURANCE_PRODUCTS } from "./cost";
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

// ── The insurer's EDI form ─────────────────────────────────────────────────────────────────────
//
// Filled into a blank copy of the insurer's own workbook (assets/medical-insurance), so every sheet,
// heading, merge, width and colour is theirs and none of it is redrawn here. The copy was made from the
// file Sato sent the insurer with every person taken out; it holds no name, ID, phone or email.

export const METLIFE_EDI_TEMPLATE_PATH = join("assets", "medical-insurance", "metlife-edi-template.xlsx");

export type MetLifeEdiKind = "additions" | "deletions";

export type MetLifeEdiAddition = {
  /** Phoenix's number for the employee. The column is "Cert No. / Emp No.", and a joiner has no certificate yet. */
  hrId: string | null;
  fullName: string;
  nationalId: string | null;
  hireDate: string | null;
  category: string;
  birthDate: string | null;
  gender: string | null;
  coverageStartsOn: string;
  mobileNumber: string | null;
  email: string | null;
};

export type MetLifeEdiDeletion = {
  memberType: "employee" | "spouse" | "child";
  certificateNumber: string | null;
  name: string;
  coverageEndsOn: string;
};

// Where their rows start, and where the Deletions sheet's own notes begin below the rows.
const ADDITIONS_FIRST_ROW = 11;
const DELETIONS_FIRST_ROW = 8;
const DELETIONS_NOTES_ROW = 18;
const TYPE_LETTER = { child: "C", employee: "M", spouse: "S" } as const;

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

/** Their certificate column holds numbers as numbers and a family line as "80-1". */
function certificateCell(value: string | null): string | number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * Day, month, year and sex as the insurer's own sheet works them out: formulas on the national ID in
 * column F, carrying the answer as well so a reader that does not calculate still sees it. Without a
 * usable ID they are plain values from the employee record.
 */
function birthCells(row: number, nationalId: string | null, birthDate: string | null, gender: string | null): ExcelJS.CellValue[] {
  const id = String(nationalId ?? "").trim();
  const [day, month, year] = dayParts(birthDate);
  if (!/^[23]\d{13}$/.test(id)) return [day, month, year, sexLetter(gender) || null];
  const fromId = {
    day: Number(id.slice(5, 7)),
    month: Number(id.slice(3, 5)),
    sex: Number(id[12]) % 2 === 1 ? "M" : "F",
    year: (id[0] === "2" ? 1900 : 2000) + Number(id.slice(1, 3)),
  };
  return [
    { formula: `IFERROR(VALUE(MID(F${row},6,2)),"")`, result: fromId.day },
    { formula: `IFERROR(VALUE(MID(F${row},4,2)),"")`, result: fromId.month },
    { formula: `IFERROR(IF(LEFT(F${row},1)="2",1900,2000)+VALUE(MID(F${row},2,2)),"")`, result: fromId.year },
    { formula: `IF(F${row}="","",IFERROR(IF(MOD(VALUE(MID(F${row},13,1)),2)=1,"M","F"),""))`, result: fromId.sex },
  ];
}

/** Gives a new row the look of the template's first data row, for a list longer than the template's. */
function styleLike(sheet: ExcelJS.Worksheet, row: number, model: number, lastColumn: number) {
  for (let column = 1; column <= lastColumn; column++) {
    sheet.getCell(row, column).style = { ...sheet.getCell(model, column).style };
  }
  sheet.getRow(row).height = sheet.getRow(model).height;
}

/**
 * ExcelJS writes its own Normal style (Calibri 11) over the workbook's, so every blank cell of the insurer's
 * sheets would change font. This adds the insurer's Normal font, Arial 10, and points the Normal style and
 * the default cell format at it. Cells with a font of their own keep it.
 */
async function restoreInsurersNormalFont(file: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(file);
  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) return file;
  let styles = await stylesFile.async("string");
  const fonts = /<fonts count="(\d+)">/.exec(styles);
  if (!fonts) return file;
  const arialId = Number(fonts[1]);
  styles = styles
    .replace(fonts[0], `<fonts count="${arialId + 1}">`)
    .replace("</fonts>", '<font><sz val="10"/><name val="Arial"/><family val="2"/></font></fonts>')
    .replace(/(<cellStyleXfs[^>]*>\s*<xf [^>]*?)fontId="0"/, `$1fontId="${arialId}"`)
    .replace(/(<cellXfs[^>]*>\s*<xf [^>]*?)fontId="0"/, `$1fontId="${arialId}"`);
  zip.file("xl/styles.xml", styles);
  return zip.generateAsync({ compression: "DEFLATE", type: "arraybuffer" });
}

async function loadTemplate(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await readFile(join(process.cwd(), METLIFE_EDI_TEMPLATE_PATH))) as unknown as ArrayBuffer);
  return workbook;
}

/**
 * The insurer's EDI workbook with the chosen people on it: additions on the Additions sheet, deletions on
 * the Deletions sheet, every other sheet left as the insurer gave it. It goes to the insurer by a person's
 * hand: nothing here sends it, and the register does not change until someone records the change.
 * Marital status, salary and currency stay blank, as they were on the file Sato first sent.
 */
export async function buildMetLifeEdiWorkbook(
  input: { kind: "additions"; rows: readonly MetLifeEdiAddition[] } | { kind: "deletions"; rows: readonly MetLifeEdiDeletion[] },
): Promise<ArrayBuffer> {
  const workbook = await loadTemplate();

  if (input.kind === "additions") {
    const sheet = workbook.getWorksheet("Additions");
    if (!sheet) throw new Error("The insurer's template has no Additions sheet.");
    const lastStyled = sheet.rowCount;
    input.rows.forEach((person, index) => {
      const row = ADDITIONS_FIRST_ROW + index;
      if (row > lastStyled) styleLike(sheet, row, ADDITIONS_FIRST_ROW, 23);
      const [first, second, third] = splitName(person.fullName);
      const values: ExcelJS.CellValue[] = [
        "M",
        text(person.hrId),
        text(first),
        text(second),
        text(third),
        text(person.nationalId),
        person.hireDate ? person.hireDate.slice(0, 10) : null,
        null,
        person.category,
        ...birthCells(row, person.nationalId, person.birthDate, person.gender),
        null,
        null,
        null,
        ...dayParts(person.coverageStartsOn),
        "E-card",
        "Egyptian",
        text(person.mobileNumber),
        text(person.email),
      ];
      values.forEach((value, column) => {
        if (value !== null && value !== "") sheet.getCell(row, column + 1).value = value;
      });
    });
  } else {
    const sheet = workbook.getWorksheet("Deletions");
    if (!sheet) throw new Error("The insurer's template has no Deletions sheet.");
    // The template has room for ten lines above its notes. A longer list pushes the notes down.
    const room = DELETIONS_NOTES_ROW - DELETIONS_FIRST_ROW;
    const extra = input.rows.length - room;
    if (extra > 0) {
      sheet.spliceRows(DELETIONS_NOTES_ROW, 0, ...Array.from({ length: extra }, () => []));
      for (let index = 0; index < extra; index++) styleLike(sheet, DELETIONS_NOTES_ROW + index, DELETIONS_FIRST_ROW, 6);
    }
    input.rows.forEach((line, index) => {
      const row = DELETIONS_FIRST_ROW + index;
      const values: ExcelJS.CellValue[] = [TYPE_LETTER[line.memberType], certificateCell(line.certificateNumber), text(line.name), ...dayParts(line.coverageEndsOn)];
      values.forEach((value, column) => {
        if (value !== null && value !== "") sheet.getCell(row, column + 1).value = value;
      });
    });
  }

  return restoreInsurersNormalFont(await finish(workbook));
}

export function medicalInsuranceFileDay(generatedAtIso: string): string {
  const at = new Date(generatedAtIso);
  return Number.isNaN(at.getTime()) ? "export" : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
}
