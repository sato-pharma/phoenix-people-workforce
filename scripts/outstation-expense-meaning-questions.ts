/**
 * The Automated Payroll wizard pays outstation expenses as a TYPED figure, and nothing records
 * which trips that figure settled. This sheet asks the owner what the figure means, one row per
 * payment, so the trips it pays for can be stamped from the next run onward.
 *
 * WHY IT IS THE LAST OPEN ITEM OF THE AUDIT. Audit finding 1 had two halves. The first — the legacy
 * outstation import could pay the same trips a second time — is closed at the database: migration
 * 20260910160000 added `phx_period_paid_by_automated_payroll`, and importing a wizard month now
 * raises. The second half is unwritten, because it cannot be written from the data: stamping the
 * trips the wizard actually paid requires knowing WHICH trips a typed number covered, and no column
 * anywhere records that. See docs/production-audits/automated-payroll/audit-cycle-4.md.
 *
 * WHY THIS IS A SHEET AND NOT A QUESTION IN CHAT. Owner rule: a business-fact question with one row
 * per item goes out as an xlsx with a locked dropdown, carrying the context that makes the call
 * easy. Thirty-seven payments, one reading each.
 *
 * WHAT THE EVIDENCE COLUMN IS, AND WHY IT IS NOT A GUESS. Every row was measured against production
 * on 2026-09-12. For each payment the sheet carries the trips that person had sitting in that
 * month's payout period and what those trips total. Thirteen of the thirty-seven match the typed
 * figure to the whole EGP, which is a strong enough pattern to name — but it is offered as evidence
 * for the owner to rule on, never as a rule the code has already adopted.
 *
 * 🔴 NOTHING ON THIS SHEET MOVES MONEY, AND NOTHING CORRECTS A PUBLISHED MONTH. July and August are
 * published and announced, and by standing owner rule a published month is never corrected. The
 * answers here decide (a) what the wizard records from the NEXT run onward, and (b) whether the
 * historical trips are marked as already-settled for the RECORD. Stamping a trip changes no
 * payslip, no salary record and no transfer: it only stops that trip being offered for payment a
 * second time through the legacy import. That import is already refused for wizard months, so even
 * the historical half is belt-and-braces rather than an exposure.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const WARN_FILL = "FFFEF3C7";
const MATCH_FILL = "FFECFDF5";

const JULY_RUN_ID = "2f1660e5-a6d8-4ccb-9492-0d589f252b43";
const AUGUST_RUN_ID = "715d41fa-1c0e-4387-ab01-e1eb4824a6cb";

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: Record<string, unknown>) => void };
};

// NO COMMA inside any option — Excel's inline list is comma-separated, so a comma in an option
// silently splits it into two choices. Kept under 255 characters, which is Excel's cap on an
// inline list; a longer one is dropped and the cell ends up with no dropdown at all.
const MEANING_OPTIONS =
  '"It settles ALL that person\'s trips in that payout period,'
  + "It settles SOME of those trips — see my note,"
  + "It is a travel claim settled outside the outstation system,"
  + "It is an advance or a round figure — not tied to trips,"
  + 'Other — see my note"';

// A second, deliberately short list. The forward-looking policy question is the one that actually
// unblocks the code, so it is asked on its own tab where it cannot be lost among 37 rows.
const POLICY_OPTIONS =
  '"Yes — stamp them automatically,'
  + "Yes — but only where the figure matches the period total exactly,"
  + "No — keep typing the figure and stamp nothing,"
  + 'Other — see my note"';

const HISTORY_OPTIONS =
  '"Leave all 374 trips unstamped — they are history,'
  + "Stamp only the ones that match a payment exactly,"
  + "Stamp every trip in a payout period the wizard paid for,"
  + 'Other — see my note"';

type Payment = {
  monthKey: string;
  name: string;
  jobTitle: string;
  typed: number;
  periodTrips: number;
  periodTotal: number;
  difference: number;
  reading: string;
  tripsEver: number;
  tripsEverTotal: number;
  firstTrip: string | null;
  lastTrip: string | null;
};

/**
 * Read from production (ref ozucdzovmcqvepbozvqf) on 2026-09-12 — the two published Automated
 * Payroll runs, every draft row carrying a non-zero `expenses` figure, joined to that person's
 * outstation trips. `periodTotal` is the sum of `outstation_expenses.total` for trips whose
 * payout_year/payout_month IS the run's own month.
 *
 * Ordered by month then by amount, largest first, so the biggest money is decided while attention
 * is freshest rather than buried in the middle.
 */
const PAYMENTS: Payment[] = [
  { monthKey: "2026-07", name: "Ali Mohamed Ali Elsayed", jobTitle: "National Sales Manager", typed: 6604, periodTrips: 0, periodTotal: 0, difference: 6604, reading: "No trips in that payout period (has trips in others)", tripsEver: 2, tripsEverTotal: 600, firstTrip: "2026-03-31", lastTrip: "2026-04-11" },
  { monthKey: "2026-07", name: "Hany Saad Mohamed Omar", jobTitle: "Regional Sales Manager", typed: 5000, periodTrips: 0, periodTotal: 0, difference: 5000, reading: "No trips in that payout period (has trips in others)", tripsEver: 1, tripsEverTotal: 417.6, firstTrip: "2026-07-30", lastTrip: "2026-07-30" },
  { monthKey: "2026-07", name: "Saad Mohamed Saad Salama", jobTitle: "District Sales Manager", typed: 3973, periodTrips: 12, periodTotal: 3973, difference: 0, reading: "EXACT match to the period total", tripsEver: 60, tripsEverTotal: 19549.72, firstTrip: "2026-02-14", lastTrip: "2026-08-08" },
  { monthKey: "2026-07", name: "Dina Hamdy Fadel Mohamed Bdair", jobTitle: "District Sales Manager", typed: 3655, periodTrips: 11, periodTotal: 4442, difference: -787, reading: "Less than the period total", tripsEver: 46, tripsEverTotal: 16914.58, firstTrip: "2026-02-01", lastTrip: "2026-08-25" },
  { monthKey: "2026-07", name: "Salim Salim Abdo Ibrahim Gomaa", jobTitle: "District Sales Manager", typed: 3416, periodTrips: 4, periodTotal: 3416, difference: 0, reading: "EXACT match to the period total", tripsEver: 18, tripsEverTotal: 9228.8, firstTrip: "2026-01-20", lastTrip: "2026-08-05" },
  { monthKey: "2026-07", name: "Sally Saied Sedhom Mankrios Sedhom", jobTitle: "District Sales Manager", typed: 3032, periodTrips: 7, periodTotal: 3032, difference: 0, reading: "EXACT match to the period total", tripsEver: 25, tripsEverTotal: 10153.72, firstTrip: "2026-03-12", lastTrip: "2026-08-03" },
  { monthKey: "2026-07", name: "Amr Mohamed Naguib Elsebaey", jobTitle: "National Sales Manager", typed: 2897, periodTrips: 0, periodTotal: 0, difference: 2897, reading: "No trips in that payout period (has trips in others)", tripsEver: 6, tripsEverTotal: 5661.48, firstTrip: "2026-07-07", lastTrip: "2026-09-07" },
  { monthKey: "2026-07", name: "Yehya Mohamed Kamal eldeen Saad Mohamed", jobTitle: "District Sales Manager", typed: 2667, periodTrips: 6, periodTotal: 3521, difference: -854, reading: "Less than the period total", tripsEver: 36, tripsEverTotal: 13488, firstTrip: "2026-02-02", lastTrip: "2026-07-01" },
  { monthKey: "2026-07", name: "Amgad Ibrahim Tawfik Farag", jobTitle: "District Sales Manager", typed: 2238, periodTrips: 4, periodTotal: 2238, difference: 0, reading: "EXACT match to the period total", tripsEver: 16, tripsEverTotal: 6385, firstTrip: "2026-02-25", lastTrip: "2026-06-25" },
  { monthKey: "2026-07", name: "Ahmed Mohamed Ahmed Mohamed Abdallah", jobTitle: "District Sales Manager", typed: 2098, periodTrips: 5, periodTotal: 2603, difference: -505, reading: "Less than the period total", tripsEver: 19, tripsEverTotal: 8799, firstTrip: "2026-02-25", lastTrip: "2026-06-30" },
  { monthKey: "2026-07", name: "Ahmed Mohamed Ahmed Mohamed Heikal", jobTitle: "District Sales Manager", typed: 1953, periodTrips: 7, periodTotal: 2807, difference: -854, reading: "Less than the period total", tripsEver: 27, tripsEverTotal: 9521, firstTrip: "2026-02-02", lastTrip: "2026-06-29" },
  { monthKey: "2026-07", name: "Ahmed Mohamed Rabiee Fayk Elkawas", jobTitle: "Training Manager", typed: 1533, periodTrips: 2, periodTotal: 1858, difference: -325, reading: "Less than the period total", tripsEver: 9, tripsEverTotal: 6466, firstTrip: "2026-02-11", lastTrip: "2026-07-08" },
  { monthKey: "2026-07", name: "Mostafa Mamdouh Mohamed Ibrahim Kasem", jobTitle: "Medical Representative", typed: 1500, periodTrips: 0, periodTotal: 0, difference: 1500, reading: "No outstation trips at all — ever", tripsEver: 0, tripsEverTotal: 0, firstTrip: null, lastTrip: null },
  { monthKey: "2026-07", name: "Nermeen Salah Abdelaty Abohussien", jobTitle: "District Sales Manager", typed: 1446, periodTrips: 4, periodTotal: 1446, difference: 0, reading: "EXACT match to the period total", tripsEver: 16, tripsEverTotal: 5963, firstTrip: "2026-02-04", lastTrip: "2026-06-24" },
  { monthKey: "2026-07", name: "Aya Ibrahim Mohamed Salam", jobTitle: "Medical Representative", typed: 1000, periodTrips: 0, periodTotal: 0, difference: 1000, reading: "No outstation trips at all — ever", tripsEver: 0, tripsEverTotal: 0, firstTrip: null, lastTrip: null },
  { monthKey: "2026-07", name: "Rasha Sabry Sayed Khalifa", jobTitle: "Group Product Manager", typed: 938, periodTrips: 0, periodTotal: 0, difference: 938, reading: "No trips in that payout period (has trips in others)", tripsEver: 4, tripsEverTotal: 3601.62, firstTrip: "2026-04-22", lastTrip: "2026-08-06" },
  { monthKey: "2026-07", name: "Ghada Mohamed Abdelwahab Ismaiel", jobTitle: "Medical Representative", typed: 815, periodTrips: 0, periodTotal: 0, difference: 815, reading: "No outstation trips at all — ever", tripsEver: 0, tripsEverTotal: 0, firstTrip: null, lastTrip: null },
  { monthKey: "2026-07", name: "Mahmoud ElHassanin Imam Muslim ElHassanin", jobTitle: "District Sales Manager", typed: 801, periodTrips: 2, periodTotal: 801, difference: 0, reading: "EXACT match to the period total", tripsEver: 8, tripsEverTotal: 2809, firstTrip: "2026-02-08", lastTrip: "2026-06-29" },
  { monthKey: "2026-07", name: "Taha Mohamed Taha Elsayed AboElftouh", jobTitle: "District Sales Manager", typed: 461, periodTrips: 6, periodTotal: 1281, difference: -820, reading: "Less than the period total", tripsEver: 19, tripsEverTotal: 4180, firstTrip: "2026-02-15", lastTrip: "2026-06-29" },
  { monthKey: "2026-07", name: "Sherouk Wael Khalaf Mohamed", jobTitle: "Medical Representative", typed: 450, periodTrips: 0, periodTotal: 0, difference: 450, reading: "No outstation trips at all — ever", tripsEver: 0, tripsEverTotal: 0, firstTrip: null, lastTrip: null },
  { monthKey: "2026-07", name: "Nosiba Salah Hassanin Moussa", jobTitle: "Medical Representative", typed: 400, periodTrips: 1, periodTotal: 400, difference: 0, reading: "EXACT match to the period total", tripsEver: 2, tripsEverTotal: 400, firstTrip: "2026-04-08", lastTrip: "2026-06-08" },
  { monthKey: "2026-07", name: "Hayam Mohamed Eladl FaragAllah Hefnawy", jobTitle: "Medical Representative", typed: 150, periodTrips: 0, periodTotal: 0, difference: 150, reading: "No outstation trips at all — ever", tripsEver: 0, tripsEverTotal: 0, firstTrip: null, lastTrip: null },
  { monthKey: "2026-08", name: "Saad Mohamed Saad Salama", jobTitle: "District Sales Manager", typed: 4203, periodTrips: 0, periodTotal: 0, difference: 4203, reading: "No trips in that payout period (has trips in others)", tripsEver: 60, tripsEverTotal: 19549.72, firstTrip: "2026-02-14", lastTrip: "2026-08-08" },
  { monthKey: "2026-08", name: "Ahmed SharafEldeen Ahmed GadElkareem", jobTitle: "Product Manager", typed: 2873, periodTrips: 4, periodTotal: 2873.94, difference: -0.94, reading: "Matches the period total — rounded to whole EGP", tripsEver: 4, tripsEverTotal: 2873.94, firstTrip: "2026-07-12", lastTrip: "2026-07-29" },
  { monthKey: "2026-08", name: "Dina Hamdy Fadel Mohamed Bdair", jobTitle: "District Sales Manager", typed: 2640, periodTrips: 0, periodTotal: 0, difference: 2640, reading: "No trips in that payout period (has trips in others)", tripsEver: 46, tripsEverTotal: 16914.58, firstTrip: "2026-02-01", lastTrip: "2026-08-25" },
  { monthKey: "2026-08", name: "Nahed Tarek Hassan Omar Hattab", jobTitle: "Product Manager", typed: 2155, periodTrips: 3, periodTotal: 3115.56, difference: -960.56, reading: "Less than the period total", tripsEver: 5, tripsEverTotal: 4075.05, firstTrip: "2026-07-14", lastTrip: "2026-08-07" },
  { monthKey: "2026-08", name: "Sally Saied Sedhom Mankrios Sedhom", jobTitle: "District Sales Manager", typed: 2121, periodTrips: 0, periodTotal: 0, difference: 2121, reading: "No trips in that payout period (has trips in others)", tripsEver: 25, tripsEverTotal: 10153.72, firstTrip: "2026-03-12", lastTrip: "2026-08-03" },
  { monthKey: "2026-08", name: "Salim Salim Abdo Ibrahim Gomaa", jobTitle: "District Sales Manager", typed: 1979, periodTrips: 0, periodTotal: 0, difference: 1979, reading: "No trips in that payout period (has trips in others)", tripsEver: 18, tripsEverTotal: 9228.8, firstTrip: "2026-01-20", lastTrip: "2026-08-05" },
  { monthKey: "2026-08", name: "Nermeen Salah Abdelaty Abohussien", jobTitle: "District Sales Manager", typed: 1180, periodTrips: 0, periodTotal: 0, difference: 1180, reading: "No trips in that payout period (has trips in others)", tripsEver: 16, tripsEverTotal: 5963, firstTrip: "2026-02-04", lastTrip: "2026-06-24" },
  { monthKey: "2026-08", name: "Ahmed Mohamed Rabiee Fayk Elkawas", jobTitle: "Training Manager", typed: 1035, periodTrips: 1, periodTotal: 1035, difference: 0, reading: "EXACT match to the period total", tripsEver: 9, tripsEverTotal: 6466, firstTrip: "2026-02-11", lastTrip: "2026-07-08" },
  { monthKey: "2026-08", name: "Amgad Ibrahim Tawfik Farag", jobTitle: "District Sales Manager", typed: 655, periodTrips: 0, periodTotal: 0, difference: 655, reading: "No trips in that payout period (has trips in others)", tripsEver: 16, tripsEverTotal: 6385, firstTrip: "2026-02-25", lastTrip: "2026-06-25" },
  { monthKey: "2026-08", name: "Amr Mohamed Naguib Elsebaey", jobTitle: "National Sales Manager", typed: 588, periodTrips: 1, periodTotal: 588, difference: 0, reading: "EXACT match to the period total", tripsEver: 6, tripsEverTotal: 5661.48, firstTrip: "2026-07-07", lastTrip: "2026-09-07" },
  { monthKey: "2026-08", name: "Rasha Sabry Sayed Khalifa", jobTitle: "Group Product Manager", typed: 544, periodTrips: 1, periodTotal: 543.61, difference: 0.39, reading: "Matches the period total — rounded to whole EGP", tripsEver: 4, tripsEverTotal: 3601.62, firstTrip: "2026-04-22", lastTrip: "2026-08-06" },
  { monthKey: "2026-08", name: "Taha Mohamed Taha Elsayed AboElftouh", jobTitle: "District Sales Manager", typed: 441, periodTrips: 0, periodTotal: 0, difference: 441, reading: "No trips in that payout period (has trips in others)", tripsEver: 19, tripsEverTotal: 4180, firstTrip: "2026-02-15", lastTrip: "2026-06-29" },
  { monthKey: "2026-08", name: "Hany Saad Mohamed Omar", jobTitle: "Regional Sales Manager", typed: 418, periodTrips: 1, periodTotal: 417.6, difference: 0.4, reading: "Matches the period total — rounded to whole EGP", tripsEver: 1, tripsEverTotal: 417.6, firstTrip: "2026-07-30", lastTrip: "2026-07-30" },
  { monthKey: "2026-08", name: "Mahmoud ElHassanin Imam Muslim ElHassanin", jobTitle: "District Sales Manager", typed: 325, periodTrips: 0, periodTotal: 0, difference: 325, reading: "No trips in that payout period (has trips in others)", tripsEver: 8, tripsEverTotal: 2809, firstTrip: "2026-02-08", lastTrip: "2026-06-29" },
  { monthKey: "2026-08", name: "Ahmed Elsayed Ahmed Ibrahim", jobTitle: "District Sales Manager", typed: 238, periodTrips: 1, periodTotal: 237.6, difference: 0.4, reading: "Matches the period total — rounded to whole EGP", tripsEver: 2, tripsEverTotal: 621.22, firstTrip: "2026-07-30", lastTrip: "2026-09-02" },
];

function isMatch(payment: Payment): boolean {
  return payment.periodTrips > 0 && Math.abs(payment.difference) <= 1;
}

function needsALook(payment: Payment): boolean {
  return payment.periodTrips === 0;
}

/** What the row is worth knowing, phrased for someone deciding rather than auditing. */
function noteFor(payment: Payment): string {
  if (payment.tripsEver === 0) {
    return "This person has NO outstation trips in the system at all — not in this month and not in "
      + "any other. Whatever this money was, it did not come from a recorded trip.";
  }
  if (payment.periodTrips === 0) {
    return `No trips sat in ${payment.monthKey}'s payout period, but this person has `
      + `${payment.tripsEver} trips elsewhere (${payment.firstTrip} to ${payment.lastTrip}) `
      + `worth ${payment.tripsEverTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} EGP. `
      + "So the figure was typed from something outside that period — an older claim caught up, or a "
      + "trip never entered.";
  }
  if (isMatch(payment)) {
    return `The typed figure equals the ${payment.periodTrips} trips sitting in that payout period, `
      + "to the whole EGP. If that is what you intended, these are the trips the money settled and "
      + "they can be stamped.";
  }
  if (payment.difference < 0) {
    return `Less than the ${payment.periodTrips} trips in that period, by `
      + `${Math.abs(payment.difference).toLocaleString("en-US", { minimumFractionDigits: 2 })} EGP. `
      + "Either some trips were held back, or the figure was trimmed. Which of the "
      + `${payment.periodTrips} it covers cannot be told from the data.`;
  }
  return `More than the ${payment.periodTrips} trips in that period, by `
    + `${payment.difference.toLocaleString("en-US", { minimumFractionDigits: 2 })} EGP — so it `
    + "carries something the trip rows do not.";
}

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

  const matches = PAYMENTS.filter(isMatch).length;
  const noTrips = PAYMENTS.filter((payment) => payment.tripsEver === 0).length;

  addTitle(
    sheet,
    2,
    "What does the wizard's expense figure mean?",
    "This is the last open item of the Automated Payroll audit. Thirty-seven payments across the two "
      + "published months. Nothing here moves money or changes a published month — it decides what "
      + "the system RECORDS from the next run onward.",
  );

  const rows: [string, string][] = [
    [
      "The one thing being asked",
      "When you type an expense figure into the Automated Payroll wizard, which outstation trips is "
        + "that money paying for? Nothing in the system records the answer, so the trips it settles "
        + "are never marked as settled.",
    ],
    [
      "🔴 Nothing here moves money",
      "July and August are published and announced, and a published month is never corrected. No "
        + "answer on this sheet changes a payslip, a salary record or a transfer. Marking a trip as "
        + "settled is a RECORD-KEEPING act: it stops that trip being offered for payment a second "
        + "time through the old outstation import.",
    ],
    [
      "Why it matters anyway",
      "374 trips are sitting in the system and NOT ONE of them is marked as paid — including every "
        + "trip in the periods the wizard already paid for. The double-payment route is already shut "
        + "at the database for wizard months, so this is about the record being true rather than "
        + "about an exposure that is still open.",
    ],
    [
      "What the evidence column is",
      `Measured against production on 2026-09-12, not guessed. ${matches} of the 37 payments equal `
        + "the trips sitting in that month's payout period, to the whole EGP — those rows are tinted "
        + "green. That is a strong enough pattern to name, but it is put to you as evidence, not "
        + "adopted as a rule by the code.",
    ],
    [
      "The rows tinted amber",
      "Those are payments where NO trips sat in that month's payout period at all. The money was "
        + `typed from something else. ${noTrips} people on the sheet have no outstation trips `
        + "anywhere in the system, ever — for them the figure cannot be about trips at all.",
    ],
    [
      "Both figures were typed in one keystroke",
      "Every July figure was saved at 2026-08-08 13:45:27 Cairo and every August figure at "
        + "2026-09-08 14:09:47 Cairo — one save each, and not a single one carries a note. That is "
        + "not a criticism of how it was done; it is why the answer cannot be recovered from the data.",
    ],
    [
      "How to answer",
      "The 'Payments' tab is one row per payment — pick a reading in 'What this figure settled'. The "
        + "'Going forward' tab holds the two questions that actually change the code, and it is the "
        + "more important of the two tabs. If you only have five minutes, answer that one.",
    ],
    [
      "What happens after you send it back",
      "The forward answer is built into the wizard so the next run records which trips it settles, "
        + "and finding 1's second half is finally written. The per-payment answers become the "
        + "historical record. Nothing is applied to production without showing you the exact change "
        + "first.",
    ],
  ];

  const headerRow = 4;
  rows.forEach(([label, body], index) => {
    const row = sheet.getRow(headerRow + index);
    row.values = [label, body];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 58;
    row.getCell(1).font = { bold: true, size: 11 };
  });
}

function buildGoingForward(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Going forward");
  sheet.columns = [{ width: 30 }, { width: 86 }, { width: 54 }, { width: 44 }];

  addTitle(
    sheet,
    4,
    "The two questions that change the code",
    "Answer these two and finding 1's remaining half can be written. The per-payment tab is useful "
      + "history; these two are the decision.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = ["Question", "What it means in practice", "Your answer", "Note"];
  styleHeader(sheet, headerRow);

  const questions: [string, string][] = [
    [
      "From the NEXT run onward, should confirming the expenses step stamp the trips it pays for?",
      "Today the wizard writes a number and nothing else. If the answer is yes, confirming Part 2 "
        + "would also mark that person's trips in that payout period as settled by this run — so "
        + "they can never be offered for payment again, and the record finally says who was paid for "
        + "what. If the figure you type does not always equal those trips, the middle option only "
        + "stamps when it matches exactly and leaves the rest alone.",
    ],
    [
      "What should happen to the 374 trips already in the system, none of them marked as paid?",
      "This is the historical half, and it is optional — the old import is already refused for "
        + "months the wizard paid, so nothing can double-pay them today. It only decides whether the "
        + "record reflects what was actually settled. No money moves whichever way you answer.",
    ],
  ];

  questions.forEach(([question, meaning], index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [question, meaning, "", ""];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 108;
    row.getCell(1).font = { bold: true, size: 11 };
    row.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  // Two different option lists, so two single-cell validations rather than one range. Each covers
  // exactly one cell, so they cannot overlap.
  const validations = sheet as SheetWithValidations;
  validations.dataValidations.add(`C${headerRow + 1}`, {
    type: "list",
    allowBlank: true,
    formulae: [POLICY_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Pick one, or choose Other",
    error: "Choose an answer from the list, or pick 'Other — see my note' and write it in the Note column.",
  });
  validations.dataValidations.add(`C${headerRow + 2}`, {
    type: "list",
    allowBlank: true,
    formulae: [HISTORY_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Pick one, or choose Other",
    error: "Choose an answer from the list, or pick 'Other — see my note' and write it in the Note column.",
  });

  sheet.views = [{ state: "frozen", ySplit: headerRow }];
}

function buildPayments(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Payments");
  sheet.columns = [
    { width: 10 },
    { width: 40 },
    { width: 24 },
    { width: 13 },
    { width: 8 },
    { width: 15 },
    { width: 13 },
    { width: 34 },
    { width: 64 },
    { width: 46 },
    { width: 36 },
  ];

  addTitle(
    sheet,
    11,
    `Every expense figure the wizard paid — ${PAYMENTS.length} payments`,
    "One row per payment. Green rows match their trips to the whole EGP; amber rows had no trips in "
      + "that payout period at all. Read the 'Read me' tab first — nothing here moves money, and no "
      + "published month is being corrected.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Month",
    "Name",
    "Job title",
    "Paid (EGP)",
    "Trips",
    "Trips total (EGP)",
    "Difference",
    "How it reads",
    "What is worth knowing",
    "What this figure settled",
    "Note (anything you want to add)",
  ];
  styleHeader(sheet, headerRow);

  PAYMENTS.forEach((payment, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [
      payment.monthKey,
      payment.name,
      payment.jobTitle,
      payment.typed,
      payment.periodTrips === 0 ? "none" : payment.periodTrips,
      payment.periodTrips === 0 ? "—" : payment.periodTotal,
      payment.periodTrips === 0 ? "—" : payment.difference,
      payment.reading,
      noteFor(payment),
      "",
      "",
    ];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 62;

    row.getCell(4).numFmt = "#,##0.00";
    if (payment.periodTrips > 0) {
      row.getCell(6).numFmt = "#,##0.00";
      row.getCell(7).numFmt = "#,##0.00";
    }

    // Green where the arithmetic already answers the question, amber where there is nothing for the
    // figure to have settled. Neither is a verdict — they are there so 37 rows are not answered on
    // autopilot in one pass.
    const tint = isMatch(payment) ? MATCH_FILL : needsALook(payment) ? WARN_FILL : null;
    if (tint) {
      for (let column = 1; column <= 9; column += 1) {
        row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: tint } };
      }
    }

    row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    row.getCell(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
  });

  const firstRow = headerRow + 1;
  const lastRow = headerRow + PAYMENTS.length;

  // ONE validation across the whole contiguous run — never one per cell. Setting
  // `cell.dataValidation` per row makes ExcelJS coalesce them into OVERLAPPING sqref ranges, which
  // puts two validations on one cell and is its own "we found a problem with some content" repair
  // on open. Every row here shares one option list, so it is a single range by construction.
  (sheet as SheetWithValidations).dataValidations.add(`J${firstRow}:J${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [MEANING_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Pick one, or choose Other",
    error: "Choose a reading from the list, or pick 'Other — see my note' and write it in the Note column.",
  });

  sheet.views = [{ state: "frozen", xSplit: 2, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 11 } };
}

function nextFreePath(): string {
  // Africa/Cairo, not UTC. `toISOString()` would date the file a day early for the ~3 hours after
  // Cairo midnight — which is exactly when this repository is often worked — and every date the
  // owner sees is Cairo local by standing rule.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `outstation-expense-meaning-questions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many expense-meaning workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — Automated Payroll outstation expense meaning";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildGoingForward(workbook);
  buildPayments(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const matches = PAYMENTS.filter(isMatch).length;
  const amber = PAYMENTS.filter(needsALook).length;
  const noTrips = PAYMENTS.filter((payment) => payment.tripsEver === 0).length;
  const july = PAYMENTS.filter((payment) => payment.monthKey === "2026-07");
  const august = PAYMENTS.filter((payment) => payment.monthKey === "2026-08");
  const sum = (rows: Payment[]) => rows.reduce((total, row) => total + row.typed, 0);

  console.log(`Wrote ${outputPath}`);
  console.log(`${PAYMENTS.length} payments across the two published runs.`);
  console.log(`  2026-07 (run ${JULY_RUN_ID}): ${july.length} people, ${sum(july).toLocaleString("en-US")} EGP`);
  console.log(`  2026-08 (run ${AUGUST_RUN_ID}): ${august.length} people, ${sum(august).toLocaleString("en-US")} EGP`);
  console.log(`  ${matches} match their payout-period trips to the whole EGP (green)`);
  console.log(`  ${amber} had no trips in that payout period at all (amber)`);
  console.log(`  ${noTrips} of those have no outstation trips anywhere, ever`);
}

await main();
