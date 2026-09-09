/**
 * Who should receive the retention-risk alert?
 *
 * The owner looked at the 7 September 07:40 batch and said the recipients are wrong. This asks him
 * which ones, as a sheet with dropdowns rather than a list to answer in chat (his standing rule).
 *
 * WHAT THE ALERT CURRENTLY DOES. `notification_role_policies.retention_risk_alert` holds FOUR ROLES,
 * seeded on production 2026-09-07. Every alert also adds ONE more person: the flagged employee's own
 * line manager, resolved per alert from that person's reporting line. That is deliberately not a role
 * — it is one named manager per subject, not everyone holding a manager title.
 *
 * WHY THE CEO IS ON THE SHEET BUT NOT A ROLE. He received three of the seven on 7 September, purely
 * as the line manager of three HEAD-OFFICE managers who should never have been flagged at all. The
 * reps-only scope (#3407) already removes that source, so he is listed for confirmation, not because
 * a role puts him there.
 *
 * Run:
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/retention-alert-recipient-questions.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

/** ExcelJS types omit the sheet-level validation collection, which is the one that works. */
type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: Record<string, unknown>) => void };
};

const ACCENT = "FF0A527D";
const HEADER_TEXT = "FFFFFFFF";
const NOTE_FILL = "FFF3F6F8";

type Row = {
  slot: string;
  whoToday: string;
  gotOn7Sept: string;
  why: string;
};

/**
 * One row per recipient slot, in the order the server resolves them. `whoToday` is live production
 * as of 2026-09-07 09:50 Cairo — read from auth.users.raw_user_meta_data->>'phoenix_role', which is
 * the real key (a migration writing `role` matches zero rows and verifies itself green).
 */
const ROWS: Row[] = [
  {
    slot: "Role: HR Operations",
    whoToday: "Yasmeena Khaled Ahmed Hussein Elsafory (HR-009) — HR Generalist",
    gotOn7Sept: "All 7 alerts",
    why: "One of the four roles you picked on 2026-09-06.",
  },
  {
    slot: "Role: HR Advisory",
    whoToday: "Aya Mohamed (HR-010) — HR Business Partner",
    gotOn7Sept: "All 7 alerts",
    why: "One of the four roles you picked on 2026-09-06.",
  },
  {
    slot: "Role: Super Admin",
    whoToday: "Omar Anwar Ibrahim Ahmed Gawish (B-10) — HR Section Head",
    gotOn7Sept: "All 7 alerts",
    why: "One of the four roles you picked on 2026-09-06. The admin-HR canary also holds this role but has no employee record, so it receives nothing.",
  },
  {
    slot: "Role: SFE Manager",
    whoToday: "Khaled Mohamed Ali Bedair (A-2) — SFE Manager",
    gotOn7Sept: "All 7 alerts",
    why: "One of the four roles you picked on 2026-09-06.",
  },
  {
    slot: "Per alert: the flagged rep's own District Sales Manager",
    whoToday:
      "Sameh Shabaan El Hoseiny (B-117), Amgad Ibrahim Tawfik Farag (B-118), Mahmoud ElHassanin (B-120), Ahmed Elsayed Ahmed Ibrahim (PD-0010)",
    gotOn7Sept: "One alert each — only about their own rep",
    why: "Not a role. The server resolves ONE named manager from the flagged person's reporting line, so a DSM only ever hears about his own people.",
  },
  {
    slot: "Per alert: the CEO, as line manager of a head-office manager",
    whoToday: "Anwar Gaweesh (AA) — CEO",
    gotOn7Sept:
      "3 alerts — Ahmed El Maraghy, Ali Mohamed, Hossam AboElftouh, all on ordinary approved leave",
    why: "ALREADY FIXED by the reps-only scope: head-office managers are no longer flagged, so this source is gone. Listed only so you can confirm that is what you wanted.",
  },
];

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = sheet.getRow(rowNumber);
  row.height = 26;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  });
}

function buildReadMe(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Read me");
  sheet.columns = [{ width: 30 }, { width: 104 }];
  const lines: Array<[string, string]> = [
    ["The question", "You said the retention-risk alert recipients are wrong. Which ones?"],
    ["How to answer", "Open the Decisions tab. Set Keep or Remove on every row, and add a note where it helps."],
    ["What an alert is", "A medical rep hits 5 consecutive working days of recorded leave, or 5 with no CRM entry at all."],
    ["Who gets it now", "Four roles, plus ONE line manager resolved per alert from the flagged person's own reporting line."],
    ["Channels", "In-app and Telegram to everyone; email to the primary recipient. You removed email from this alert's other paths on 2026-09-07."],
    ["What already changed", "The 7 Sept 07:40 batch ran under the OLD scope and named 7 people, 3 of them head-office managers on ordinary leave. #3407 fixed that: reps only, and only runs nobody has returned from."],
    ["Today's run", "07:40:00 Cairo, HTTP 200 in 5.3s, and it correctly created NOTHING new."],
    ["Nothing is sent from this", "Answering this sheet changes a config row. It does not send anything to anyone."],
  ];
  sheet.addRow(["Retention-risk alert — who should receive it?", ""]);
  sheet.getRow(1).font = { bold: true, size: 14, color: { argb: ACCENT } };
  sheet.addRow([]);
  for (const [label, value] of lines) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.height = 30;
  }
}

function buildDecisions(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Decisions");
  sheet.columns = [
    { header: "Recipient slot", key: "slot", width: 46 },
    { header: "Who that is today", key: "whoToday", width: 62 },
    { header: "Got on 7 Sept", key: "gotOn7Sept", width: 34 },
    { header: "Why they are on the list", key: "why", width: 68 },
    { header: "Keep or remove?", key: "decision", width: 20 },
    { header: "Note (optional)", key: "note", width: 46 },
  ];
  styleHeader(sheet, 1);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of ROWS) {
    const added = sheet.addRow({ ...row, decision: "", note: "" });
    added.height = 58;
    added.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: "top" };
    });
    added.getCell("note").fill = { type: "pattern", pattern: "solid", fgColor: { argb: NOTE_FILL } };
  }

  // Range-level, never per cell: setting `cell.dataValidation` row by row makes ExcelJS coalesce
  // them into OVERLAPPING sqref ranges, which Excel then silently repairs by dropping the dropdown.
  const firstRow = 2;
  const lastRow = ROWS.length + 1;
  (sheet as SheetWithValidations).dataValidations.add(`E${firstRow}:E${lastRow}`, {
    allowBlank: false,
    error: "Pick Keep or Remove from the list.",
    errorStyle: "stop",
    errorTitle: "Not one of the options",
    formulae: ['"Keep,Remove"'],
    showErrorMessage: true,
    type: "list",
  });
}

function nextFreePath(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  for (let n = 0; n < 20; n += 1) {
    const suffix = n === 0 ? "" : `-${n + 1}`;
    const candidate = resolve(`xlsx/retention-alert-recipients-${stamp}${suffix}.xlsx`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many recipient workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();
  buildReadMe(workbook);
  buildDecisions(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  console.log(outputPath);
}

await main();
