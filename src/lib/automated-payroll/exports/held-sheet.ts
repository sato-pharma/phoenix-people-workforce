import type ExcelJS from "exceljs";

import {
  HELD_ROW_NOTE,
  payrollBodyCell,
  payrollHeaderCell,
  payrollTotalsCell,
  writePayrollSheetMasthead,
} from "@/lib/payroll/payroll-sheet-style";

import type { AssembledRow } from "../assemble.ts";
import { HELD_NO_REASON_COMMENT, normalizeHoldReason } from "../hold-reason.ts";
import type { HeldBalance, HeldSettlement } from "../held-settlements.ts";
import type { MonthlySalaryRun } from "../types.ts";

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
 * Every colour, rule and font here comes from the shared payroll style helpers, never from a
 * literal. This tab therefore wears whatever identity its sibling sheets wear and cannot drift from
 * them — which matters, because that identity is owner-locked and pinned by its own test.
 */

type HeldColumn = {
  header: string;
  width: number;
  numeric?: boolean;
};

const COLUMNS: HeldColumn[] = [
  { header: "HR ID", width: 12 },
  { header: "Employee", width: 38 },
  { header: "Job Title", width: 26 },
  { header: "Line", width: 16 },
  { header: "Reason held", width: 46 },
  { header: "Part 1 already paid", width: 17, numeric: true },
  { header: "Part 2 owed", width: 14, numeric: true },
  { header: "Settled outside payroll", width: 18, numeric: true },
  { header: "Settled on", width: 13 },
  { header: "Method / reference", width: 30 },
  { header: "Still outstanding", width: 16, numeric: true },
];

/** A held person as this tab needs them, from either source. */
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
  const owed = round(entry.row.secondPart);
  return {
    hrId: entry.row.hrId,
    name: entry.row.fullName,
    jobTitle: entry.row.jobTitle ?? "",
    line: entry.row.line ?? "",
    // The same reason the cover and the payroll row show, resolved through the same helper, so a
    // reason that says nothing announces itself here too instead of rendering as an empty cell.
    reason: normalizeHoldReason(entry.row.payrollComment) ?? HELD_NO_REASON_COMMENT,
    firstPartAlreadyPaid: round(entry.row.firstPart),
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
    secondPartOwed: balance.secondPartWithheld,
    settled: balance.settled,
    outstanding: balance.outstanding,
  };
}

function methodAndReference(settled: HeldSettlement | null): string {
  if (!settled) return "";
  const parts = [settled.method, settled.reference].map((part) => (part ?? "").trim()).filter(Boolean);
  return parts.join(" · ");
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
 * The sheet is written even when nobody is held. An empty tab that says "nobody was held this
 * month" is a different statement from a missing tab, and on a payroll pack the difference matters:
 * a reader who cannot find the tab does not conclude that nothing was withheld, they conclude the
 * export is incomplete.
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
  const settlements = input.settlements ?? new Map<string, HeldSettlement>();
  const priorBalances = (input.priorBalances ?? []).filter((balance) => balance.outstanding > 0);

  const thisMonth = input.rows
    .filter((entry) => entry.onHold)
    .map((entry) => fromAssembled(entry, settlements.get(entry.compact) ?? null))
    .sort((a, b) => b.outstanding - a.outstanding);

  writePayrollSheetMasthead(workbook, sheet, {
    columns: COLUMNS.length,
    title: "Held — not paid by this run",
    subtitle: `${periodLabel(input.run.month, input.run.year)} · ${thisMonth.length} held this month`,
  });

  COLUMNS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  let row = (sheet.lastRow?.number ?? 1) + 2;

  const writeExplainer = () => {
    const cell = sheet.getCell(row, 1);
    cell.value =
      "A held row is dropped at publish: no payslip is written, and the money is paid outside this " +
      "system or not at all. Part 1 was already transferred, so only Part 2 is owed — paying the " +
      "full net would pay Part 1 twice. Record a transfer against the person so the next month " +
      "does not work the same amount up again; anything with a figure under Still outstanding has " +
      "no such record.";
    sheet.mergeCells(row, 1, row, COLUMNS.length);
    cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    sheet.getRow(row).height = 42;
    row += 2;
  };
  writeExplainer();

  const writeSection = (title: string, entries: HeldTabRow[], emptyMessage: string) => {
    const titleCell = sheet.getCell(row, 1);
    titleCell.value = title;
    payrollHeaderCell(titleCell);
    sheet.mergeCells(row, 1, row, COLUMNS.length);
    row += 1;

    if (entries.length === 0) {
      const cell = sheet.getCell(row, 1);
      cell.value = emptyMessage;
      sheet.mergeCells(row, 1, row, COLUMNS.length);
      cell.alignment = { horizontal: "left", vertical: "middle" };
      row += 2;
      return;
    }

    COLUMNS.forEach((column, index) => {
      const cell = sheet.getCell(row, index + 1);
      cell.value = column.header;
      payrollHeaderCell(cell, { numeric: column.numeric });
    });
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
      values.forEach((value, index) => {
        const cell = sheet.getCell(row, index + 1);
        cell.value = value;
        payrollBodyCell(cell, {
          zebra: entryIndex % 2 === 1,
          numeric: COLUMNS[index]?.numeric,
          // Every row on this tab is held by definition, so the held treatment is the row's
          // baseline here rather than an exception to it.
          held: true,
          leading: index === 0,
        });
      });
      // The note travels with the row, so the meaning of "held" cannot be lost by copying a range
      // out of this tab — the one held signal that survives both greyscale and a paste.
      sheet.getCell(row, 1).note = HELD_ROW_NOTE;
      row += 1;
    });

    // Totals, because the reason this is a tab and not prose is that the figures have to add up.
    const totals: Array<[number, number]> = [
      [6, entries.reduce((sum, entry) => sum + entry.firstPartAlreadyPaid, 0)],
      [7, entries.reduce((sum, entry) => sum + entry.secondPartOwed, 0)],
      [8, entries.reduce((sum, entry) => sum + (entry.settled?.amount ?? 0), 0)],
      [11, entries.reduce((sum, entry) => sum + entry.outstanding, 0)],
    ];
    const labelCell = sheet.getCell(row, 1);
    labelCell.value = "TOTAL";
    payrollTotalsCell(labelCell);
    for (let column = 2; column <= COLUMNS.length; column += 1) {
      const cell = sheet.getCell(row, column);
      const total = totals.find(([index]) => index === column);
      if (total) cell.value = round(total[1]);
      payrollTotalsCell(cell, { numeric: Boolean(total) || Boolean(COLUMNS[column - 1]?.numeric) });
    }
    row += 2;
  };

  writeSection(
    "Held this month",
    thisMonth,
    "Nobody is held this month. Every employee on the payroll sheet is paid by this run.",
  );

  const priorRows = priorBalances
    .map(fromBalance)
    .sort((a, b) => b.outstanding - a.outstanding);
  writeSection(
    "Still owed from earlier months — never recorded as transferred",
    priorRows,
    "Nothing outstanding from earlier months: every previously held amount has been recorded as transferred.",
  );

  // Provenance for the second section, which is the one a reader is most likely to challenge.
  if (priorRows.length > 0) {
    const cell = sheet.getCell(row, 1);
    cell.value =
      "Earlier months are listed from the record written when each run was published, and are " +
      "removed from this list only when someone records the transfer against that person. " +
      "Months: " +
      Array.from(new Set(priorBalances.map((balance) => periodLabel(balance.month, balance.year)))).join(", ");
    sheet.mergeCells(row, 1, row, COLUMNS.length);
    cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    sheet.getRow(row).height = 28;
  }

  return sheet;
}
