import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import { addHeldSheet } from "../src/lib/automated-payroll/exports/held-sheet.ts";
import type { HeldBalance, HeldSettlement } from "../src/lib/automated-payroll/held-settlements.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";
import type { SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";

/**
 * The "Held" tab, and the settlement record behind it. Owner request 2026-09-10, both halves:
 *
 *   "I want to make an extra tab in the exported payroll sheet that holds only the holded people."
 *   "they are transferred during the month ... I have nothing to say that this is already
 *    transferred outside the payroll."
 *
 * ASSERTED AGAINST THE GENERATED WORKBOOK, never the source. Three defects shipped in one night in
 * this repo from tests that read the code that builds an artifact instead of the artifact, so every
 * assertion below opens the buffer and reads cells back.
 *
 * WHAT MATTERS MOST, in order:
 *
 *   1. The tab EXISTS even when nobody is held. A missing tab reads as a broken export, not as
 *      "nothing was withheld", and the reader cannot tell those apart.
 *   2. Outstanding = owed minus settled, and it is the figure a short payment shows up in. If a
 *      settlement overwrote what was owed, paying 5,000 against 9,800 would read as fully settled.
 *   3. Earlier months' unsettled holds appear on THIS month's sheet. That is the half that answers
 *      "the next payroll they should not be added" — the amount is in front of him while he works
 *      the new month, instead of being something he has to remember to go and look for.
 */

function buildRun(): MonthlySalaryRun {
  return {
    id: "run-1",
    month: 9,
    year: 2026,
    phase: "part2",
    part1ConfirmedAt: "2026-08-30T06:05:25Z",
    part1ConfirmedBy: "B-10",
    part2ConfirmedAt: null,
    part2ConfirmedBy: null,
    publishedBatchId: null,
    publishedAt: null,
    publishedBy: null,
    createdBy: "B-10",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  } as MonthlySalaryRun;
}

function buildHeldRow(overrides: {
  hrId: string;
  fullName: string;
  firstPart: number;
  secondPart: number;
  reason?: string | null;
}): AssembledRow {
  const row = {
    area: "Cairo",
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    hrId: overrides.hrId,
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: overrides.firstPart,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    fullName: overrides.fullName,
    grossSalary: 10000,
    hireDate: null,
    incentive: 0,
    jobTitle: "Medical Representative",
    line: "Anti Infective",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: overrides.firstPart + overrides.secondPart,
    nameAr: null,
    netSalary: 10000,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: overrides.reason === undefined ? "Awaiting final clearance" : overrides.reason,
    paymentMode: "two_parts",
    row: 1,
    secondPart: overrides.secondPart,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  } as SalaryValidationRow;
  return {
    row,
    compact: overrides.hrId.toLowerCase(),
    onHold: true,
    overpaidResidual: 0,
    // What the locked engine says the month owes, carried alongside the split so reconcile can
    // check one against the other. Nothing is overpaid in these fixtures, so it is the two
    // instalments added.
    totalPayable: overrides.firstPart + overrides.secondPart,
    carriedForwardApplied: 0,
    heldReleaseApplied: 0,
    lifecycle: "regular",
    bankName: "CIB",
    bankAccount: "100000000001",
  };
}

function buildSettlement(overrides: Partial<HeldSettlement> & { compact: string }): HeldSettlement {
  return {
    id: `s-${overrides.compact}`,
    runId: "run-1",
    employeeHrId: overrides.employeeHrId ?? overrides.compact.toUpperCase(),
    employeeHrIdCompact: overrides.compact,
    amount: overrides.amount ?? 0,
    paidOn: overrides.paidOn ?? "2026-09-05",
    method: overrides.method ?? "Bank transfer",
    reference: overrides.reference ?? "TRX-1",
    note: overrides.note ?? null,
    recordedBy: "B-10",
    updatedAt: "2026-09-05T10:00:00Z",
  };
}

/** Every non-empty cell on a sheet, as strings, for substring searching. */
function cellText(sheet: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      if (value == null) return;
      out.push(typeof value === "object" ? JSON.stringify(value) : String(value));
    });
  });
  return out;
}

async function renderHeldSheet(input: {
  rows: AssembledRow[];
  settlements?: Map<string, HeldSettlement>;
  priorBalances?: HeldBalance[];
}): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  addHeldSheet(workbook, {
    run: buildRun(),
    rows: input.rows,
    settlements: input.settlements,
    priorBalances: input.priorBalances,
  });
  // Round-trip through a real buffer: this is the artifact, not the in-memory object.
  const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = reopened.getWorksheet("Held");
  assert.ok(sheet, "the generated workbook must contain a sheet named Held");
  return sheet;
}

export async function runAutomatedPayrollHeldTabTests() {
  // ---- HEADLINE 1: the tab exists even when nobody is held ------------------------------------
  const emptySheet = await renderHeldSheet({ rows: [] });
  const emptyText = cellText(emptySheet).join(" | ");
  assert.match(
    emptyText,
    /Nobody is held this month/i,
    "an empty Held tab must SAY nobody was held — a missing tab reads as a broken export instead",
  );

  // ---- HEADLINE 2: owed, settled, and outstanding ----------------------------------------------
  const rows = [
    // Fully settled by hand.
    buildHeldRow({ hrId: "B-101", fullName: "Fully Settled Person", firstPart: 9000, secondPart: 6000 }),
    // Paid SHORT: 5,000 against 9,800 owed. This is the case a single overwritten figure hides.
    buildHeldRow({ hrId: "B-102", fullName: "Short Paid Person", firstPart: 14000, secondPart: 9800 }),
    // Nothing recorded at all.
    buildHeldRow({ hrId: "B-103", fullName: "Nothing Recorded Person", firstPart: 11000, secondPart: 7000, reason: null }),
  ];
  const settlements = new Map<string, HeldSettlement>([
    ["b-101", buildSettlement({ compact: "b-101", amount: 6000, paidOn: "2026-09-03", reference: "TRX-9001" })],
    ["b-102", buildSettlement({ compact: "b-102", amount: 5000, paidOn: "2026-09-04", reference: "TRX-9002" })],
  ]);

  const sheet = await renderHeldSheet({ rows, settlements });
  const text = cellText(sheet);
  const joined = text.join(" | ");

  for (const name of ["Fully Settled Person", "Short Paid Person", "Nothing Recorded Person"]) {
    assert.ok(joined.includes(name), `${name} must appear on the Held tab`);
  }

  // The numbers themselves, read back off the artifact.
  const numbers = text.filter((value) => /^\d+(\.\d+)?$/.test(value)).map(Number);
  assert.ok(numbers.includes(9800), "the amount owed must appear for the short-paid person");
  assert.ok(numbers.includes(5000), "the amount actually transferred must appear");
  assert.ok(
    numbers.includes(4800),
    "the SHORTFALL (9800 owed minus 5000 paid) must appear as still outstanding — this is the case " +
      "that a settlement overwriting the owed figure would hide entirely",
  );
  assert.ok(numbers.includes(7000), "the unsettled person's whole owed amount must be outstanding");

  // Totals. The reason this is a tab rather than prose is that the figures have to add up.
  assert.ok(joined.includes("TOTAL"), "the Held tab must total its money columns");
  assert.ok(
    numbers.includes(6000 + 5000),
    "settled total must be the sum of what was actually transferred (11,000)",
  );
  assert.ok(
    numbers.includes(0 + 4800 + 7000),
    "outstanding total must be the sum of what is still owed (11,800)",
  );

  // A hold with no reason must announce itself rather than render blank.
  assert.match(
    joined,
    /no reason/i,
    "a hold with no reason recorded must say so on the tab — a blank cell reads as answered",
  );

  // The held meaning travels with the row as a note, so copying a range out cannot lose it.
  let notes = 0;
  sheet.eachRow((row) => {
    const cell = row.getCell(1);
    if (cell.note) notes += 1;
  });
  assert.ok(notes >= rows.length, "each held row must carry the held note on its identifying cell");

  // ---- HEADLINE 3: earlier months' unsettled holds appear on THIS month's sheet ----------------
  const priorBalances: HeldBalance[] = [
    {
      runId: "run-aug",
      month: 8,
      year: 2026,
      hrId: "B-157",
      compact: "b-157",
      name: "Sameh Ahmed Ezzat",
      reason: "Awaiting settlement",
      firstPartAlreadyPaid: 55500,
      secondPartWithheld: 12000,
      settled: null,
      releasedByPayroll: 0,
      outstanding: 12000,
    },
    {
      // Already settled — must NOT be listed, or the list trains him to ignore it.
      runId: "run-aug",
      month: 8,
      year: 2026,
      hrId: "B-156",
      compact: "b-156",
      name: "Sara Samir",
      reason: "Paid by hand",
      firstPartAlreadyPaid: 19600,
      secondPartWithheld: 8000,
      settled: buildSettlement({ compact: "b-156", amount: 8000 }),
      releasedByPayroll: 0,
      outstanding: 0,
    },
  ];

  const withPrior = await renderHeldSheet({ rows, settlements, priorBalances });
  const priorText = cellText(withPrior).join(" | ");
  assert.match(
    priorText,
    /Still owed from earlier months/i,
    "the Held tab must carry a section for earlier months that were never recorded as transferred",
  );
  assert.ok(
    priorText.includes("Sameh Ahmed Ezzat"),
    "an earlier month's UNSETTLED held person must be named on this month's sheet — this is what " +
      "stops the same amount being worked up and paid a second time",
  );
  assert.ok(
    !priorText.includes("Sara Samir"),
    "an earlier month's SETTLED person must NOT be listed as outstanding, or the list becomes noise",
  );
  assert.ok(priorText.includes("August 2026"), "the earlier month must be named, not just implied");

  // And with nothing outstanding, that section says so rather than rendering an empty table.
  const noPrior = await renderHeldSheet({ rows, settlements, priorBalances: [priorBalances[1]] });
  assert.match(
    cellText(noPrior).join(" | "),
    /Nothing outstanding from earlier months/i,
    "with every earlier hold settled, the tab must say so explicitly",
  );
}
