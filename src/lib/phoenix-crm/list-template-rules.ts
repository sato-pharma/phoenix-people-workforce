/**
 * Phoenix CRM — the SFE's list template: the columns, and the rule for one filled row. No I/O.
 *
 * Owner's ask, 2026-10-02, when he was asked who grades an add on a territory with no district
 * manager: *"make a third option for SFE and system administrator … with the download and upload
 * template of the list … the SFE will send him an Excel sheet and he will populate it with the list,
 * then he [sends it back to] the SFE and SFE uploads this sheet so his list appears … regarding the
 * template that will be downloaded, put in its field every single thing you need. Every single data
 * you need. Put it to be populated."*
 *
 * ## What the sheet can and cannot carry
 *
 * Everything the system needs about a CUSTOMER is a column here: his list (AM, PM or Pharmacy), his
 * name, his speciality, the grade and the potential grade, his phone, where to find him and a note
 * for the rep.
 *
 * 🔴 THE PLACE IS NOT A COLUMN, AND MUST NEVER BECOME ONE. A place is validated once, at the door,
 * from a live signboard photo and a GPS read taken on the spot, and its address, brick, area and
 * region are resolved SERVER-side from that point (the owner's locked rule of 2026-09-23/29). A
 * latitude in a spreadsheet is a typed location, which is the one thing that rule exists to forbid —
 * so an uploaded customer lands on the list as `pending` and the rep validates him at his clinic
 * exactly as he validates one carried over from iReports360. "Where to find him" below is a NOTE for
 * the rep, never a location the system reads.
 *
 * ## Why the grade is the SFE's here
 *
 * A rep never sets a grade. On the ordinary path the district manager confirms the A/B/C and sets the
 * potential, then SFE admits. This route is for the case that path cannot serve — a territory whose
 * manager chain is vacant, or a whole list that has to be loaded at once — so the SFE who uploads the
 * sheet is the one who graded it, in the sheet, and the upload is recorded as his act.
 *
 * ## The header tokens are the contract
 *
 * They live here and are imported by BOTH the builder and the parser, so a rename cannot silently
 * make the template unreadable by its own importer (the lesson `employee-upload-parse.ts` records).
 * `tests/phoenix-crm-list-template.test.ts` pins them.
 */

import {
  CUSTOMER_NAME_MAX,
  PLACE_TEXT_MAX,
  parseCustomerPhone,
  parseGrade,
  parsePotentialGrade,
  type PotentialGrade,
} from "@/lib/phoenix-crm/entry-rules";
import { parseListType, type PhoenixListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { PhoenixCrmGrade } from "@/lib/phoenix-crm/types";

/** The sheet the fillable table lives on. Single word: a formula or a validation needs no quoting. */
export const TEMPLATE_SHEET = "Customers";

/** The reference sheet the dropdowns point at. Single word, same reason. */
export const TEMPLATE_LISTS_SHEET = "Lists";

/** What the seat already holds, so the SFE can see it and not ask for it twice. */
export const TEMPLATE_EXISTING_SHEET = "Already on the list";

/**
 * The label the territory's seat id is written beside, and read back from.
 *
 * 🔴 THE SHEET NAMES ITS OWN TERRITORY, AND THE UPLOAD REFUSES A MISMATCH. The uploader also picks a
 * territory in the screen; without the marker, two sheets filled for two reps are one slip away from
 * loading the wrong rep's doctors onto the wrong seat, and nothing downstream would ever say so.
 */
export const TEMPLATE_SEAT_LABEL = "Territory code (do not change)";

/** How many rows the parser scans for the header before giving up. */
export const TEMPLATE_HEADER_SCAN_ROWS = 14;

/** How many blank rows to offer. A rep's list runs to a few hundred; the sheet never limits it. */
export const TEMPLATE_BLANK_ROWS = 400;

/**
 * The line the sheet prints under its table. It lives HERE, not in the builder, for the same reason the
 * column hints do: the importer has to recognise it, and a second copy of the words would drift.
 */
export const TEMPLATE_TABLE_NOTE =
  "One customer per row. The grade and the potential are optional — a pharmacy has neither. Leave the "
  + "spare rows empty — they are ignored.";

/** The most rows one upload will take, so a mis-picked file cannot load a book at a territory. */
export const TEMPLATE_ROWS_MAX = 1000;

export const TEMPLATE_NOTE_MAX = 300;

/**
 * One column: the token written in the header, and the aliases the parser accepts for it. Aliases are
 * matched on a folded form (lower case, collapsed whitespace), so "Customer Name" and "customer name"
 * are the same token and a sheet somebody rebuilt by hand still reads.
 */
export type TemplateColumn = {
  key: TemplateColumnKey;
  label: string;
  aliases: readonly string[];
  width: number;
  /** Written on the sheet under the header, as the instruction for whoever fills it. */
  hint: string;
};

export type TemplateColumnKey =
  | "listType"
  | "name"
  | "speciality"
  | "grade"
  | "potentialGrade"
  | "phone"
  | "whereToFind"
  | "note";

export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  {
    key: "listType",
    label: "List",
    aliases: ["list", "list type", "am or pm", "am/pm"],
    width: 14,
    hint: "AM, PM or Pharmacy",
  },
  {
    key: "name",
    label: "Customer name",
    // 🔴 No "doctor name" alias. The owner's rule is that Phoenix CRM says AM and PM and never
    // "doctor" or "account" (2026-09-23), and `tests/phoenix-crm-am-pm-words` scans this module for
    // the word — it caught this line. A hidden tolerance for a banned word is still the module
    // carrying it, and a pharmacy is on this sheet too, so "doctor name" would be wrong anyway.
    aliases: ["customer name", "name", "customer"],
    width: 34,
    hint: "As it should appear on their list",
  },
  {
    key: "speciality",
    label: "Speciality",
    aliases: ["speciality", "specialty"],
    width: 22,
    hint: "Optional",
  },
  {
    key: "grade",
    label: "Grade",
    aliases: ["grade", "abc", "a/b/c"],
    width: 10,
    hint: "A, B or C — optional",
  },
  {
    key: "potentialGrade",
    label: "Potential",
    aliases: ["potential", "potential grade"],
    width: 12,
    hint: "AA to BC — optional",
  },
  {
    key: "phone",
    label: "Phone",
    aliases: ["phone", "mobile", "telephone"],
    width: 18,
    hint: "Optional, digits only",
  },
  {
    key: "whereToFind",
    label: "Where to find them",
    aliases: ["where to find them", "where to find him", "where to find", "address", "clinic"],
    width: 38,
    hint: "A note for the rep — the real location is captured at the door",
  },
  {
    key: "note",
    label: "Note for the rep",
    aliases: ["note for the rep", "note", "notes"],
    width: 34,
    hint: "Optional",
  },
];

/** The two tokens a sheet must carry to be this template at all. */
export const TEMPLATE_REQUIRED_KEYS: readonly TemplateColumnKey[] = ["listType", "name"];

export function foldHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** The three lists, as the dropdown offers them and the database stores them. */
export const TEMPLATE_LIST_TYPES: readonly PhoenixListType[] = ["PM", "AM", "Pharmacy"];

/**
 * What the List cell says, as one of the three canonical tokens — or null when it says something else.
 *
 * 🔴 `parseListType` IS EXACT AND CASE-SENSITIVE ON PURPOSE: it answers `PM` for anything it does not
 * recognise, so that a row written by an older build reads as it always did. That is right for a
 * STORED value and wrong for a typed CELL — handed "am" or "pharmacy" straight, it would answer PM and
 * a pharmacy somebody typed in lower case would be filed among the doctors, which is the exact defect
 * the pharmacy rule is about. So the cell is canonicalised here first, and the module's own parser
 * still has the last word on the value that is stored.
 */
export function readListTypeCell(value: unknown): PhoenixListType | null {
  const folded = foldHeader(value);
  const match = TEMPLATE_LIST_TYPES.find((listType) => foldHeader(listType) === folded);
  return match ? parseListType(match) : null;
}

/** Which column each header cell is, by index. A header the template does not know is ignored. */
export function locateTemplateColumns(headers: readonly unknown[]): Map<TemplateColumnKey, number> {
  const found = new Map<TemplateColumnKey, number>();
  headers.forEach((header, index) => {
    const folded = foldHeader(header);
    if (!folded) return;
    for (const column of TEMPLATE_COLUMNS) {
      if (found.has(column.key)) continue;
      if (folded === foldHeader(column.label) || column.aliases.includes(folded)) found.set(column.key, index);
    }
  });
  return found;
}

/** A row of the sheet as the parser hands it on — already trimmed, already judged. */
export type TemplateCustomerRow = {
  /** The spreadsheet row number, so a refusal names the line the SFE is looking at. */
  row: number;
  listType: PhoenixListType;
  name: string;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  potentialGrade: PotentialGrade | null;
  phone: string | null;
  whereToFind: string | null;
  note: string | null;
};

export type TemplateRowRefusal = { row: number; reason: string };

export type TemplateRowVerdict =
  /** Every cell was blank: the sheet's spare rows, skipped in silence. */
  | { kind: "blank" }
  | { kind: "row"; value: TemplateCustomerRow }
  | { kind: "refused"; reason: string };

function text(value: unknown, max: number): string | null {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

/**
 * One filled row, judged exactly as the app judges the same facts typed by hand.
 *
 * 🔴 THE GRADE AND THE POTENTIAL ARE OPTIONAL (owner, 2026-10-03: "make the grade and the potential
 * optional, not required"). An empty, invalid, or pharmacy-typed value never refuses the row: the grade
 * is kept only when it is a real A/B/C, the potential only when it is a real AA..BC, and anything else
 * is dropped to null. A pharmacy carries neither by its nature — a grade typed on one is IGNORED, not
 * refused (owner's choice the same day, asked directly: "ignore it, let them load"). The only things
 * that still refuse a row are the structural ones: no list, a list that is not one of the three, and no
 * name. The district-manager door still REQUIRES a potential before it approves an add
 * (`phoenix_crm_decide_request`) — that flow is untouched; this loosening is the bulk sheet alone.
 */
/**
 * The template's own guidance row, left exactly as it was downloaded.
 *
 * 🔴 IT IS A REAL DATA ROW OF THE SHEET, so the importer reads it like any other and `parseTemplateRow`
 * refuses it — `"AM, PM or Pharmacy" is not a list`. Every upload of an untouched template therefore
 * reported one refused row and told the SFE to go and fix the instruction line Phoenix itself wrote.
 * (The builder's comment used to claim the parser "skips it"; it never did. Found in review, 2026-10-03.)
 *
 * Recognised by VALUE, against the very hints the builder writes, so the two cannot drift: a row is the
 * guidance row only when every cell he has not touched still reads its own column's hint, word for word.
 * A real customer cannot collide with it — his List cell would have to say "AM, PM or Pharmacy" — and an
 * SFE who types over some columns and leaves the hint text in others is judged normally, because then a
 * non-empty cell no longer matches its own hint.
 */
export function isTemplateHintRow(raw: Record<TemplateColumnKey, string>): boolean {
  const filled = TEMPLATE_COLUMNS.filter((column) => raw[column.key] !== "");
  if (filled.length === 0) return false;
  return filled.every((column) => raw[column.key] === column.hint);
}

/**
 * The sheet's OWN FURNITURE, in the rows the importer reads: the guidance row above the blanks and the
 * note line printed under the table.
 *
 * 🔴 The note was the SECOND bogus refusal, and nobody reported it — it was found only by reading the
 * real workbook end to end and asking what an UNTOUCHED template refuses. `writeHouseTable` prints the
 * note one row past the last blank, inside the span the importer scans (it reads to `sheet.rowCount`,
 * because an SFE may paste more rows than the 400 offered and the note then moves down with them), so
 * it arrived in the List column and was refused as a customer called "One customer per row…".
 */
export function isTemplateFurnitureRow(raw: Record<TemplateColumnKey, string>): boolean {
  if (isTemplateHintRow(raw)) return true;
  const filled = TEMPLATE_COLUMNS.filter((column) => raw[column.key] !== "");
  return filled.length === 1 && filled[0]!.key === "listType" && raw.listType === TEMPLATE_TABLE_NOTE;
}

export function parseTemplateRow(row: number, cells: Partial<Record<TemplateColumnKey, unknown>>): TemplateRowVerdict {
  const raw = Object.fromEntries(
    TEMPLATE_COLUMNS.map((column) => [column.key, String(cells[column.key] ?? "").trim()]),
  ) as Record<TemplateColumnKey, string>;
  if (TEMPLATE_COLUMNS.every((column) => raw[column.key] === "")) return { kind: "blank" };
  // Blank, not refused: the sheet's own furniture is not something the SFE got wrong.
  if (isTemplateFurnitureRow(raw)) return { kind: "blank" };

  if (!raw.listType) return { kind: "refused", reason: "The List cell is empty — write AM, PM or Pharmacy." };
  const listType = readListTypeCell(raw.listType);
  if (!listType) {
    return { kind: "refused", reason: `"${raw.listType}" is not a list — write AM, PM or Pharmacy.` };
  }

  const name = text(raw.name, CUSTOMER_NAME_MAX);
  if (!name) return { kind: "refused", reason: "The customer's name is empty." };
  if (name.length < 3) return { kind: "refused", reason: `"${name}" is too short for a customer's name.` };

  // Optional either way: a pharmacy never carries them, and for a doctor only a real grade and a real
  // potential are kept — an empty or unrecognised cell is dropped to null, never a refusal.
  const isPharmacy = listType === "Pharmacy";
  const grade = isPharmacy ? null : parseGrade(raw.grade);
  const potentialGrade = isPharmacy ? null : parsePotentialGrade(raw.potentialGrade);

  const phone = parseCustomerPhone(raw.phone);
  if (!phone.ok) return { kind: "refused", reason: phone.error };

  return {
    kind: "row",
    value: {
      row,
      listType,
      name,
      speciality: text(raw.speciality, 120),
      grade,
      potentialGrade,
      phone: phone.value,
      whereToFind: text(raw.whereToFind, PLACE_TEXT_MAX),
      note: text(raw.note, TEMPLATE_NOTE_MAX),
    },
  };
}

/**
 * The rows that survive, and the ones refused — plus the duplicates WITHIN the sheet itself.
 *
 * Two rows naming the same customer on the same list is the commonest filling mistake there is, and
 * the database's own `same_name` guard would catch only the second one against what is already on the
 * list. Caught here, the SFE is told which two lines of his own sheet disagree.
 */
export function readTemplateRows(
  rows: ReadonlyArray<{ row: number; cells: Partial<Record<TemplateColumnKey, unknown>> }>,
): { customers: TemplateCustomerRow[]; refused: TemplateRowRefusal[] } {
  const customers: TemplateCustomerRow[] = [];
  const refused: TemplateRowRefusal[] = [];
  const seen = new Map<string, number>();
  for (const entry of rows) {
    const verdict = parseTemplateRow(entry.row, entry.cells);
    if (verdict.kind === "blank") continue;
    if (verdict.kind === "refused") {
      refused.push({ row: entry.row, reason: verdict.reason });
      continue;
    }
    const key = `${verdict.value.listType}:${verdict.value.name.toLowerCase()}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      refused.push({ row: entry.row, reason: `The same ${verdict.value.listType} customer is already on row ${earlier} of this sheet.` });
      continue;
    }
    seen.set(key, entry.row);
    customers.push(verdict.value);
  }
  return { customers, refused };
}
