/**
 * The owner's decision sheet for the two KPI reports — the four numbers a session must not invent.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): business-fact
 * questions are asked as an XLSX with dropdowns, one row per item, with the context that makes the
 * call easy and a free-text Note column. "What should a pharmacy be held to" is exactly that shape
 * of question — it is a business standard, not something the code can derive.
 *
 * WHY THESE ROWS AND NOT THE OTHERS. The owner asked for two KPI reports per rep on 2026-09-05:
 * AM/PM, and pharmacies. Three of the six numbers each report needs already exist and are NOT in
 * here — asking about them would be asking him to re-state what he already said:
 *
 *   - AM call rate = 2 a day, PM = the 8-12 band     ("8-12 pm only and 2 am accounts")
 *   - AM/PM coverage floor = 95%
 *   - PM frequency norms = A:2, B:1, C:1             (live in doctor_coverage_config.norms.sp)
 *
 * What is left is the pharmacy half, which has never been priced at all, plus one question about
 * AM. Every one of them is `null` in DEFAULT_REP_KPI_STANDARDS and renders as "Not scored" until
 * he answers — the reports ship and are readable meanwhile, they simply carry no verdict on those
 * numbers. Nothing here is padded to reach a count.
 *
 * WHY AM AND PHARMACY CANNOT SHARE ONE ANSWER. Both are `hcp` under the SP/HCP cut that
 * doctor_coverage_config keys off, so today one stored number would answer questions 2 and 4 at
 * once. They are different populations — 1,872 pharmacies against 887 hospital, contract and
 * insurance accounts — and a session that lets one number cover both makes it impossible for them
 * ever to differ. That is why the reports split on `list_type` and why these are separate rows.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/kpi-standards-questions.ts
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
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";

/** Every option list ends with an escape hatch, so a number nobody guessed is still answerable. */
const RATE_OPTIONS = '"Not scored — leave it as it is,1 a day,2 a day,3 a day,4 a day,5 a day,6 a day,Other — see my note"';
const NORM_OPTIONS = '"Not scored — leave it as it is,1 visit a month,2 visits a month,3 visits a month,4 visits a month,Other — see my note"';
const FLOOR_OPTIONS = '"Not scored — leave it as it is,50%,60%,70%,80%,90%,95%,Other — see my note"';

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type QuestionRow = {
  /** Which of the two reports this number belongs to. */
  report: string;
  question: string;
  /** What the system does with this number today. Always "Not scored" here — that is the point. */
  today: string;
  /** What the field force actually did in August 2026, measured on production. */
  measured: string;
  /** The one or two sentences that make the call answerable without opening anything. */
  context: string;
  options: string;
};

/**
 * The four open questions, as six rows — one row per decision, because a frequency norm is set per
 * grade and a grade is the unit he actually prices.
 *
 * Every figure in `measured` was read off production on 2026-09-05 for August 2026, on regular
 * Saturday-to-Wednesday visits with the catch-all contact 100000 excluded.
 */
const QUESTIONS: QuestionRow[] = [
  {
    report: "2 — Pharmacies",
    question: "How many pharmacy calls should a rep make per working day?",
    today: "Not scored — the report shows his real rate with no verdict beside it",
    measured: "1.88 a day, across the 30 reps who logged any pharmacy call at all",
    context:
      "This is the pharmacy twin of 'AM = 2 a day, PM = 8-12'. There is no pharmacy equivalent "
      + "anywhere in the system, so today the report can show what a rep did but not whether it "
      + "was enough. 44 reps carry a pharmacy list; 25 carry none, and those are shown as 'not "
      + "applicable' rather than judged.",
    options: RATE_OPTIONS,
  },
  {
    report: "2 — Pharmacies",
    question: "How many times a month should a GRADE A pharmacy be visited?",
    today: "Not scored — grade A pharmacies are in no frequency denominator",
    measured: "1,713 of the 1,872 pharmacies are grade A",
    context:
      "The doctor equivalent is 'an A doctor needs 2 visits a month, a B needs 1'. Pharmacies are "
      + "graded the same way but have never been given a number, so nobody is measured against "
      + "one. Almost every pharmacy is an A, so this row is effectively the whole pharmacy "
      + "frequency standard.",
    options: NORM_OPTIONS,
  },
  {
    report: "2 — Pharmacies",
    question: "How many times a month should a GRADE B pharmacy be visited?",
    today: "Not scored — grade B pharmacies are in no frequency denominator",
    measured: "159 of the 1,872 pharmacies are grade B",
    context:
      "The smaller half of the same question. Usually less than the A number. Leave it 'Not "
      + "scored' if you would rather only hold the A pharmacies to a frequency for now.",
    options: NORM_OPTIONS,
  },
  {
    report: "2 — Pharmacies",
    question: "What share of a rep's pharmacy list must he visit at least once in the month?",
    today: "Not scored — pharmacy coverage is shown as a number with no pass mark",
    measured: "40.6% company-wide (760 of 1,872 pharmacies were seen at least once in August)",
    context:
      "The AM/PM floor is 95%. Pharmacy coverage is running at 40.6%, so a 95% floor here would "
      + "put every rep in the red on day one. That is exactly why this is your call and not a "
      + "copy of the doctor number.",
    options: FLOOR_OPTIONS,
  },
  {
    report: "1 — AM · PM",
    question: "Should a GRADE A account (hospital, contract, insurer) have a monthly visit norm?",
    today: "Not scored — the AM list is in no frequency denominator today",
    measured: "787 of the 887 AM accounts are grade A; AM coverage is 72.3%",
    context:
      "The AM list is your accounts list, not a morning doctors list — 96% of it is hospitals, "
      + "contracts and insurers. Its frequency norm has sat at 0 since 19 Aug 2026, which the "
      + "system reads as 'not held to a frequency'. So AM reps are measured on call rate and "
      + "coverage but not on frequency. Say if that is deliberate or an oversight.",
    options: NORM_OPTIONS,
  },
  {
    report: "1 — AM · PM",
    question: "Should a GRADE B account have a monthly visit norm?",
    today: "Not scored — the AM list is in no frequency denominator today",
    measured: "100 of the 887 AM accounts are grade B",
    context:
      "The smaller half of the row above. There are no grade C accounts on the AM list at all, so "
      + "these two rows are the whole question.",
    options: NORM_OPTIONS,
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
  sheet.columns = [{ width: 32 }, { width: 108 }];

  addTitle(
    sheet,
    2,
    "Two KPI reports per rep — the numbers only you can set",
    "You asked for two separate KPI reports per rep: one for AM/PM and one for pharmacies, each "
      + "carrying call rate, frequency and coverage. Both reports are built. Six of the numbers they "
      + "need already existed; these are the ones that never have.",
  );

  const rows: [string, string][] = [
    [
      "The three numbers, kept apart",
      "COVERAGE is how much of his list he saw at all — visited at least once. FREQUENCY is whether "
        + "he saw each one as often as its grade requires. CALL RATE is how many calls he made a day. "
        + "They are three different questions and the reports now answer them separately.",
    ],
    [
      "What you are deciding",
      "Each row is one number. Pick from the dropdown, or pick 'Other' and write the number in the "
        + "Note column. Anything you leave blank stays exactly as it is today, so a half-finished "
        + "sheet is safe to send back.",
    ],
    [
      "What 'Not scored' means today",
      "The report still shows the rep's real figure — it just shows no pass or fail beside it. That "
        + "is deliberate: a zero would read as 'nothing expected' and paint everyone green, which is "
        + "how the AM accounts quietly stopped being measured in the first place.",
    ],
    [
      "What is NOT in here",
      "AM = 2 calls a day, PM = the 8-12 band, the 95% AM/PM coverage floor, and the doctor "
        + "frequency norms (A:2, B:1, C:1). You have already set all of those and they are live. An "
        + "answered question does not come back.",
    ],
    [
      "A rep with no pharmacies",
      "25 of the 69 reps carry no pharmacy list. Their pharmacy report reads 'Not applicable' — never "
        + "a zero, never a gap and never a red cell. Only a rep with no AM/PM list is flagged, "
        + "because that half is universal.",
    ],
    [
      "Why this matters — your own example",
      "Batool Rafiq carries 113 doctors, 16 accounts and 58 pharmacies. Counted together she reads "
        + "65% covered and looks like she is failing. On the list every rep is judged on she is at "
        + "92%. Splitting the two reports is what stops a strong rep reading as a weak one.",
    ],
    [
      "What happens next",
      "Send the file back. Every answer becomes the standard the report scores against — no code "
        + "change needed for the number itself — and is written into the test that guards this, so "
        + "nobody re-asks and no future session invents a different one.",
    ],
  ];

  let cursor = 4;
  for (const [label, body] of rows) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = body;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = 62;
    cursor += 1;
  }
}

function buildQuestions(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Decisions");
  sheet.columns = [{ width: 16 }, { width: 46 }, { width: 40 }, { width: 40 }, { width: 60 }, { width: 30 }, { width: 38 }];

  addTitle(
    sheet,
    7,
    `The numbers still to set — ${QUESTIONS.length} decisions`,
    "Pick a value on each row, or leave it blank to keep it exactly as it is today. "
      + "Measured on production for August 2026, Saturday to Wednesday.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Report",
    "The question",
    "What the system does today",
    "What actually happened in August",
    "Why this is your call",
    "Your answer",
    "Note (anything you want to add)",
  ];
  styleHeader(sheet, headerRow);

  QUESTIONS.forEach((question, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [question.report, question.question, question.today, question.measured, question.context, "", ""];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 74;
    row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  // ONE validation per CONTIGUOUS RUN of rows sharing an option list — never one per cell.
  // Setting `cell.dataValidation` per row makes ExcelJS coalesce them into OVERLAPPING sqref
  // ranges, which puts two validations on one cell and is its own "we found a problem with some
  // content" repair on open. The runs are non-overlapping by construction here.
  let runStart = 0;
  for (let index = 1; index <= QUESTIONS.length; index += 1) {
    const ended = index === QUESTIONS.length || QUESTIONS[index]!.options !== QUESTIONS[runStart]!.options;
    if (!ended) continue;
    const firstRow = headerRow + 1 + runStart;
    const lastRow = headerRow + index;
    (sheet as SheetWithValidations).dataValidations.add(`F${firstRow}:F${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [QUESTIONS[runStart]!.options],
      showErrorMessage: true,
      errorTitle: "Pick one, or choose Other",
      error: "Choose a value from the list, or pick 'Other — see my note' and write the number in the Note column.",
    });
    runStart = index;
  }

  const lastRow = headerRow + QUESTIONS.length;
  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 7 } };
}

function nextFreePath(): string {
  // Africa/Cairo, not UTC. `toISOString()` would date the file a day early for the ~3 hours after
  // Cairo midnight — which is exactly when this repository is often worked — and every date the
  // owner sees is Cairo local by standing rule.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `kpi-standards-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many KPI-standard question workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  // A SHEET WITH NOTHING LEFT ON IT IS NOT WRITTEN AT ALL. Handing somebody a form that re-asks
  // answered questions is how the answers stop coming back. When the owner has priced all four,
  // empty QUESTIONS rather than deleting this script — the machinery stays for the next standard.
  if (QUESTIONS.length === 0) {
    console.log("Nothing outstanding — every KPI standard has been set. No workbook written.");
    console.log("The gate that holds the answers: tests/two-kpi-reports-per-rep.test.ts");
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — two KPI reports per rep";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildQuestions(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  console.log(`Wrote ${outputPath}`);
  console.log(`${QUESTIONS.length} decisions across the two reports.`);
}

await main();
