/**
 * The owner's decision sheet for the square-edge golden rule — every corner a session must not
 * decide on its own, in one workbook.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): business-fact
 * questions are asked as an XLSX with dropdowns, one row per item, with the context that makes the
 * call easy and a free-text Note column. "Which of these is a corner and which is a circle" is
 * exactly that shape of question.
 *
 * WHY THESE ROWS AND NOT THE OTHERS. The 2026-09-05 audit found rounding in three kinds of place:
 *
 *   1. Things the rule names outright — cards, buttons, tags, inputs, bars, avatars, badges. Those
 *      were squared in the same branch as this script and are NOT in here. Asking about them would
 *      be asking the owner to re-state a rule he already locked.
 *   2. Things a parallel branch settled while this ran. PR #3200 put the payslip on the house
 *      document identity and squared its 11 corners; PR #3209 squared the payroll glow bar and all
 *      six scrollbars. Those were rows here until they were answered in code — an answered question
 *      must not be re-asked, which is the rule that keeps these sheets getting replies at all.
 *   3. THESE. A decorative glow, a spinner ring, a design token, an email in a mail client.
 *      Squaring any of them would be a visible change nobody asked for, and reading the rule as
 *      covering them is an inference, not an instruction.
 *
 * NOTHING IS PADDED, and nothing is grouped any more either. The two bulk rows this sheet used to
 * carry — email and the marketing guide — were each ONE question about one medium or one file
 * rather than 21 and 37 copies of the same question. Both were answered on 2026-09-05, so every
 * remaining row is a single element the owner can picture without opening the code.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/square-edge-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately. ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" a workbook: `outlineProperties` together with
 * `pageSetup.fitToPage`, and `ws.addImage`. This sheet triggers neither, which is what keeps the
 * output openable without post-processing the zip. Do not add a logo here without reading that trap.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FFF97316";

/** Square it, or leave it alone. Two options, because there are two. */
const CORNER_OPTIONS = '"Square it,Leave it round"';


type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type CornerRow = {
  group: string;
  what: string;
  where: string;
  element: string;
  value: string;
  context: string;
  sites: number;
};

/**
 * Every corner still standing, with the reason it might legitimately stay.
 *
 * The `context` column is the whole point of the sheet: it is what makes each call answerable in a
 * few seconds without opening the code.
 */
const CORNERS: CornerRow[] = [
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
  sheet.columns = [{ width: 30 }, { width: 108 }];

  addTitle(
    sheet,
    2,
    "Square edges — the calls only you can make",
    "Your rule is 'no round or semi-round corners, anywhere'. Everything the rule names outright — "
      + "cards, buttons, tags, inputs, bars, avatars, badges — has already been squared and is NOT "
      + "in here. What is left is the handful of places where squaring would change something you "
      + "may not have meant to change.",
  );

  const rows: [string, string][] = [
    [
      "What you are deciding",
      "Each row is one thing that is still round. Set Decision to 'Square it' or 'Leave it round'. "
        + "Anything you leave blank stays exactly as it is today, so a half-finished sheet is safe to "
        + "send back.",
    ],
    [
      "Why these were not just squared",
      "A spinner and a glowing speck are circles, not corners. Squaring them would be a "
        + "visible change to the sign-in screen that you did not ask for. Guessing either way is "
        + "worse than asking once. (The scrollbars were a row here until PR #3209 squared them.)",
    ],
    [
      "Corners (9 rows)",
      "The sign-in screen's decorations, the identity card, the offer letter and email. "
        + "The 'What it looks like' column tells you what you are looking at without opening the code.",
    ],
    [
      "The radius tokens are done",
      "You set all six to 0 on 2026-09-05, so that sheet is gone — an answered question does not "
        + "come back. The scale keeps its names and every step now resolves to square, which is "
        + "what stops a newly copied screen inheriting a corner.",
    ],
    [
      "Every row is now one thing",
      "Nothing left is a bulk decision. The two that were — email (21 corners) and the marketing "
        + "guide (37) — you answered on 2026-09-05, and they are gone from here. Each of the nine "
        + "rows below is a single element you can picture.",
    ],
    [
      "What happens next",
      "Send the file back. Every 'Square it' becomes a code change; every 'Leave it round' is written "
        + "into the test that guards this, so nobody re-asks and no future session squares it by "
        + "accident.",
    ],
  ];

  let cursor = 4;
  for (const [label, body] of rows) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = body;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = 60;
    cursor += 1;
  }
}

function buildCorners(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Corners");
  sheet.columns = [
    { width: 18 },
    { width: 34 },
    { width: 46 },
    { width: 12 },
    { width: 62 },
    { width: 20 },
    { width: 40 },
  ];

  addTitle(
    sheet,
    7,
    `Corners still standing — ${CORNERS.length} decisions`,
    "Set Decision on each row. Blank means 'leave it exactly as it is'.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Group",
    "What it is",
    "What it looks like on screen",
    "Rounded by",
    "Where it lives",
    "Decision",
    "Note (anything you want to add)",
  ];
  styleHeader(sheet, headerRow);

  CORNERS.forEach((corner, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [
      corner.group,
      corner.sites > 1 ? `${corner.what}  (${corner.sites} corners)` : corner.what,
      corner.context,
      corner.value,
      `${corner.where}\n${corner.element}`,
      "",
      "",
    ];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 54;
    row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
    row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
  });

  // ONE sheet-level validation over the whole column. Setting `cell.dataValidation` per row makes
  // ExcelJS coalesce them into OVERLAPPING sqref ranges, which puts two validations on one cell and
  // is its own "we found a problem with some content" repair on open.
  const lastRow = headerRow + CORNERS.length;
  (sheet as SheetWithValidations).dataValidations.add(`F${headerRow + 1}:F${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [CORNER_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Square it, or leave it",
    error: "Choose 'Square it' to remove the rounding, or 'Leave it round' to keep it as it is today.",
  });

  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 7 } };
}

function nextFreePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = resolve("xlsx", `square-edge-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many square-edge question workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  // A SHEET WITH NOTHING LEFT ON IT IS NOT WRITTEN AT ALL.
  //
  // Every corner this sheet ever asked about has been answered — the scrollbars and the payroll glow
  // bar in code (#3209), the radius tokens, email, the marketing guide, and on 2026-09-05 the last
  // nine under "never rounded corners always shredded". Handing somebody a form that re-asks
  // answered questions is how the answers stop coming back, so this exits instead.
  //
  // The machinery is kept, not deleted: CORNERS is empty rather than gone. If a future audit turns
  // up a corner that is genuinely the owner's call, add the row and this runs again unchanged.
  if (CORNERS.length === 0) {
    console.log("Nothing outstanding — every square-edge decision has been answered. No workbook written.");
    console.log("The gate that holds the answers: tests/square-edge-golden-rule.test.ts");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — square-edge audit";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildCorners(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const totalSites = CORNERS.reduce((sum, corner) => sum + corner.sites, 0);
  console.log(`Wrote ${outputPath}`);
  console.log(`${CORNERS.length} corner decisions covering ${totalSites} declarations.`);
}

await main();
