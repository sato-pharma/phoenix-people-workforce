// ─────────────────────────────────────────────────────────────────────────────────────────────
// Libano-Suisse's own "Additions and Deletions Sheet" — the workbook Sato sends the insurer for every
// addition and deletion (owner, 20 Nov 2026: "export for addition and deletion perfectly like this, 100%").
//
// The file is the insurer's own: seven sheets (the rules in English and Arabic with their logo, Interface,
// the Deletions sheet, the Additions sheet, and the hidden keys and Assumptions behind the drop-downs and the
// checks). It is NOT rebuilt here. The template in assets/medical-insurance/ is the file Sato last sent
// (6 Apr 2026) with its three people, their saved formula results, the authors' names and the other
// company's policy taken out, and this module only writes values into the insurer's own cells:
//
//   Additions sheet  row 6 on, B..Q  Branch, Addition Date, Staff ID, First / Father / Last name, date of birth
//                                    as Day / Month / Year, Gender, Relation, Plan, Principal ID, VIP, Mobile,
//                                    National ID
//   Deletions sheet  row 6 on, B..G  Branch, Deletion date, Individual ID (the 8-digit card number),
//                                    employee ID, Subscriber Name, Relation
//   Assumptions      the policy the checks read: holder, start, end, the 15-day grace period of the rules
//                    page, plans A/B/C with their room and network, and which relation each plan takes
//
// Every formula, drop-down, colour rule, logo and page setting stays as the insurer built it; Excel
// recalculates the "Feedback" checks when the file is opened. Nothing here sends the file.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import JSZip from "jszip";

import { LIBANO_TABLE_OF_BENEFITS } from "./benefits";
import type { MedicalInsuranceCategory } from "./cost";
import { LIBANO_GRACE_PERIOD_DAYS } from "./deletion-day";
import { splitLibanoName, type LibanoMemberLine } from "./workbooks";

export const LIBANO_MOVEMENT_TEMPLATE_PATH = join("assets", "medical-insurance", "libano-additions-deletions.xlsx");

/** The branch name the insurer's sheet carries for every Sato row. */
export const LIBANO_BRANCH_NAME = "Sato Pharma";
/** The rules page: "Addition Date of any new Adherent will be the date of receiving the email with grace period 15 days".
 * It lives beside the deletion-date rule, which reads the same number (./deletion-day.ts). */
export { LIBANO_GRACE_PERIOD_DAYS };

const FIRST_ROW = 6;
const ADDITIONS_LAST_ROW = 597;
const DELETIONS_LAST_ROW = 400;
/** The rows the insurer's sheets are drawn for: one person a row. */
export const LIBANO_ADDITIONS_SHEET_ROWS = ADDITIONS_LAST_ROW - FIRST_ROW + 1;
export const LIBANO_DELETIONS_SHEET_ROWS = DELETIONS_LAST_ROW - FIRST_ROW + 1;

const PLANS: readonly MedicalInsuranceCategory[] = ["A", "B", "C"];
const RELATION = { child: "C", employee: "P", spouse: "S" } as const;

export type LibanoMovementPolicy = { holder: string; startsOn: string; endsOn: string };
export type LibanoMovementKind = "additions" | "deletions";

type Cell = { text: string } | { number: number } | null;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Excel's day number for a calendar day ("2026-12-01" → 46357). */
export function excelDayNumber(day: string): number {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, date) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function columnIndex(column: string): number {
  return [...column].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

function cellXml(ref: string, style: string, cell: Cell): string {
  if (cell === null) return `<c r="${ref}"${style}/>`;
  if ("number" in cell) return `<c r="${ref}"${style}><v>${cell.number}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
}

/**
 * One worksheet's XML, cut into rows once so that filling hundreds of cells never re-copies the whole sheet
 * (the Additions sheet is 1.8 MB of formulas).
 */
class SheetXml {
  private readonly head: string;
  private readonly tail: string;
  private readonly rows = new Map<number, string>();

  constructor(xml: string) {
    const open = xml.indexOf("<sheetData>");
    const close = xml.indexOf("</sheetData>");
    if (open < 0 || close < 0) throw new Error("The insurer's template has a sheet with no cells.");
    this.head = xml.slice(0, open + "<sheetData>".length);
    this.tail = xml.slice(close);
    for (const match of xml.slice(open, close).matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
      this.rows.set(Number(match[1]), match[0]);
    }
  }

  /** Writes a value into a cell, keeping the cell's own style (its date format, its text format, its border). */
  set(ref: string, cell: Cell): void {
    const [, column, rowText] = /^([A-Z]+)(\d+)$/.exec(ref) ?? [];
    const rowNumber = Number(rowText);
    let row = this.rows.get(rowNumber) ?? `<row r="${rowNumber}"/>`;
    if (row.endsWith("/>")) row = `${row.slice(0, -2)}></row>`;
    const existing = new RegExp(`<c r="${ref}"(?=[\\s/>])([^>]*?)(?:/>|>[\\s\\S]*?</c>)`).exec(row);
    if (existing) {
      const style = / s="\d+"/.exec(existing[1])?.[0] ?? "";
      row = row.slice(0, existing.index) + cellXml(ref, style, cell) + row.slice(existing.index + existing[0].length);
    } else {
      const target = columnIndex(column);
      const later = [...row.matchAll(/<c r="([A-Z]+)\d+"/g)].find((match) => columnIndex(match[1]) > target);
      const at = later?.index ?? row.lastIndexOf("</row>");
      row = row.slice(0, at) + cellXml(ref, "", cell) + row.slice(at);
    }
    this.rows.set(rowNumber, row);
  }

  toString(): string {
    const ordered = [...this.rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
    return this.head + ordered.join("") + this.tail;
  }
}

/** Where each named sheet lives in the package, read from the workbook itself rather than assumed. */
async function sheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const targets = new Map([...rels.matchAll(/<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const paths = new Map<string, string>();
  for (const match of workbook.matchAll(/<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const target = targets.get(match[2]);
    if (target) paths.set(match[1], target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return paths;
}

async function editSheet(zip: JSZip, paths: Map<string, string>, name: string, edit: (sheet: SheetXml) => void): Promise<void> {
  const path = paths.get(name);
  const xml = path ? await zip.file(path)?.async("string") : undefined;
  if (!path || !xml) throw new Error(`The insurer's template has no "${name}".`);
  const sheet = new SheetXml(xml);
  edit(sheet);
  zip.file(path, sheet.toString());
}

const upper = (value: string | null | undefined): string => String(value ?? "").trim().toLocaleUpperCase("en");
const textOrNull = (value: string | null | undefined): Cell => {
  const text = String(value ?? "").trim();
  return text ? { text } : null;
};
const sexLetter = (gender: string | null | undefined): Cell => {
  const value = String(gender ?? "").trim().toLowerCase();
  return value.startsWith("m") ? { text: "M" } : value.startsWith("f") ? { text: "F" } : null;
};

function fillAdditions(sheet: SheetXml, rows: readonly LibanoMemberLine[]): void {
  rows.forEach((line, index) => {
    const r = FIRST_ROW + index;
    const name = splitLibanoName(line.fullName);
    const [year, month, date] = (line.birthDate ?? "").slice(0, 10).split("-").map(Number);
    const born = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(date) && year > 0;
    sheet.set(`B${r}`, { text: LIBANO_BRANCH_NAME });
    sheet.set(`C${r}`, { number: excelDayNumber(line.day) });
    sheet.set(`D${r}`, textOrNull(line.staffNumber));
    sheet.set(`E${r}`, textOrNull(upper(name.first)));
    sheet.set(`F${r}`, textOrNull(upper(name.father)));
    sheet.set(`G${r}`, textOrNull(upper(name.last)));
    sheet.set(`H${r}`, born ? { number: date } : null);
    sheet.set(`I${r}`, born ? { number: month } : null);
    sheet.set(`J${r}`, born ? { number: year } : null);
    sheet.set(`K${r}`, sexLetter(line.gender));
    sheet.set(`L${r}`, { text: RELATION[line.memberType] });
    sheet.set(`M${r}`, { text: line.category });
    // The principal's number is for a spouse or child; an employee is their own principal and the column stays empty.
    sheet.set(`N${r}`, line.memberType === "employee" ? null : textOrNull(line.principalNumber));
    sheet.set(`P${r}`, textOrNull(line.phone));
    sheet.set(`Q${r}`, textOrNull(line.nationalId));
  });
}

function fillDeletions(sheet: SheetXml, rows: readonly LibanoMemberLine[]): void {
  rows.forEach((line, index) => {
    const r = FIRST_ROW + index;
    sheet.set(`B${r}`, { text: LIBANO_BRANCH_NAME });
    sheet.set(`C${r}`, { number: excelDayNumber(line.day) });
    sheet.set(`D${r}`, textOrNull(line.adherentNumber));
    sheet.set(`E${r}`, textOrNull(line.staffNumber));
    sheet.set(`F${r}`, textOrNull(upper(line.fullName)));
    sheet.set(`G${r}`, { text: RELATION[line.memberType] });
  });
}

/** The policy the insurer's checks read; Interface shows it through its own formulas. */
function fillAssumptions(sheet: SheetXml, policy: LibanoMovementPolicy): void {
  sheet.set("E4", { text: policy.holder });
  sheet.set("E5", { number: excelDayNumber(policy.startsOn) });
  sheet.set("E6", { number: excelDayNumber(policy.endsOn) }); // the policy's own end, not the template's start + 12 months
  sheet.set("E7", { number: LIBANO_GRACE_PERIOD_DAYS });
  PLANS.forEach((plan, index) => {
    const room = LIBANO_TABLE_OF_BENEFITS[plan].facts.find((fact) => fact.label.en === "Hospital room")?.value.en;
    if (!room) throw new Error(`The table of benefits names no hospital room for plan ${plan}.`);
    sheet.set(`G${14 + index}`, { text: plan });
    sheet.set(`H${14 + index}`, { text: room }); // "Single room" / "Shared room", the keys sheet's own words
    sheet.set(`I${14 + index}`, { text: "Full " }); // the keys sheet's word for a full network, trailing space included
    // Plan against relation: every plan takes the employee, the spouse and the children.
    sheet.set(`C${49 + index}`, { text: plan });
    sheet.set(`D${49 + index}`, { text: "P" });
    sheet.set(`E${49 + index}`, { text: "S" });
    sheet.set(`F${49 + index}`, { text: "C" });
  });
}

export async function readLibanoMovementTemplate(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(process.cwd(), LIBANO_MOVEMENT_TEMPLATE_PATH)));
}

/**
 * Libano-Suisse's Additions and Deletions workbook with the chosen people on the Additions sheet or the
 * Deletions sheet, one row each from row 6, and this year's policy in Assumptions.
 */
export async function buildLibanoMovementWorkbook(input: {
  kind: LibanoMovementKind;
  policy: LibanoMovementPolicy;
  rows: readonly LibanoMemberLine[];
  template?: Uint8Array;
}): Promise<ArrayBuffer> {
  const capacity = input.kind === "additions" ? LIBANO_ADDITIONS_SHEET_ROWS : LIBANO_DELETIONS_SHEET_ROWS;
  if (input.rows.length > capacity) {
    throw new Error(`Libano-Suisse's ${input.kind} sheet holds ${capacity} people; this file has ${input.rows.length}.`);
  }
  const zip = await JSZip.loadAsync(input.template ?? (await readLibanoMovementTemplate()));
  const paths = await sheetPaths(zip);
  await editSheet(zip, paths, input.kind === "additions" ? "Additions sheet" : "Deletions sheet", (sheet) =>
    input.kind === "additions" ? fillAdditions(sheet, input.rows) : fillDeletions(sheet, input.rows),
  );
  await editSheet(zip, paths, "Assumptions", (sheet) => fillAssumptions(sheet, input.policy));
  return zip.generateAsync({ compression: "DEFLATE", compressionOptions: { level: 6 }, type: "arraybuffer" });
}
