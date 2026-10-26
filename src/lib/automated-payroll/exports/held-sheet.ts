import type ExcelJS from "exceljs";

import { HELD_ROW_NOTE } from "@/lib/payroll/payroll-sheet-style";
import { BLACK, SLATE, VALUE_FMT, WHITE, ZEBRA } from "@/lib/sales/sales-workbook-kit";

import type { AssembledRow } from "../assemble.ts";
import { HELD_NO_REASON_COMMENT, normalizeHoldReason } from "../hold-reason.ts";
import type { HeldBalance, HeldSettlement } from "../held-settlements.ts";
import type { MonthlySalaryRun } from "../types.ts";

/** The Phoenix held treatment, matching exports/sheet.ts exactly — red type on a pale red ground. */
const HELD_FILL = "FFFEE2E2";
const HELD_TEXT = "FF991B1B";

/**
 * The "Held" tab — owner request 2026-09-10: "I want to make an extra tab in the exported payroll
 * sheet that holds only the holded people."
 *
 * WHY A TAB AND NOT THE COVER. Held people were already named on the cover, one key/value line
 * each, wedged between the run's counts. That works for three names and falls apart at twenty:
 * production held 20 people in August 2026, so the cover carried 20 prose lines with the money
 * buried inside a sentence and nothing addable. A held person is a row of figures — what they were
 * already paid, what is owed, what was settled by hand — and a row of figures belongs in a table.
 * The cover lines stay, because the cover is what someone reads first.
 *
 * TWO SECTIONS, ANSWERING TWO DIFFERENT QUESTIONS:
 *
 *   1. HELD THIS MONTH — who this run is not paying, and whether the money has since been
 *      transferred outside payroll.
 *   2. STILL OWED FROM EARLIER MONTHS — the same question for every previous published month whose
 *      held amount has NOT been recorded as settled. This is the half that answers "the next
 *      payroll they should not be added": open this month's sheet and last month's unsettled holds
 *      are on it, by name, with the amount.
 *
 * THE PHOENIX LOOK, NOT THE HOUSE ONE. Calibri, a filled black header band, the Phoenix zebra, and
 * the red held treatment — the same inline styling every other sheet in this workbook uses, from
 * `sales-workbook-kit`. The automated payroll exports are exempt from the house document identity
 * (owner, 2026-09-08) and `tests/payroll-phoenix-look.test.ts` fails on ANY house colour or typeface
 * anywhere in these workbooks.
 *
 * This file first shipped using the house-styled helpers in `payroll-sheet-style.ts` — which look
 * like the obvious "shared payroll style" and are not: they carry the house palette and masthead.
 * That lock test caught it before it reached the owner, which is exactly what it exists for.
 */

type HeldColumn = {
  header: string;
  width: number;
  money?: boolean;
};

const COLUMNS: HeldColumn[] = [
  { header: "HR ID", width: 12 },
  { header: "Employee", width: 38 },
  { header: "Job Title", width: 26 },
  { header: "Line", width: 16 },
  { header: "Reason held", width: 46 },
  { header: "Part 1 already paid", width: 17, money: true },
  { header: "Withheld (owed)", width: 14, money: true },
  { header: "Settled outside payroll", width: 18, money: true },
  { header: "Settled on", width: 13 },
  { header: "Method / reference", width: 30 },
  { header: "Still outstanding", width: 16, money: true },
];

type HeldTabRow = {
  hrId: string;
  name: string;
  jobTitle: string;
  line: string;
  reason: string;
  firstPartAlreadyPaid: number;
  secondPartOwed: number;
  settled: HeldSettlement | null;
  outstanding: number;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function fromAssembled(entry: AssembledRow, settled: HeldSettlement | null): HeldTabRow {
  // Held when Part 1 was confirmed: the Part 1 bank files left this person out, so nothing has been
  // paid and both instalments are owed (owner, 2026-10-26). A run confirmed before that was recorded
  // reads as before — Part 1 paid — the same rule publish records, so the tab and the record agree.
  const part1Withheld = entry.part1Withheld === true;
  const alreadyPaid = part1Withheld ? 0 : round(entry.row.firstPart);
  const owed = part1Withheld ? round(entry.row.firstPart + entry.row.secondPart) : round(entry.row.secondPart);
  return {
    hrId: entry.row.hrId,
    name: entry.row.fullName,
    jobTitle: entry.row.jobTitle ?? "",
    line: entry.row.line ?? "",
    // The same reason the cover and the payroll row show, through the same helper, so a reason that
    // says nothing announces itself here too instead of rendering as an empty cell.
    reason: normalizeHoldReason(entry.row.payrollComment) ?? HELD_NO_REASON_COMMENT,
    firstPartAlreadyPaid: alreadyPaid,
    secondPartOwed: owed,
    settled,
    outstanding: Math.max(0, round(owed - (settled?.amount ?? 0))),
  };
}

function fromBalance(balance: HeldBalance): HeldTabRow {
  return {
    hrId: balance.hrId,
    name: balance.name,
    jobTitle: "",
    line: "",
    reason: balance.reason ?? HELD_NO_REASON_COMMENT,
    firstPartAlreadyPaid: balance.firstPartAlreadyPaid,
    // Everything this month withheld: Part 2, Part 1 when it was never paid, and pay deferred to later.
    secondPartOwed: round(balance.secondPartWithheld + balance.firstPartWithheld + balance.deferred),
    settled: balance.settled,
    outstanding: balance.outstanding,
  };
}

function methodAndReference(settled: HeldSettlement | null): string {
  if (!settled) return "";
  return [settled.method, settled.reference].map((part) => (part ?? "").trim()).filter(Boolean).join(" · ");
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function periodLabel(month: number, year: number): string {
  return `${MONTH_NAMES[Math.max(0, Math.min(11, month - 1))] ?? ""} ${year}`.trim();
}

/**
 * Append the Held tab.
 *
 * Written even when nobody is held. An empty tab that says "nobody was held this month" is a
 * different statement from a missing tab, and on a payroll pack the difference matters: a reader
 * who cannot find the tab does not conclude that nothing was withheld, they conclude the export is
 * incomplete.
 */
export function addHeldSheet(
  workbook: ExcelJS.Workbook,
  input: {
    run: MonthlySalaryRun;
    rows: AssembledRow[];
    /** Settlements recorded against THIS run, keyed by compact HR id. */
    settlements?: Map<string, HeldSettlement>;
    /** Unsettled held money from earlier published months. */
    priorBalances?: HeldBalance[];
  },
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet("Held");
  sheet.views = [{ showGridLines: false }];
  const settlements = input.settlements ?? new Map<string, HeldSettlement>();
  const priorBalances = (input.priorBalances ?? []).filter((balance) => balance.outstanding > 0);

  const thisMonth = input.rows
    .filter((entry) => entry.onHold)
    .map((entry) => fromAssembled(entry, settlements.get(entry.compact) ?? null))
    .sort((a, b) => b.outstanding - a.outstanding);

  COLUMNS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  // ── Title band: filled black, Calibri, white type — the Phoenix masthead ──────────────────────
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `Held — not paid by this run · ${periodLabel(input.run.month, input.run.year)}`;
  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  titleCell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 12 };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  for (let column = 1; column <= COLUMNS.length; column += 1) {
    sheet.getCell(1, column).fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
  }
  sheet.getRow(1).height = 22;

  const explain = sheet.getCell(2, 1);
  explain.value =
    "A held row is dropped at publish: no payslip is written, and the money is paid outside this " +
    "system or not at all. When Part 1 was already transferred only Part 2 is owed — paying the full " +
    "net would pay Part 1 twice; someone held when Part 1 was confirmed was paid nothing, so both are " +
    "owed. Record a transfer against the person so the next month does not " +
    "work the same amount up again; anything with a figure under Still outstanding has no such record.";
  sheet.mergeCells(2, 1, 2, COLUMNS.length);
  explain.font = { color: { argb: SLATE }, name: "Calibri", size: 9 };
  explain.alignment = { horizontal: "left", vertical: "top", wrapText: true };
  sheet.getRow(2).height = 42;

  let row = 4;

  const writeSection = (title: string, entries: HeldTabRow[], emptyMessage: string) => {
    const heading = sheet.getCell(row, 1);
    heading.value = title;
    sheet.mergeCells(row, 1, row, COLUMNS.length);
    heading.font = { bold: true, color: { argb: BLACK }, name: "Calibri", size: 10.5 };
    heading.alignment = { horizontal: "left", vertical: "middle" };
    row += 1;

    if (entries.length === 0) {
      const cell = sheet.getCell(row, 1);
      cell.value = emptyMessage;
      sheet.mergeCells(row, 1, row, COLUMNS.length);
      cell.font = { color: { argb: SLATE }, name: "Calibri", size: 10 };
      cell.alignment = { horizontal: "left", vertical: "middle" };
      row += 2;
      return;
    }

    // Header band: filled black, white Calibri — the same bar every payroll sheet uses.
    COLUMNS.forEach((column, index) => {
      const cell = sheet.getCell(row, index + 1);
      cell.value = column.header;
      cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
      cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: column.money ? "right" : "left", vertical: "middle", wrapText: true };
    });
    sheet.getRow(row).height = 26;
    row += 1;

    entries.forEach((entry, entryIndex) => {
      const values: Array<string | number> = [
        entry.hrId,
        entry.name,
        entry.jobTitle,
        entry.line,
        entry.reason,
        entry.firstPartAlreadyPaid,
        entry.secondPartOwed,
        entry.settled ? entry.settled.amount : "",
        entry.settled ? entry.settled.paidOn : "",
        methodAndReference(entry.settled),
        entry.outstanding,
      ];
      const zebra = entryIndex % 2 === 1;
      values.forEach((value, index) => {
        const column = COLUMNS[index];
        const cell = sheet.getCell(row, index + 1);
        cell.value = value;
        // Every row on this tab is held by definition, so the red held treatment is the baseline
        // here rather than an exception to it.
        cell.font = { bold: true, color: { argb: HELD_TEXT }, name: "Calibri", size: 10 };
        cell.alignment = { horizontal: column?.money ? "right" : "left", vertical: "middle" };
        cell.fill = {
          fgColor: { argb: zebra ? ZEBRA : HELD_FILL },
          pattern: "solid",
          type: "pattern",
        };
        if (column?.money && typeof value === "number") cell.numFmt = VALUE_FMT;
      });
      // The note travels with the row, so the meaning of "held" cannot be lost by copying a range
      // out of this tab — the one held signal that survives greyscale and a paste.
      sheet.getCell(row, 1).note = HELD_ROW_NOTE;
      row += 1;
    });

    // Totals, because the reason this is a tab and not prose is that the figures have to add up.
    const totals = new Map<number, number>([
      [6, entries.reduce((sum, entry) => sum + entry.firstPartAlreadyPaid, 0)],
      [7, entries.reduce((sum, entry) => sum + entry.secondPartOwed, 0)],
      [8, entries.reduce((sum, entry) => sum + (entry.settled?.amount ?? 0), 0)],
      [11, entries.reduce((sum, entry) => sum + entry.outstanding, 0)],
    ]);
    for (let column = 1; column <= COLUMNS.length; column += 1) {
      const cell = sheet.getCell(row, column);
      if (column === 1) cell.value = "TOTAL";
      const total = totals.get(column);
      if (total !== undefined) {
        cell.value = round(total);
        cell.numFmt = VALUE_FMT;
      }
      cell.font = { bold: true, color: { argb: WHITE }, name: "Calibri", size: 10.5 };
      cell.fill = { fgColor: { argb: BLACK }, pattern: "solid", type: "pattern" };
      cell.alignment = { horizontal: totals.has(column) ? "right" : "left", vertical: "middle" };
    }
    row += 2;
  };

  writeSection(
    "Held this month",
    thisMonth,
    "Nobody is held this month. Every employee on the payroll sheet is paid by this run.",
  );

  const priorRows = priorBalances.map(fromBalance).sort((a, b) => b.outstanding - a.outstanding);
  writeSection(
    "Still owed from earlier months — never recorded as transferred",
    priorRows,
    "Nothing outstanding from earlier months: every previously held amount has been recorded as transferred.",
  );

  // Provenance for the second section, which is the one a reader is most likely to challenge.
  if (priorRows.length > 0) {
    const cell = sheet.getCell(row, 1);
    cell.value =
      "Earlier months are listed from the record written when each run was published, and drop off " +
      "this list only when someone records the transfer against that person. Months: " +
      Array.from(new Set(priorBalances.map((balance) => periodLabel(balance.month, balance.year)))).join(", ");
    sheet.mergeCells(row, 1, row, COLUMNS.length);
    cell.font = { color: { argb: SLATE }, name: "Calibri", size: 9 };
    cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    sheet.getRow(row).height = 28;
  }

  return sheet;
}
