/**
 * The August 2026 payroll cannot publish until every held row carries a hold reason.
 *
 * `assertHoldReasonsPresent` is a hard gate, and since PR #3333 it also runs at `confirmStep`, so
 * the run is stuck at part 2 with 13 held rows and no reason on any of them. July published with 15
 * held and 3 reasonless, which is why this never bit before — the second call site is new.
 *
 * WHY THIS IS A SHEET AND NOT A QUESTION IN CHAT. Owner rule: a business-fact question with one row
 * per item goes out as an xlsx with a locked dropdown, carrying the context that makes the call
 * easy. Thirteen people, one decision each.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: a computed "you still owe X" figure. A held row is owed the
 * SECOND PART ONLY, and the arithmetic that produces it lives in the payroll engine and must be
 * validated against PUBLISHED rows — inventing it here and printing it beside a person's name is
 * how a number nobody checked becomes a transfer. The sheet carries the raw facts the engine itself
 * stored (base for the month, days worked, the first part already frozen) and asks the one question
 * only the owner can answer.
 *
 * The dropdown options are HIS OWN PRIOR WORDING, read out of the hold reasons already on
 * production rather than invented: "Paid outside the system", "Not paid through this system at all;
 * KEEP ON HOLD", "ALready transfered". An option list a person recognises gets answered.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const WARN_FILL = "FFFEF3C7";

const RUN_ID = "715d41fa-1c0e-4387-ab01-e1eb4824a6cb";

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: Record<string, unknown>) => void };
};

// NO COMMA inside any option — Excel's inline list is comma-separated, so a comma in an option
// silently splits it into two choices. Kept under 255 characters, which is Excel's cap on an
// inline list; a longer one is dropped and the cell ends up with no dropdown at all.
const HOLD_OPTIONS =
  '"Paid outside the system — do not pay again,'
  + "Not paid through this system at all — KEEP ON HOLD,"
  + "Already transferred — do not pay again,"
  + "Release the hold — pay the second part in this run,"
  + 'Other — see my note"';

type HoldRow = {
  hrId: string;
  name: string;
  jobTitle: string;
  status: string;
  lastWorkingDate: string | null;
  baseForMonth: number | null;
  daysWorked: number | null;
  firstPartFrozen: number;
  note: string;
};

/**
 * Read from production on 2026-09-06 for run 715d41fa (month_key 2026-08, phase part2). The two
 * ACTIVE people are listed first deliberately: a leaver on hold is the ordinary case — settled
 * outside the system on the way out — while an ACTIVE employee on hold is a different question,
 * and putting them in date order would bury both in the middle of the list.
 */
const ROWS: HoldRow[] = [
  {
    hrId: "AI-0011",
    name: "Mohamed Khaled",
    jobTitle: "Medical Representative",
    status: "ACTIVE — still employed",
    lastWorkingDate: null,
    baseForMonth: 6774.19,
    daysWorked: 15,
    firstPartFrozen: 7983.87,
    note: "STILL EMPLOYED and on hold, which is the unusual case here. 15 days on the month, so a part month rather than a full one.",
  },
  {
    hrId: "B-156",
    name: "Sara Samir Jacoub Yohana",
    jobTitle: "District Sales Manager",
    status: "ACTIVE — still employed",
    lastWorkingDate: null,
    baseForMonth: null,
    daysWorked: null,
    firstPartFrozen: 19600,
    note: "STILL EMPLOYED and on hold. NO BASE AND NO DAYS on the row — an empty salary figure is not refused by the run, it prices at nothing, silently. Worth a look whichever way you rule.",
  },
  {
    hrId: "CN-0005",
    name: "Amira Samy",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-08",
    baseForMonth: 3870.97,
    daysWorked: 8,
    firstPartFrozen: 4516.13,
    note: "Left on the 8th. First part already frozen above the month's base.",
  },
  {
    hrId: "B-3",
    name: "Ahmed Helal Eliwa Hussenin",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-09",
    baseForMonth: 4790.32,
    daysWorked: 9,
    firstPartFrozen: 2201.61,
    note: "Left on the 9th.",
  },
  {
    hrId: "B-144",
    name: "Mariam Mohamed Abdelhalim Hamed Farahat",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-09",
    baseForMonth: 4064.52,
    daysWorked: 9,
    firstPartFrozen: 1679.91,
    note: "Left on the 9th. The only row edited since the run was built (2026-09-04), so something was already looked at here.",
  },
  {
    hrId: "B-167",
    name: "Mahmoud Mohamed Hassan Eltanany",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-10",
    baseForMonth: 5322.58,
    daysWorked: 10,
    firstPartFrozen: 5332.13,
    note: "Left on the 10th.",
  },
  {
    hrId: "B-164",
    name: "Essam Mohamed Youssef Elsayed",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-17",
    baseForMonth: 8225.81,
    daysWorked: 17,
    firstPartFrozen: 9390.77,
    note: "Left on the 17th.",
  },
  {
    hrId: "PD-0006",
    name: "Ahmed Mohamed Nagy",
    jobTitle: "District Sales Manager",
    status: "Resigned",
    lastWorkingDate: "2026-08-20",
    baseForMonth: 18387.1,
    daysWorked: 20,
    firstPartFrozen: 19950,
    note: "Left on the 20th. The largest first part among the leavers.",
  },
  {
    hrId: "CN-0004",
    name: "Engy Said Mohamed Elsayed",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-26",
    baseForMonth: 14677.42,
    daysWorked: 26,
    firstPartFrozen: 12250,
    note: "Left on the 26th.",
  },
  {
    hrId: "B-25",
    name: "Hayam Mohamed Eladl FaragAllah Hefnawy",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-31",
    baseForMonth: null,
    daysWorked: null,
    firstPartFrozen: 11550,
    note: "Worked the whole month and left on the last day. NO BASE AND NO DAYS on the row — that prices at nothing rather than being refused.",
  },
  {
    hrId: "B-82",
    name: "Mostafa Mamdouh Mohamed Ibrahim Kasem",
    jobTitle: "Medical Representative",
    status: "Resigned",
    lastWorkingDate: "2026-08-31",
    baseForMonth: 15000,
    daysWorked: 31,
    firstPartFrozen: 10500,
    note: "Worked the whole month and left on the last day.",
  },
  {
    hrId: "B-23",
    name: "Yehya Mohamed Kamal eldeen Saad Mohamed",
    jobTitle: "District Sales Manager",
    status: "Resigned",
    lastWorkingDate: "2026-08-31",
    baseForMonth: null,
    daysWorked: null,
    firstPartFrozen: 21700,
    note: "Worked the whole month and left on the last day. NO BASE AND NO DAYS on the row — that prices at nothing rather than being refused. The largest first part on the sheet.",
  },
  {
    hrId: "A-16",
    name: "Youmna Mohamed Salaheldeen Ahmed Kotb",
    jobTitle: "Talent Acquisition",
    status: "Resigned",
    lastWorkingDate: "2026-08-31",
    baseForMonth: 17000,
    daysWorked: 31,
    firstPartFrozen: 18747,
    note: "Worked the whole month and left on the last day.",
  },
];

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = sheet.getRow(rowNumber);
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  row.height = 30;
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
  sheet.getRow(2).height = 46;
}

function buildReadMe(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 108 }];

  addTitle(
    sheet,
    2,
    "August 2026 payroll — 13 held rows with no reason",
    "The August run is stuck at part 2 and cannot publish until every held row carries a reason. "
      + "Nothing else is blocking the month. One decision per person, thirteen in total.",
  );

  const rows: [string, string][] = [
    [
      "Why the month is stuck",
      "A held row must carry a hold reason before the run will publish. That check now also runs "
        + "when a step is confirmed, which is new — July went out with 3 held rows that had no "
        + "reason, and that is no longer possible. All 13 of August's held rows are blank.",
    ],
    [
      "🔴 What a hold actually does",
      "A held row is DROPPED at publish. No salary record is written for that person, and nothing "
        + "in the system records that they were paid another way. That is the intended behaviour — "
        + "it is how somebody paid outside the system stays out of the payroll file — but it means "
        + "the reason you type here is the ONLY record of what happened.",
    ],
    [
      "🔴 Held means the SECOND PART only",
      "Everyone on this sheet has already had their first part transferred — the amount is in the "
        + "'First part already paid' column. If a held person is paid their full monthly net now, "
        + "the first part is paid twice. Whatever you release, it is the second part.",
    ],
    [
      "What this sheet does not tell you",
      "It carries no 'still owed' figure. That number comes out of the payroll engine and has to be "
        + "checked against published rows; a figure computed in a spreadsheet and printed next to "
        + "somebody's name is how an unchecked number becomes a transfer. The facts here are the "
        + "ones the run itself stored.",
    ],
    [
      "The two active people",
      "Eleven of the thirteen resigned during August, which is the ordinary reason for a hold. Two "
        + "are STILL EMPLOYED — Mohamed Khaled (AI-0011) and Sara Samir (B-156) — and they are at "
        + "the top of the list rather than in date order, because a hold on somebody still working "
        + "is a different question from a leaver's final settlement.",
    ],
    [
      "Three rows carry no salary figure",
      "B-156, B-25 and B-23 have no base and no days on the row. An empty salary figure is not "
        + "refused by the run — it prices at nothing, quietly. It does not change what you decide "
        + "here, but it is worth knowing before releasing any of those three.",
    ],
    [
      "How to answer",
      "Pick one option in 'Your decision'. If none of them fits, pick 'Other — see my note' and "
        + "write it in the Note column. A blank row keeps the person on hold and the month stays "
        + "blocked, so a half-finished sheet is safe to send back — it just does not unblock "
        + "August until every row has an answer.",
    ],
    [
      "What happens after you send it back",
      "Each answer is written to that person's hold reason on run 715d41fa, exactly as worded, with "
        + "a pre-image taken first. Nothing is paid, released or published by this sheet — filling "
        + "it in only removes the thing stopping the run.",
    ],
  ];

  const headerRow = 4;
  sheet.getRow(headerRow).values = ["", ""];
  rows.forEach(([label, body], index) => {
    const row = sheet.getRow(headerRow + index);
    row.values = [label, body];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 58;
    row.getCell(1).font = { bold: true, size: 11 };
  });
}

function buildDecisions(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Decisions");
  sheet.columns = [
    { width: 11 },
    { width: 42 },
    { width: 24 },
    { width: 22 },
    { width: 14 },
    { width: 13 },
    { width: 11 },
    { width: 20 },
    { width: 62 },
    { width: 46 },
    { width: 38 },
  ];

  addTitle(
    sheet,
    11,
    `August 2026 held rows — ${ROWS.length} decisions`,
    "Every person here has already had their first part paid. Pick a decision on each row. Read "
      + "the 'Read me' tab first if you have not — a hold is dropped at publish and leaves no other "
      + "record, so the reason you write is the record.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "HR ID",
    "Name",
    "Job title",
    "Status",
    "Last day",
    "Base for month",
    "Days",
    "First part already paid",
    "What is worth knowing",
    "Your decision",
    "Note (anything you want to add)",
  ];
  styleHeader(sheet, headerRow);

  ROWS.forEach((entry, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [
      entry.hrId,
      entry.name,
      entry.jobTitle,
      entry.status,
      entry.lastWorkingDate ?? "—",
      entry.baseForMonth ?? "— none on the row",
      entry.daysWorked ?? "—",
      entry.firstPartFrozen,
      entry.note,
      "",
      "",
    ];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 56;

    if (typeof entry.baseForMonth === "number") row.getCell(6).numFmt = "#,##0.00";
    row.getCell(8).numFmt = "#,##0.00";

    // The two still-employed people, and any row with no salary figure, are tinted so they are not
    // answered on autopilot along with the leavers.
    const needsALook = entry.status.startsWith("ACTIVE") || entry.baseForMonth === null;
    if (needsALook) {
      for (let column = 1; column <= 9; column += 1) {
        row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WARN_FILL } };
      }
    }

    row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    row.getCell(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const firstRow = headerRow + 1;
  const lastRow = headerRow + ROWS.length;

  // ONE validation across the whole contiguous run — never one per cell. Setting
  // `cell.dataValidation` per row makes ExcelJS coalesce them into OVERLAPPING sqref ranges, which
  // puts two validations on one cell and is its own "we found a problem with some content" repair
  // on open. Every row here shares one option list, so it is a single range by construction.
  (sheet as SheetWithValidations).dataValidations.add(`J${firstRow}:J${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [HOLD_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Pick one, or choose Other",
    error: "Choose a decision from the list, or pick 'Other — see my note' and write it in the Note column.",
  });

  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 11 } };
}

function nextFreePath(): string {
  // Africa/Cairo, not UTC. `toISOString()` would date the file a day early for the ~3 hours after
  // Cairo midnight — which is exactly when this repository is often worked — and every date the
  // owner sees is Cairo local by standing rule.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `august-payroll-hold-reasons-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many hold-reason workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  if (ROWS.length === 0) {
    console.log("Nothing held without a reason — August is not blocked on this. No workbook written.");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — August 2026 payroll hold reasons";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildDecisions(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const active = ROWS.filter((row) => row.status.startsWith("ACTIVE")).length;
  const noFigure = ROWS.filter((row) => row.baseForMonth === null).length;
  console.log(`Wrote ${outputPath}`);
  console.log(`${ROWS.length} held rows on run ${RUN_ID} (2026-08, part 2).`);
  console.log(`  ${ROWS.length - active} resigned during August, ${active} still employed.`);
  console.log(`  ${noFigure} carry no base salary figure on the row.`);
}

await main();
