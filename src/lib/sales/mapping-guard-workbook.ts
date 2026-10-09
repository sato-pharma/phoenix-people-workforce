// The held-changes workbook: what the Mapping Guard screen shows, as a sheet he can read in Excel,
// answer, and upload back. Owner, 2026-10-10: "make me able to export xlsx with their address area
// brick and every geography data and map and upload".
//
// THREE JOBS, ALL PURE (no database here — `mapping-guard-sheet.ts` loads and writes):
//   1. buildGuardWorkbook   — the export: one row per held customer, with what Phoenix holds, what the
//                             distributor's own file filed, where it sits now, where the held change
//                             wanted it, what the normalizer suggests, and the money riding on it.
//   2. parseGuardWorkbook   — read an uploaded sheet back into answers, by header NAME, never position.
//   3. planGuardAnswers     — turn answers into a PLAN against live state: what would be written, what
//                             is refused and why, and a digest per page so the apply step can prove it
//                             is writing exactly what he previewed.
//
// THE UPLOAD DECIDES NOTHING BY ITSELF. A row with a blank answer is left exactly as it is, an answer
// that cannot be checked against live state is a PROBLEM that stops that row only, and every write
// goes through the guard's own decide path (`decideMappingHold`) — the sheet is a faster way to press
// the same buttons, never a way around them.
//
// Customer codes, brick ids and hold ids are stored as TEXT: a number-typed code loses its leading
// zeros and a numeric id sorts as a number, which is how an upload mismatches silently.

import { createHash } from "node:crypto";

import ExcelJS from "exceljs";

import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  GUARD_ANSWER_LABEL,
  GUARD_APPLY_PAGE_SIZE,
  type GuardAnswer,
  type GuardGeo,
  type GuardInstruction,
  type GuardPlan,
  type GuardPlanPage,
  type GuardPlanRow,
  type GuardProblem,
} from "@/lib/sales/mapping-guard-sheet-shape";
import {
  BLACK,
  ORANGE,
  VALUE_FMT,
  WHITE,
  ZEBRA,
  gridBorder,
} from "@/lib/sales/sales-workbook-kit";
import { excelCellText } from "@/lib/uploads/exceljs-rows";

export const GUARD_SHEET_NAME = "Held Changes";
export const GUARD_BRICKS_SHEET_NAME = "Bricks";
export const GUARD_GUIDE_SHEET_NAME = "How to use";

/** One held customer, everything the sheet prints. Built by the server loader from live state. */
export type GuardSheetRow = {
  holdId: number;
  distributorCode: string;
  distributor: string;
  customerCode: string;
  customerName: string;
  customerAddress: string;
  /** What the distributor's newest file filed for this customer, exactly as filed. */
  filed: {
    period: string;
    name: string;
    address: string;
    brick: string;
    area: string;
    governorate: string;
  } | null;
  /** Older, different filings of the same code — printed as text, because they are the case worth seeing. */
  otherFiled: string[];
  now: GuardGeo | null;
  nowBrickId: string;
  wanted: GuardGeo | null;
  suggested: { brickId: string; brick: string; verdict: string } | null;
  trackedValue: number;
  restatedValue: number;
  ownerRuling: boolean;
  reasons: string[];
};

/** What the plan needs to know about a hold RIGHT NOW. Built by the server from the database. */
export type GuardLiveHold = {
  holdId: number;
  rowId: number;
  customer: string;
  liveBrickId: string;
  ownerRuling: boolean;
  now: GuardGeo | null;
  wanted: GuardGeo | null;
  trackedValue: number;
  restatedValue: number;
};

/** An answer as the sheet (or the apply request) states it, before any checking. */
export type ParsedSheetRow = {
  sheetRow: number;
  holdId: number | null;
  nowBrickId: string;
  rawAnswer: string;
  moveToBrickId: string;
  rawLock: string;
};

type ColumnKind = "id" | "text" | "money" | "input";
type SheetColumn = { key: string; header: string; width: number; kind: ColumnKind };

// The answer columns come FIRST, right after the hold and the customer's name, because a sheet whose
// answers sit thirty columns to the right is one nobody fills in. The evidence follows.
const COLUMNS: SheetColumn[] = [
  { header: "Hold ID", key: "holdId", kind: "id", width: 10 },
  { header: "Customer Name", key: "customerName", kind: "text", width: 34 },
  { header: "Your Answer", key: "answer", kind: "input", width: 20 },
  { header: "Move To Brick ID", key: "moveTo", kind: "input", width: 16 },
  { header: "Lock My Answer", key: "lock", kind: "input", width: 12 },
  { header: "Distributor Code", key: "distributorCode", kind: "id", width: 12 },
  { header: "Distributor", key: "distributor", kind: "text", width: 20 },
  { header: "Customer Code", key: "customerCode", kind: "id", width: 16 },
  { header: "Customer Address (Phoenix)", key: "customerAddress", kind: "text", width: 44 },
  { header: "Filed In", key: "filedPeriod", kind: "text", width: 11 },
  { header: "Filed Name", key: "filedName", kind: "text", width: 30 },
  { header: "Filed Address", key: "filedAddress", kind: "text", width: 44 },
  { header: "Filed Brick", key: "filedBrick", kind: "text", width: 24 },
  { header: "Filed Area", key: "filedArea", kind: "text", width: 22 },
  { header: "Filed Governorate", key: "filedGovernorate", kind: "text", width: 20 },
  { header: "Other Filings", key: "otherFiled", kind: "text", width: 50 },
  { header: "Now Brick ID", key: "nowBrickId", kind: "id", width: 14 },
  { header: "Now Brick", key: "nowBrick", kind: "text", width: 26 },
  { header: "Now Area ID", key: "nowAreaCode", kind: "id", width: 12 },
  { header: "Now Area", key: "nowArea", kind: "text", width: 22 },
  { header: "Now Governorate ID", key: "nowRegionCode", kind: "id", width: 14 },
  { header: "Now Governorate", key: "nowRegion", kind: "text", width: 20 },
  { header: "Wanted Brick ID", key: "wantedBrickId", kind: "id", width: 14 },
  { header: "Wanted Brick", key: "wantedBrick", kind: "text", width: 26 },
  { header: "Wanted Area ID", key: "wantedAreaCode", kind: "id", width: 12 },
  { header: "Wanted Area", key: "wantedArea", kind: "text", width: 22 },
  { header: "Wanted Governorate ID", key: "wantedRegionCode", kind: "id", width: 14 },
  { header: "Wanted Governorate", key: "wantedRegion", kind: "text", width: 20 },
  { header: "Suggested Brick ID", key: "suggestedBrickId", kind: "id", width: 14 },
  { header: "Suggested Brick", key: "suggestedBrick", kind: "text", width: 26 },
  { header: "Suggestion Says", key: "suggestionVerdict", kind: "text", width: 30 },
  { header: "Tracked Sales (EGP)", key: "trackedValue", kind: "money", width: 18 },
  { header: "In Finished Months (EGP)", key: "restatedValue", kind: "money", width: 20 },
  { header: "Your Earlier Ruling", key: "ownerRuling", kind: "text", width: 14 },
  { header: "Why It Was Held", key: "reasons", kind: "text", width: 50 },
];

const HEADER_KEY = new Map(COLUMNS.map((column) => [normalizeHeader(column.header), column.key]));

function normalizeHeader(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const INPUT_FILL = "FFFEF9E7";

function cellText(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function geoCells(prefix: "now" | "wanted", geo: GuardGeo | null): Record<string, string> {
  return {
    [`${prefix}AreaCode`]: geo?.areaCode ?? "",
    [`${prefix}Area`]: geo?.areaName ?? "",
    [`${prefix}Brick`]: geo?.brickName ?? "",
    [`${prefix}BrickId`]: geo?.brickId ?? "",
    [`${prefix}Region`]: geo?.regionName ?? "",
    [`${prefix}RegionCode`]: geo?.regionCode ?? "",
  };
}

function recordOf(row: GuardSheetRow): Record<string, string | number> {
  return {
    answer: "",
    customerAddress: row.customerAddress,
    customerCode: row.customerCode,
    customerName: row.customerName,
    distributor: row.distributor,
    distributorCode: row.distributorCode,
    filedAddress: row.filed?.address ?? "",
    filedArea: row.filed?.area ?? "",
    filedBrick: row.filed?.brick ?? "",
    filedGovernorate: row.filed?.governorate ?? "",
    filedName: row.filed?.name ?? "",
    filedPeriod: row.filed?.period ?? "",
    holdId: String(row.holdId),
    lock: "",
    moveTo: "",
    nowBrickId: row.nowBrickId,
    otherFiled: row.otherFiled.join("\n"),
    ownerRuling: row.ownerRuling ? "Yes" : "",
    reasons: row.reasons.join("\n"),
    restatedValue: row.restatedValue,
    suggestedBrick: row.suggested?.brick ?? "",
    suggestedBrickId: row.suggested?.brickId ?? "",
    suggestionVerdict: row.suggested?.verdict ?? "",
    trackedValue: row.trackedValue,
    ...geoCells("now", row.now),
    ...geoCells("wanted", row.wanted),
  };
}

function writeHeader(sheet: ExcelJS.Worksheet, columns: readonly SheetColumn[]) {
  const headerRow = sheet.getRow(1);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    const isInput = column.kind === "input";
    cell.font = { bold: true, color: { argb: isInput ? BLACK : WHITE }, name: "Calibri", size: 11 };
    cell.fill = { fgColor: { argb: isInput ? ORANGE : BLACK }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = gridBorder();
    sheet.getColumn(index + 1).width = column.width;
  });
  headerRow.height = 32;
}

function writeBricksSheet(sheet: ExcelJS.Worksheet, bricks: readonly GuardGeo[]) {
  const columns: SheetColumn[] = [
    { header: "Brick ID", key: "brickId", kind: "id", width: 14 },
    { header: "Brick", key: "brickName", kind: "text", width: 30 },
    { header: "Area ID", key: "areaCode", kind: "id", width: 12 },
    { header: "Area", key: "areaName", kind: "text", width: 26 },
    { header: "Governorate ID", key: "regionCode", kind: "id", width: 14 },
    { header: "Governorate", key: "regionName", kind: "text", width: 24 },
  ];
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  writeHeader(sheet, columns);
  bricks.forEach((brick, rowIndex) => {
    const row = sheet.getRow(rowIndex + 2);
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      cell.value = cellText(brick[column.key as keyof GuardGeo]);
      if (column.kind === "id") cell.numFmt = "@";
      cell.font = { name: "Calibri", size: 10.5 };
      cell.alignment = { horizontal: "left", vertical: "top" };
      cell.border = gridBorder();
      if (rowIndex % 2 === 1) cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
    });
  });
  sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: columns.length, row: 1 } };
}

function writeGuide(sheet: ExcelJS.Worksheet) {
  const lines: Array<[string, boolean]> = [
    ["Held mapping changes — answer them here, then upload this file back", true],
    ["", false],
    ["Each row of 'Held Changes' is one customer whose re-mapping the guard stopped. Nothing on it has been applied.", false],
    ["", false],
    ["Fill the three orange columns:", true],
    ["  Your Answer       Allow = apply the change as it was wanted.   Keep as is = refuse it, the mapping stays where it is.", false],
    ["                    Move to my brick = neither: put the customer in the brick you type in the next column.", false],
    ["  Move To Brick ID  Only with 'Move to my brick'. Pick it from the list; the 'Bricks' sheet shows each brick's area and governorate.", false],
    ["  Lock My Answer    Yes (or blank) = your answer becomes final and no upload can move this customer again. No = no new lock is added.", false],
    ["", false],
    ["Leave Your Answer blank to leave a row alone. Do not edit the grey evidence columns — 'Now Brick ID' is how the upload", false],
    ["notices that the mapping changed after this file was made, and it refuses that row rather than overwrite a newer decision.", false],
    ["", false],
    ["Uploading is a PREVIEW first. You see which rows would change, which bricks, areas and governorates, and the sales", false],
    ["money riding on them, and nothing is written until you confirm. A row that cannot be checked is listed and left alone.", false],
    ["", false],
    ["Filed columns are what the distributor's own file carried (name, address, brick, territory, governorate). 'Other Filings'", false],
    ["lists older, different text filed under the same code. 'Your Earlier Ruling' = Yes means the mapping carries a ruling of yours.", false],
    ["Money counts the tracked lines only (Head Office is never part of it).", false],
  ];
  lines.forEach(([text, bold], index) => {
    const cell = sheet.getRow(index + 1).getCell(1);
    cell.value = text;
    cell.font = { bold, name: "Calibri", size: bold ? 13 : 11 };
  });
  sheet.getColumn(1).width = 130;
}

export async function buildGuardWorkbook(input: {
  bricks: readonly GuardGeo[];
  rows: readonly GuardSheetRow[];
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(GUARD_SHEET_NAME);
  // Hold ID and the customer's name stay on screen while he scrolls the evidence.
  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];
  writeHeader(sheet, COLUMNS);

  const answerColumn = COLUMNS.findIndex((column) => column.key === "answer") + 1;
  const moveColumn = COLUMNS.findIndex((column) => column.key === "moveTo") + 1;
  const lockColumn = COLUMNS.findIndex((column) => column.key === "lock") + 1;
  const brickCount = Math.max(1, input.bricks.length);

  input.rows.forEach((row, rowIndex) => {
    const record = recordOf(row);
    const excelRow = sheet.getRow(rowIndex + 2);
    COLUMNS.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      const raw = record[column.key];
      if (column.kind === "money") {
        cell.value = typeof raw === "number" ? raw : Number(raw ?? 0);
        cell.numFmt = VALUE_FMT;
        cell.alignment = { horizontal: "right", vertical: "top" };
      } else {
        cell.value = raw === undefined || raw === null ? "" : String(raw);
        if (column.kind === "id" || column.kind === "input") cell.numFmt = "@";
        cell.alignment = { horizontal: "left", vertical: "top", wrapText: column.key === "otherFiled" || column.key === "reasons" };
      }
      cell.font = { name: "Calibri", size: 10.5 };
      cell.border = gridBorder();
      if (column.kind === "input") {
        cell.fill = { fgColor: { argb: INPUT_FILL }, pattern: "solid", type: "pattern" };
      } else if (rowIndex % 2 === 1) {
        cell.fill = { fgColor: { argb: ZEBRA }, pattern: "solid", type: "pattern" };
      }
    });

    excelRow.getCell(answerColumn).dataValidation = {
      allowBlank: true,
      error: "Pick Allow, Keep as is or Move to my brick — or leave it blank.",
      errorStyle: "stop",
      errorTitle: "Your Answer",
      formulae: [`"${Object.values(GUARD_ANSWER_LABEL).join(",")}"`],
      showErrorMessage: true,
      type: "list",
    };
    excelRow.getCell(moveColumn).dataValidation = {
      allowBlank: true,
      error: "Pick a Brick ID from the list. The Bricks sheet shows where each one sits.",
      errorStyle: "stop",
      errorTitle: "Move To Brick ID",
      formulae: [`${GUARD_BRICKS_SHEET_NAME}!$A$2:$A$${brickCount + 1}`],
      showErrorMessage: true,
      type: "list",
    };
    excelRow.getCell(lockColumn).dataValidation = {
      allowBlank: true,
      error: "Yes or No — or leave it blank, which means Yes.",
      errorStyle: "stop",
      errorTitle: "Lock My Answer",
      formulae: ['"Yes,No"'],
      showErrorMessage: true,
      type: "list",
    };
  });

  if (input.rows.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: COLUMNS.length, row: input.rows.length + 1 } };
  }

  writeBricksSheet(workbook.addWorksheet(GUARD_BRICKS_SHEET_NAME), input.bricks);
  writeGuide(workbook.addWorksheet(GUARD_GUIDE_SHEET_NAME));

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

// ── Reading an uploaded sheet ────────────────────────────────────────────────────────────────

function locateHeldSheet(workbook: ExcelJS.Workbook): { sheet: ExcelJS.Worksheet; columns: Map<string, number> } | null {
  const ordered = [
    ...workbook.worksheets.filter((sheet) => sheet.name === GUARD_SHEET_NAME),
    ...workbook.worksheets.filter((sheet) => sheet.name !== GUARD_SHEET_NAME),
  ];
  for (const sheet of ordered) {
    const columns = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, columnNumber) => {
      const key = HEADER_KEY.get(normalizeHeader(excelCellText(cell.value)));
      if (key && !columns.has(key)) columns.set(key, columnNumber);
    });
    if (columns.has("holdId") && columns.has("answer")) return { columns, sheet };
  }
  return null;
}

export function parseGuardWorkbook(workbook: ExcelJS.Workbook): ParsedSheetRow[] {
  const located = locateHeldSheet(workbook);
  if (!located) {
    throw new SalesWorkflowError(
      "unmatched_guard_sheet",
      "This is not a held-changes sheet: it has no Hold ID and Your Answer columns. Export the sheet from this screen and answer that file.",
      400,
    );
  }
  const { columns, sheet } = located;
  const text = (row: ExcelJS.Row, key: string) => {
    const column = columns.get(key);
    return column ? excelCellText(row.getCell(column).value) : "";
  };

  const parsed: ParsedSheetRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawHold = text(row, "holdId");
    const rawAnswer = text(row, "answer");
    const moveToBrickId = text(row, "moveTo").toUpperCase();
    const rawLock = text(row, "lock");
    if (!rawHold && !rawAnswer && !moveToBrickId && !rawLock) continue;
    const holdNumber = Number(rawHold);
    parsed.push({
      holdId: Number.isInteger(holdNumber) && holdNumber > 0 ? holdNumber : null,
      moveToBrickId,
      nowBrickId: text(row, "nowBrickId").toUpperCase(),
      rawAnswer,
      rawLock,
      sheetRow: rowNumber,
    });
  }
  return parsed;
}

/** The apply request's own instructions, put through the SAME interpretation as a sheet row. */
export function sheetRowsFromInstructions(instructions: readonly GuardInstruction[]): ParsedSheetRow[] {
  return instructions.map((instruction, index) => ({
    holdId: instruction.holdId,
    moveToBrickId: instruction.moveToBrickId.trim().toUpperCase(),
    nowBrickId: instruction.nowBrickId.trim().toUpperCase(),
    rawAnswer: GUARD_ANSWER_LABEL[instruction.answer] ?? "",
    rawLock: instruction.lock ? "Yes" : "No",
    sheetRow: index + 1,
  }));
}

// ── Planning ─────────────────────────────────────────────────────────────────────────────────

function readAnswer(raw: string): GuardAnswer | "" | null {
  const key = raw.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!key) return "";
  if (key === "allow" || key === "approve" || key === "approved") return "allow";
  if (["keep as is", "keep", "reject", "rejected", "refuse", "refused"].includes(key)) return "keep";
  if (key === "move to my brick" || key === "move") return "move";
  return null;
}

function readLock(raw: string): boolean | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!key || ["yes", "y", "true", "1"].includes(key)) return true;
  if (["no", "n", "false", "0"].includes(key)) return false;
  return null;
}

function describeGeo(geo: GuardGeo | null, fallbackBrickId: string): string {
  if (!geo) return fallbackBrickId || "not mapped";
  return [geo.brickName || geo.brickId, geo.areaName || geo.areaCode, geo.regionName || geo.regionCode]
    .filter(Boolean)
    .join(" · ");
}

export function guardPageDigest(rows: ReadonlyArray<Pick<GuardPlanRow, "answer" | "holdId" | "lock" | "moveToBrickId" | "nowBrickId">>): string {
  const lines = [...rows]
    .sort((a, b) => a.holdId - b.holdId)
    .map((row) => [row.holdId, row.answer, row.moveToBrickId, row.lock ? "lock" : "open", row.nowBrickId].join("|"));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function planGuardAnswers(input: {
  rows: readonly ParsedSheetRow[];
  live: ReadonlyMap<number, GuardLiveHold>;
  /** Active bricks only, by upper-cased id. A brick that is switched off is never a destination. */
  bricks: ReadonlyMap<string, GuardGeo>;
}): GuardPlan {
  const ready: GuardPlanRow[] = [];
  const problems: GuardProblem[] = [];
  const seen = new Set<number>();
  let skipped = 0;

  for (const row of input.rows) {
    const live = row.holdId === null ? undefined : input.live.get(row.holdId);
    const customer = live?.customer ?? (row.holdId === null ? "" : `Hold ${row.holdId}`);
    const problem = (reason: string) => problems.push({ customer, holdId: row.holdId, reason, sheetRow: row.sheetRow });

    const answer = readAnswer(row.rawAnswer);
    // A blank answer is NOT a problem and NOT an action: it is a row he chose to leave. It is also
    // checked first, so a sheet exported with 200 rows and answered on 30 does not shout about 170.
    if (answer === "" && !row.moveToBrickId && !row.rawLock) {
      skipped += 1;
      continue;
    }
    if (row.holdId === null) {
      problem("The Hold ID is missing or is not a number.");
      continue;
    }
    if (answer === null) {
      problem(`"${row.rawAnswer}" is not an answer. Use Allow, Keep as is or Move to my brick.`);
      continue;
    }
    if (answer === "") {
      problem("It has a brick or a lock but no answer. Pick Your Answer, or clear the row.");
      continue;
    }
    if (seen.has(row.holdId)) {
      problem("This hold appears twice in the sheet. Only the first row is read.");
      continue;
    }
    seen.add(row.holdId);

    if (!live) {
      problem("This is not waiting any more — it was decided already, or it is not a customer mapping.");
      continue;
    }
    const lock = readLock(row.rawLock);
    if (lock === null) {
      problem(`"${row.rawLock}" is not a lock answer. Use Yes or No, or leave it blank for Yes.`);
      continue;
    }
    if (!row.nowBrickId || row.nowBrickId !== live.liveBrickId.toUpperCase()) {
      problem(
        "The mapping changed after this sheet was exported (or the Now Brick ID column was edited). Export again and answer the fresh file.",
      );
      continue;
    }

    let destination: GuardGeo | null = live.wanted;
    if (answer === "move") {
      if (!row.moveToBrickId) {
        problem("Move to my brick needs a Brick ID in the next column.");
        continue;
      }
      const brick = input.bricks.get(row.moveToBrickId);
      if (!brick) {
        problem(`${row.moveToBrickId} is not an active brick. Pick one from the Bricks sheet.`);
        continue;
      }
      if (brick.brickId.toUpperCase() === live.liveBrickId.toUpperCase()) {
        problem("That is the brick it already sits in. To keep it there, answer Keep as is.");
        continue;
      }
      destination = brick;
    } else if (row.moveToBrickId) {
      problem("A Move To Brick ID was typed, but the answer is not Move to my brick. Fix one of the two.");
      continue;
    }

    ready.push({
      answer,
      customer,
      from: describeGeo(live.now, live.liveBrickId),
      holdId: row.holdId,
      lock,
      moveToBrickId: answer === "move" ? row.moveToBrickId : "",
      nowBrickId: live.liveBrickId.toUpperCase(),
      overridesRuling: live.ownerRuling && answer !== "keep",
      restatedValue: live.restatedValue,
      rowId: live.rowId,
      to: answer === "keep" ? "stays where it is" : describeGeo(destination, ""),
      trackedValue: live.trackedValue,
    });
  }

  ready.sort((a, b) => a.holdId - b.holdId);
  const pages: GuardPlanPage[] = [];
  for (let index = 0; index < ready.length; index += GUARD_APPLY_PAGE_SIZE) {
    const page = ready.slice(index, index + GUARD_APPLY_PAGE_SIZE);
    pages.push({ digest: guardPageDigest(page), holdIds: page.map((entry) => entry.holdId) });
  }

  return {
    counts: {
      allow: ready.filter((entry) => entry.answer === "allow").length,
      keep: ready.filter((entry) => entry.answer === "keep").length,
      locking: ready.filter((entry) => entry.lock).length,
      move: ready.filter((entry) => entry.answer === "move").length,
    },
    overridesRulings: ready.filter((entry) => entry.overridesRuling).length,
    pages,
    problems,
    restatedValue: ready.reduce((sum, entry) => sum + entry.restatedValue, 0),
    rows: ready,
    skipped,
    trackedValue: ready.reduce((sum, entry) => sum + entry.trackedValue, 0),
  };
}
