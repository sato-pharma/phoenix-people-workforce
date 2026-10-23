import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { buildFullSheetWorkbook } from "../src/lib/automated-payroll/exports/sheet.ts";
import {
  automatedPayrollRunIdFromBatchFileName,
  heldExcludedFilingNote,
  parsePublishedHoldDetail,
} from "../src/lib/automated-payroll/published-holds.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";
import { buildStatutorySummaryWorkbook } from "../src/lib/payroll/exports/statutory-summary.ts";

/**
 * A HELD PERSON IS NOT ABSENT, AND EVERY REPORT BUILT FROM SALARY RECORDS USED TO SAY THEY WERE.
 *
 * A held row is dropped at publish with no salary record. Three reports read salary records alone:
 *
 *   43 — the Statutory Summary left every held employee out of the filing, TOTAL included, silently.
 *   46 — the population comparison's baseline left them out, so someone held last month read as a new
 *        joiner this month; and a failed leavers read turned every leaver into "disappeared".
 *   52 — the Executive Summary compared this month WITH held people (and non-employees) against last
 *        month WITHOUT them, and printed the gap as movement.
 *
 * July and August 2026 recorded only HOW MANY were held, not who or for how much (checked on production
 * 2026-09-11). Every reader here says which record it had.
 */

function bodyOf(source: string, signature: string, limit = 14000): string {
  const start = source.indexOf(signature);
  const end = source.indexOf("\nexport ", start + 10);
  assert.ok(start >= 0 && end > start, `${signature} and its end must be found`);
  const body = source.slice(start, end);
  assert.ok(body.length < limit, `the slice for ${signature} must stay bounded (got ${body.length})`);
  return body;
}

async function sheetTexts(workbook: ExcelJS.Workbook, sheetName: string): Promise<string[]> {
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  const sheet = loaded.getWorksheet(sheetName);
  assert.ok(sheet, `${sheetName} must exist in the emitted file`);
  const texts: string[] = [];
  sheet!.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === "string") texts.push(cell.value);
    });
  });
  return texts;
}

const run: MonthlySalaryRun = {
  createdAt: "", createdBy: null, id: "run-9", month: 9, monthKey: "2026-09",
  part1ConfirmedAt: null, part1ConfirmedBy: null, part2ConfirmedAt: null, part2ConfirmedBy: null,
  phase: "part2", publishedAt: null, publishedBatchId: null, publishedBy: null, updatedAt: "", year: 2026,
};

export async function runAutomatedPayrollHeldInReportsTests() {
  // ==== The hold record, as each month actually wrote it ===========================================
  const countOnly = parsePublishedHoldDetail({ batchId: "b-8", heldExcluded: 20, publishedCount: 100 });
  assert.deepEqual(countOnly, { heldExcluded: 20, held: null }, "August 2026's publish recorded a count and nothing else");
  const detailed = parsePublishedHoldDetail({
    heldExcluded: 2,
    held: [
      { hrId: "B-1", name: "Mona Adel", firstPartAlreadyPaid: 5000, secondPartWithheld: 4000, monthTotal: 9000, socialInsurance: 600, employmentIncomeTax: 250 },
      { hrId: "B-2", name: "Omar Said", firstPartAlreadyPaid: 3000, secondPartWithheld: 3000, monthTotal: 6000 },
    ],
  });
  assert.equal(detailed.held?.length, 2);
  assert.equal(detailed.held?.[0].socialInsurance, 600);
  assert.equal(detailed.held?.[1].socialInsurance, null, "a figure publish did not record reads as null, never as zero");
  assert.deepEqual(parsePublishedHoldDetail(null), { heldExcluded: null, held: null });

  assert.equal(
    automatedPayrollRunIdFromBatchFileName("automated-payroll:715d41fa-1c0e-4387-ab01-e1eb4824a6cb"),
    "715d41fa-1c0e-4387-ab01-e1eb4824a6cb",
  );
  assert.equal(automatedPayrollRunIdFromBatchFileName("july-payroll.xlsx"), null, "a hand-uploaded batch has no hold record");

  // ==== 43: the filing names who it leaves out ===================================================
  const countNote = heldExcludedFilingNote(countOnly) ?? "";
  assert.match(countNote, /^20 held employees are NOT in this filing/, "HEADLINE: the filing says it is short, and by how many");
  assert.match(countNote, /not recorded when this month was published/, "and admits it cannot name them for a count-only month");
  const detailNote = heldExcludedFilingNote(detailed) ?? "";
  assert.match(detailNote, /Mona Adel \(employee SI 600\.00, income tax 250\.00\)/, "a recorded person is named with their filing figures");
  assert.match(detailNote, /Omar Said\./, "and one without recorded figures is named alone");
  assert.equal(heldExcludedFilingNote({ heldExcluded: 0, held: null }), null, "nobody held, nothing said");

  const statutory = buildStatutorySummaryWorkbook({
    rows: [],
    totals: { insuredPayroll: 0, employeeSi: 0, employerSi: 0, totalSi: 0, deductedEmployeeSi: 0, incomeTax: 0, withoutWage: 0, withVariance: 0 },
    extraNotes: [countNote],
  });
  const statutoryTexts = await sheetTexts(statutory, "Statutory Summary");
  const totalAt = statutoryTexts.indexOf("TOTAL");
  const noteAt = statutoryTexts.findIndex((text) => text.includes("held employees are NOT in this filing"));
  assert.ok(totalAt >= 0 && noteAt > totalAt, "the emitted filing carries the note under its TOTAL");

  const route = readFileSync("app/api/payroll/[id]/statutory-summary/route.ts", "utf8");
  assert.match(route, /automatedPayrollRunIdFromBatchFileName\(exportData\.batch\.fileName\)/, "the export finds the run behind its batch");
  assert.match(route, /extraNotes: heldNote \? \[heldNote\] : \[\]/, "and passes the note into the filing");

  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const publish = bodyOf(runService, "export async function publishToPayslips(", 20000);
  assert.match(publish, /socialInsurance: roundCurrency\(entry\.row\.socialInsurance\)/, "publish now records a held person's filing figures");
  assert.match(publish, /employmentIncomeTax: roundCurrency\(entry\.row\.employmentIncomeTax\)/);

  // ==== 46: last month's held people are in the baseline =========================================
  const roster = bodyOf(runService, "async function previousMonthRoster(");
  assert.match(roster, /if \(leaversError\) throw leaversError;/, "a failed leavers read refuses rather than flagging every leaver");
  assert.match(roster, /readPublishedHoldRecord\(prevRun\.id\)/, "HEADLINE: the baseline reads who last month held");
  assert.match(roster, /heldPeopleFromDrafts\(prevRun\.id\)/, "and falls back to the run's draft rows for a count-only month");

  // ==== 52: last month is counted on this month's basis ===========================================
  const summary = bodyOf(runService, "async function previousMonthSummary(");
  assert.match(summary, /headcount: rows\.length \+ heldCount/, "HEADLINE: last month's headcount includes the people it held");
  assert.match(
    summary,
    /getNonEmployeePayrollRows\(prevRun\.id, valueField === "first_part" \? "first" : undefined\)/,
    "and its value includes the non-employees paid in the same scope as this month's",
  );

  const withBasis = await buildFullSheetWorkbook({
    run,
    rows: [],
    previousSummary: {
      headcount: 120,
      totalValue: 1000000,
      basis: "Last month counts 20 held employees, but its value leaves out their pay.",
    },
  });
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(withBasis as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  const summaryTexts: string[] = [];
  loaded.getWorksheet("Executive Summary")!.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === "string") summaryTexts.push(cell.value);
    });
  });
  assert.ok(
    summaryTexts.some((text) => text.includes("leaves out their pay")),
    "the Executive Summary prints a basis the two months do not share, beside the numbers",
  );
}
