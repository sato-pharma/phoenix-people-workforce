/**
 * The owner's question sheet for the HR forms module — every outstanding answer in one workbook.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule: business-fact questions are asked as
 * an XLSX with dropdowns, one row per item, with the context that makes the call easy and a free
 * text Note column. Answering 25 translations in prose is a chore; answering them in a column with
 * the proposal already filled in is a few minutes.
 *
 * IT ASKS ONLY WHAT IS STILL OUTSTANDING. A registration number already set in
 * `system-settings.ts` and a seed already `confirmed` are both left out, and a sheet with nothing
 * left on it is not written at all. That is what makes this re-runnable: add a job title next month,
 * run this, and the owner gets a one-row workbook instead of the 25 he has already answered. Handing
 * somebody a form that re-asks answered questions is how the answers stop coming back.
 *
 * WHAT IT ASKS, in the order the answers unblock work:
 *   1. The company registration numbers that are still blank. They are not per-person values — one
 *      of them missing blocks EVERY Form 1 in the company at once.
 *   2. The Arabic job titles that nobody has confirmed.
 *   3. The Arabic qualifications that nobody has confirmed.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         --experimental-loader ./tests/alias-loader.mjs scripts/hr-forms-arabic-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately. ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" a workbook, and both are triggered by things this sheet does not
 * do: `outlineProperties` together with `pageSetup.fitToPage`, and `ws.addImage`. Avoiding the two
 * triggers is what keeps the output openable without post-processing the zip — so do not add a logo
 * or a collapsed column group here without reading that trap first.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

import { unconfirmedSeeds } from "../src/lib/hiring-pack/arabic-lookups.ts";
import { systemLegalEntity } from "../src/config/system-settings.ts";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FFF97316";

/** Accept the proposal, or write your own in the next column. Two options, because there are two. */
const DECISION_OPTIONS = '"Accept,Change"';

/**
 * The sheet-level validation collection, which ExcelJS ships but does not declare.
 *
 * `Worksheet.dataValidations` is live at runtime — it is the collection `cell.dataValidation`
 * writes into — but `exceljs/index.d.ts` has the field commented out, so reaching it needs a cast.
 * The typed alternative, assigning `cell.dataValidation` row by row, is what produces the
 * overlapping `sqref` ranges described where this is used, so the cast is the narrower evil.
 */
type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = sheet.getRow(rowNumber);
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  row.height = 28;
}

function addTitle(sheet: ExcelJS.Worksheet, columns: number, title: string, subtitle: string): void {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_FILL } };
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell("A2");
  subtitleCell.value = subtitle;
  subtitleCell.font = { size: 10, color: { argb: "FF475569" } };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  sheet.getRow(2).height = 34;
}

function buildInstructions(
  workbook: ExcelJS.Workbook,
  outstanding: { companyNumbers: number; jobTitles: number; qualifications: number },
): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 26 }, { width: 104 }];

  addTitle(
    sheet,
    2,
    "HR Forms — the answers only you can give",
    "Only what is still outstanding is in here — anything you have already answered is gone. Every "
      + "row is filled in with a proposal; you are confirming or correcting, not writing from "
      + "scratch. Nothing in the system changes until these come back.",
  );

  const rows: [string, string][] = [
    ["Why you were asked", "The contract and Form 1 refuse to print without these values. They are not typed per person — each answer is reused for everybody with the same job title or qualification, and a company number is used on every Form 1 the company will ever file."],
  ];

  if (outstanding.companyNumbers > 0) {
    rows.push([
      "Company numbers",
      `${outstanding.companyNumbers === 1 ? "One value" : `${outstanding.companyNumbers} values`} taken from the company's registration papers. Blank today, and a single one missing blocks Form 1 for everybody. Please copy it exactly as printed on the certificate rather than from memory — it is filed with the Social Insurance Authority.`,
    ]);
  }
  if (outstanding.jobTitles > 0) {
    rows.push([
      "Job titles",
      `${outstanding.jobTitles} ${outstanding.jobTitles === 1 ? "row" : "rows"}. The Arabic column is a proposal. Set Decision to Accept if it is right, or to Change and write the correct wording in 'Your wording'.`,
    ]);
  }
  if (outstanding.qualifications > 0) {
    rows.push([
      "Qualifications",
      `${outstanding.qualifications} ${outstanding.qualifications === 1 ? "row" : "rows"}. The data spells some of these several ways (Vet, vet, Veterinary); they are already merged, so you answer each qualification once.`,
    ]);
  }

  rows.push(
    ["What happens next", "Nothing prints from these until they come back confirmed. Every proposal is inert in the system today — the forms behave exactly as they did before, and an unconfirmed wording can never reach a signed document."],
    ["If you are unsure", "Leave Decision blank and write what you need in the Note column. A blank row is treated as unanswered and asked again — it is never guessed."],
  );

  let rowNumber = 4;
  for (const [label, text] of rows) {
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
    row.getCell(2).value = text;
    row.getCell(2).alignment = { vertical: "top", wrapText: true };
    row.height = 46;
    rowNumber += 1;
  }
}

/**
 * The registration numbers still blank in `system-settings.ts`.
 *
 * Read from the settings rather than listed here, so a value the owner has already supplied is never
 * asked for again — and so this file cannot quietly disagree with what the forms actually read.
 */
function outstandingCompanyNumbers(): [string, string, string][] {
  const { registration } = systemLegalEntity;
  const all: [string, string, string, string][] = [
    [
      registration.insuranceSectorCode,
      "Insurance sector code",
      "قطاع المنشأة",
      "On the establishment's social insurance registration — the sector the company is registered under. Form 1 asks for it directly.",
    ],
    [
      registration.taxRegistrationNumber,
      "Tax registration number",
      "رقم التسجيل الضريبي",
      "The company's tax registration number, as printed on the tax card. Used on Form 1 and Form 6.",
    ],
  ];

  return all
    .filter(([value]) => !String(value ?? "").trim())
    .map(([, label, arabic, where]) => [label, arabic, where]);
}

/** The registration numbers that ARE set, with what is stored, so the sheet can show them back. */
function settledCompanyNumbers(): [string, string, string][] {
  const { registration } = systemLegalEntity;
  const all: [string, string, string][] = [
    ["Establishment number", "رقم المنشأة", registration.insuranceEstablishmentNumber],
    ["Insurance sector code", "قطاع المنشأة", registration.insuranceSectorCode],
    ["Tax registration number", "رقم التسجيل الضريبي", registration.taxRegistrationNumber],
  ];

  return all.filter(([, , value]) => String(value ?? "").trim().length > 0);
}

function buildCompanyNumbers(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("1. Company numbers", {
    properties: { tabColor: { argb: "FFDC2626" } },
  });
  sheet.columns = [{ width: 34 }, { width: 26 }, { width: 30 }, { width: 46 }];

  const questions = outstandingCompanyNumbers();
  const onFile = settledCompanyNumbers();

  addTitle(
    sheet,
    4,
    "1. Company registration numbers — blocks every Form 1",
    `${questions.length === 1 ? "One value is" : `${questions.length} values are`} still blank in the `
      + `system. Until ${questions.length === 1 ? "it is" : "they are"} filled, no Form 1 can be printed `
      + `for anybody. Please copy ${questions.length === 1 ? "it" : "them"} from the registration papers, `
      + "not from memory.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = ["What is needed", "Arabic on the form", "Your value", "Where to find it"];
  styleHeader(sheet, headerRow);

  questions.forEach(([label, arabic, where], index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = arabic;
    row.getCell(2).alignment = { horizontal: "right" };
    row.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    row.getCell(3).border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
    row.getCell(4).value = where;
    row.getCell(4).alignment = { vertical: "top", wrapText: true };
    row.height = 44;
  });

  // Every number that is ALREADY on file, listed under the questions. Two reasons, and the second is
  // the one that was missing: the sheet must not look like it is asking for all of them, and a value
  // the owner has just answered has to be visibly received. A number that silently disappears from
  // the sheet reads as an answer that was lost.
  onFile.forEach(([label, arabic, stored], index) => {
    const note = sheet.getRow(headerRow + 1 + questions.length + index);
    note.getCell(1).value = `${label} — already on file, no action`;
    note.getCell(1).font = { italic: true, color: { argb: "FF475569" } };
    note.getCell(2).value = arabic;
    note.getCell(2).alignment = { horizontal: "right" };
    note.getCell(3).value = stored;
    note.getCell(3).font = { italic: true, color: { argb: "FF475569" } };
    note.getCell(4).value = "Stored and printing correctly. Listed only so it is clear it was not forgotten — tell me if it is wrong.";
    note.getCell(4).alignment = { vertical: "top", wrapText: true };
    note.height = 32;
  });
}

function buildLookupSheet(
  workbook: ExcelJS.Workbook,
  options: {
    name: string;
    title: string;
    subtitle: string;
    valueHeader: string;
    seeds: readonly { en: string; ar: string; confirmed: boolean; people: number }[];
  },
): void {
  const sheet = workbook.addWorksheet(options.name, {
    properties: { tabColor: { argb: "FF2563EB" } },
  });
  sheet.columns = [{ width: 34 }, { width: 10 }, { width: 32 }, { width: 14 }, { width: 32 }, { width: 34 }];

  addTitle(sheet, 6, options.title, options.subtitle);

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    options.valueHeader,
    "People",
    "Proposed Arabic",
    "Decision",
    "Your wording (if changing)",
    "Note",
  ];
  styleHeader(sheet, headerRow);

  options.seeds.forEach((seed, index) => {
    const rowNumber = headerRow + 1 + index;
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = seed.en;
    row.getCell(2).value = seed.people;
    row.getCell(2).alignment = { horizontal: "center" };
    row.getCell(3).value = seed.ar;
    row.getCell(3).alignment = { horizontal: "right" };

    row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };

    for (const column of [4, 5, 6]) {
      row.getCell(column).border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    }
    row.getCell(5).alignment = { horizontal: "right" };
  });

  // The locked list the owner's rule asks for, applied to the column ONCE. Two options only —
  // anything more is a false choice. Setting `cell.dataValidation` per row instead makes ExcelJS
  // coalesce the rows into several OVERLAPPING sqref ranges, which puts two validations on the same
  // cell and is its own "we found a problem with some content" repair on open.
  const lastRow = headerRow + options.seeds.length;
  (sheet as SheetWithValidations).dataValidations.add(`D${headerRow + 1}:D${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [DECISION_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Accept or Change",
    error: "Choose Accept to keep the proposed Arabic, or Change and write your wording in the next column.",
  });

  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: lastRow, column: 6 },
  };
}

/**
 * A path nothing is standing on.
 *
 * IT NEVER OVERWRITES, and that is not tidiness. The workbook goes out, the owner fills it in, and
 * it comes back at the same path — so a second run on the same day would destroy the answers with
 * no warning and no copy. It happened once, on 2026-09-03, and the answers survived only because
 * they had already been read into the code. A suffix costs nothing; `xlsx/` is also where the repo
 * rule says a stray workbook must be kept rather than removed.
 */
function nextFreePath(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = resolve(process.cwd(), "xlsx", `hr-forms-questions-${stamp}`);
  if (!existsSync(`${base}.xlsx`)) return `${base}.xlsx`;

  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many question workbooks written today — clear xlsx/ before running again.");
}

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — HR Forms";
  workbook.created = new Date();

  const outstanding = unconfirmedSeeds();
  const companyQuestions = outstandingCompanyNumbers();
  const total = companyQuestions.length + outstanding.jobTitles.length + outstanding.qualifications.length;

  if (total === 0) {
    console.log("Nothing outstanding — every company number is set and every Arabic wording is confirmed.");
    console.log("No workbook written; there is nothing to ask.");
    return;
  }

  buildInstructions(workbook, {
    companyNumbers: companyQuestions.length,
    jobTitles: outstanding.jobTitles.length,
    qualifications: outstanding.qualifications.length,
  });
  if (companyQuestions.length > 0) buildCompanyNumbers(workbook);

  if (outstanding.jobTitles.length > 0) buildLookupSheet(workbook, {
    name: "2. Job titles",
    title: "2. Arabic job titles — المسمى الوظيفي",
    subtitle:
      "The contract and both Ministry of Labour forms print the job title in Arabic. 20 titles cover "
      + "every active employee, so each answer is reused for everyone who holds that title, now and later.",
    valueHeader: "Job title (as the system holds it)",
    seeds: outstanding.jobTitles,
  });

  if (outstanding.qualifications.length > 0) buildLookupSheet(workbook, {
    name: "3. Qualifications",
    title: "3. Arabic qualifications — المؤهل",
    subtitle:
      "The contract prints the qualification in Arabic. The data spells some of these several ways; "
      + "they are already merged here, so each qualification is asked once.",
    valueHeader: "Qualification (as the system holds it)",
    seeds: outstanding.qualifications,
  });

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  console.log(`Wrote ${outputPath}`);
  console.log(
    `${total} outstanding: ${companyQuestions.length} company numbers, `
      + `${outstanding.jobTitles.length} job titles, ${outstanding.qualifications.length} qualifications.`,
  );
}

await main();
