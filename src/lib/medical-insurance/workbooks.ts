// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module's two workbooks.
//
// The register wears the house identity. The member file does NOT: it is Libano-Suisse's own "Output draft"
// sheet, sent to the insurer, and their system reads it by column. Its 39 headings are copied word for word
// from the draft Sato prepared with them (Initial Draft1.xlsx), data from row 2, so the layout stays theirs.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { spreadsheetSafeText } from "@/lib/export/spreadsheet-safe";

import type { MedicalInsuranceCategory, MedicalInsuranceMemberType } from "./cost";
import { MEMBER_TYPE_WORDS, policyNumberWords, type MedicalInsuranceMemberRow, type MedicalInsurancePolicyView } from "./view";

function day(value: string | null | undefined): string {
  if (!value) return "";
  const [year, month, date] = value.slice(0, 10).split("-");
  return `${date}/${month}/${year}`;
}

const text = (value: string | null | undefined): string => spreadsheetSafeText(value ?? "");

function finish(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

function newWorkbook(generatedAtIso: string): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  workbook.creator = "Phoenix Workforce";
  return workbook;
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
  const policyWords = policyNumberWords(input.policy);
  buildHouseCoverSheet(workbook, {
    confidentialNote: "Confidential. This workbook names employees and their family members, with dates of birth.",
    rows: [
      ["Insurer", input.policy.insurer],
      ["Policy", policyWords],
      ["Policy year", `${day(input.policy.startsOn)} to ${day(input.policy.endsOn)}`],
      ["Covered today", String(open)],
      ["Ended", String(input.members.length - open)],
      ["Exported by", input.exportedByName],
      houseGeneratedRow(input.generatedAtIso),
    ],
    subtitle: `${input.policy.insurer}, ${policyWords}`,
    title: "Medical insurance register",
  });

  const sheet = workbook.addWorksheet("Register");
  sheet.views = [{ showGridLines: false }];
  writeHouseTable(sheet, 1, {
    columns: [
      { label: "Member number", width: 14 },
      { label: "Staff number", width: 12 },
      { label: "Name", width: 32 },
      { label: "Type", width: 10 },
      { label: "Under", width: 30 },
      { label: "Job", width: 28 },
      { label: "Plan", width: 8 },
      { label: "Date of birth", width: 13 },
      { label: "Cover from", width: 12 },
      { label: "Cover to", width: 12 },
      { label: "Why it ended", width: 36 },
      { label: "Notes", width: 36 },
    ],
    rows: input.members.map((member): CellValue[] => [
      member.certificateNumber ?? "None yet",
      text(member.staffNumber),
      text(member.name),
      MEMBER_TYPE_WORDS[member.memberType],
      text(member.principalName),
      text(member.jobTitle),
      member.category,
      day(member.birthDate),
      day(member.coverageStart),
      day(member.coverageEnd),
      text(member.endReason),
      text(member.notes),
    ]),
    title: `${input.members.length} people`,
  });
  return finish(workbook);
}

// ── Libano-Suisse's member file ───────────────────────────────────────────────────────────────

/** The insurer's headings, exactly as their draft carries them, spaces and spelling included. */
export const LIBANO_MEMBER_FILE_HEADERS: readonly string[] = [
  '1-  "Plan Code"\nmandatory field in case there is multiple  plans per group.',
  '2- "Last name " \nmandatory field .Maximum length 20 characters.',
  '  3- "Father Init"\nmandatory, Maximum length 1 character.',
  '4- "First name" \nmandatory field .Maximum length 20 characters.',
  '5- "Father name"\n not mandatory field. Maximum length 30 characters. ',
  '6- "Family Number"\n Mandatory field, values from 1 to 999.',
  '7- "DOB"\n mandatory field ,date of birth and must have the date format as "ddmmyyyy"(character)',
  '8- "Relation"\nmandatory field .Value P(principale),S(spouse),C(child),R(parents).',
  '9- "Underwriting flag"\n not mandatory field, maximum lenght 100 characters ',
  '10- "Gender"\nmandatory field ,the values are M or F',
  '11- "Class"\nmandatory field.',
  '12- "Co-ins"\n not mandatory fields, the values are YES,NO.',
  '13- "Nationality"\nnot mandatory field ,(check excel file) for values.',
  '14- "iqama or naty id"\nnot mandatory field .',
  '15- "iqama expiry date"\nand must have the date format as "ddmmyyyy"(character)',
  '16- "iqama or naty_id type"\n not mandatory field with value YES/NO , the default is NO.',
  '17- "City"\n not mandatory field.',
  '18- "Marital Status"\nnot mandatory field ,(check excel file) for values.',
  '19- "Reference2", not mandatory field.',
  '20- "Occupation",not mandatory field ,(check excel file) for values.',
  '21- "Sponsor ",not mandatory field.',
  '22- "Staff #",not mandatory field.',
  '23- "Adherent #",not mandatory field.',
  '24- "Arabic first name",not mandatory field.',
  '25- "Arabic father initial",not mandatory field.',
  '26- "Arabic last name " ,not mandatory field.',
  '27- "Principal #",not mandatory field.',
  '28- "Phone #",not mandatory field.',
  '29- "Has PM",  not mandatory field with value YES/No , the default is YES.',
  '30- "Has AMB",  not mandatory field with value YES/No , the default is YES.',
  '31- "Has DV",  not mandatory field with value YES/No , the default is YES.',
  '32- "Has Dental", not mandatory field with value YES/No , the default is YES.',
  '33- "Has Optical", not mandatory field with value YES/No , the default is YES.',
  "34-Payment To (C= Company / B= Benefiary )",
  "35-Payment Mode (C= Cheque / T= Transfer )",
  "36- Bank Code, characters or numbers of 10 (Predefined)",
  "37- IBAN",
  "38- Account Number",
  "39 - Beneficiary full name",
];

export type LibanoMemberFileKind = "additions" | "deletions" | "everyone";

export type LibanoMemberLine = {
  category: MedicalInsuranceCategory;
  fullName: string;
  memberType: MedicalInsuranceMemberType;
  birthDate: string | null;
  gender: string | null;
  nationalId: string | null;
  /** The old certificate number ('34', '34-1') or a Phoenix HR id. */
  staffNumber: string | null;
  /** The insurer's own number for the person, once issued. */
  adherentNumber: string | null;
  /** The insurer's number for the employee the person sits under (their own, for an employee). */
  principalNumber: string | null;
  phone: string | null;
  /** The day cover starts (additions, everyone) or the last covered day (deletions). */
  day: string;
};

const RELATION = { child: "C", employee: "P", spouse: "S" } as const;

/** First, father and the rest, as the insurer's draft splits a name: first name, father name, last name. */
export function splitLibanoName(name: string): { first: string; father: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { father: "", first: parts[0] ?? "", last: "" };
  if (parts.length === 2) return { father: "", first: parts[0], last: parts[1] };
  return { father: parts[1], first: parts[0], last: parts.slice(2).join(" ") };
}

/** The insurer's date format: "ddmmyyyy", as text. */
export function libanoDay(value: string | null | undefined): string {
  if (!value) return "";
  const [year, month, date] = value.slice(0, 10).split("-");
  return `${date}${month}${year}`;
}

function sexLetter(gender: string | null | undefined): string {
  const value = String(gender ?? "").trim().toLowerCase();
  if (value.startsWith("m")) return "M";
  if (value.startsWith("f")) return "F";
  return "";
}

/** One person as the 39 cells of the insurer's sheet, every one text, in their order. */
export function libanoMemberCells(line: LibanoMemberLine): string[] {
  const name = splitLibanoName(line.fullName);
  const cells = new Array<string>(39).fill("");
  cells[0] = line.category; // Plan Code
  cells[1] = name.last;
  cells[2] = name.father.slice(0, 1);
  cells[3] = name.first;
  cells[4] = name.father;
  cells[6] = libanoDay(line.birthDate);
  cells[7] = RELATION[line.memberType];
  cells[9] = sexLetter(line.gender);
  cells[10] = line.category; // Class
  cells[12] = "020"; // Nationality: Egyptian, as the draft carries it
  cells[13] = String(line.nationalId ?? "").trim();
  cells[18] = "Sato Pharma"; // Reference2: the branch name the draft carries
  cells[21] = String(line.staffNumber ?? "").trim();
  cells[22] = String(line.adherentNumber ?? "").trim();
  cells[26] = String(line.principalNumber ?? "").trim();
  cells[27] = String(line.phone ?? "").trim();
  cells[32] = "0"; // Has Optical: 0 on every row of the draft
  return cells.map((value) => spreadsheetSafeText(value));
}

/**
 * Libano-Suisse's member file for the chosen people. One sheet, their headings, one row per person; a
 * 40th column carries the day cover starts, or for deletions the last covered day. Every cell is text, so
 * a staff number like '34-1' or a date like '08042026' is never turned into a number or a date.
 * It goes to the insurer by a person's hand: nothing here sends it, and the register does not change.
 */
export async function buildLibanoMemberFileWorkbook(input: { kind: LibanoMemberFileKind; rows: readonly LibanoMemberLine[] }): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  const sheet = workbook.addWorksheet("Output draft");
  const lastHeading = input.kind === "deletions" ? "Deletion date (ddmmyyyy)" : "Start date (ddmmyyyy)";
  const headings = [...LIBANO_MEMBER_FILE_HEADERS, lastHeading];
  sheet.columns = headings.map(() => ({ style: { numFmt: "@" }, width: 24 }));
  const header = sheet.getRow(1);
  header.values = headings;
  header.height = 60;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Calibri", size: 11 };
    cell.fill = { fgColor: { argb: "FF1F3864" }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  input.rows.forEach((line, index) => {
    sheet.getRow(index + 2).values = [...libanoMemberCells(line), libanoDay(line.day)];
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return finish(workbook);
}

export function medicalInsuranceFileDay(generatedAtIso: string): string {
  const at = new Date(generatedAtIso);
  return Number.isNaN(at.getTime()) ? "export" : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
}
