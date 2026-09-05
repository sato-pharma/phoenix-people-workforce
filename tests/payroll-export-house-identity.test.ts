import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { buildFullSheetWorkbook, buildPart1SheetWorkbook, PART1_HEADERS } from "../src/lib/automated-payroll/exports/sheet.ts";
import { buildStepTemplateWorkbook, stepTemplateColumns } from "../src/lib/automated-payroll/exports/step-template.ts";
import { parseStepWorkbook } from "../src/lib/automated-payroll/imports/step-parser.ts";
import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { MonthlySalaryRun, StepRow } from "../src/lib/automated-payroll/types.ts";
import { buildSalaryBatchWorkbook } from "../src/lib/payroll/salary-batch-workbook.ts";
import { resolvePayrollBands, PAYROLL_SECTION_ROW } from "../src/lib/payroll/payroll-sheet-style.ts";
import { payrollSheetHeaders } from "../src/lib/payroll/salary-sheet-fields.ts";
import type { SalaryBatch, SalaryRecord } from "../src/lib/payroll/types.ts";

// The payroll pack renders the same columns in four places, so the failure modes are the ones
// where one rendering quietly disagrees with the data underneath it:
//
//   1. a section caption sitting over the WRONG money. The bands are defined as absolute column
//      numbers over the full 37-column list, but the Part-1 sheet writes a SUBSET — so copying
//      those positions would print "Governmental Deductions" over Finger Print and Medical
//      Insurance, which is a confident caption naming the wrong figures.
//   2. HELD carried by colour alone. A held row is dropped at publish — no salary record, no trace
//      of a payment made outside the system — and a red fill does not survive greyscale, a copied
//      range, or a reader who cannot see it.
//   3. the step template's ROUND TRIP breaking. It grew a caption row above its header; the
//      parser finds the header by scanning for a cell reading "hrid", so a caption that normalized
//      to that would silently make the band row the header and every edit would vanish.

const run: MonthlySalaryRun = {
  createdAt: "", createdBy: null, id: "run-1", month: 7, monthKey: "2026-07",
  part1ConfirmedAt: null, part1ConfirmedBy: null, part2ConfirmedAt: null, part2ConfirmedBy: null,
  phase: "part1", publishedAt: null, publishedBatchId: null, publishedBy: null,
  updatedAt: "", year: 2026,
};

function assembled(overrides: { hrId: string; fullName: string; onHold?: boolean }): AssembledRow {
  return {
    bankAccount: "EG1", bankName: "CIB", carriedForwardApplied: 0, compact: overrides.hrId.toLowerCase(),
    lifecycle: "regular", onHold: overrides.onHold ?? false, overpaidResidual: 0,
    row: {
      area: "Cairo", baseSalary: 12000, bonus: 0, calendarDays: 31, crm: 0, employmentIncomeTax: 640,
      expenses: 0, extraCostOfLiving: 500, fingerPrint: 0, firstPart: 6000, fuelAllowance: 800,
      fullName: overrides.fullName, governmentalDeductions: 1140, grossSalary: 13140,
      hireDate: "2022-06-01", hrId: overrides.hrId, incentive: 0, jobTitle: "Medical Rep",
      line: "CNS", loans: 0, medicalInsurance: 0, monthSalary: 12000, nameAr: null, netSalary: 13300,
      otherAdditions: 0, otherDeductions: 0, overtime: 0, paymentMode: "two_parts",
      payrollComment: null, row: 1, secondPart: 6000, socialInsurance: 500, totalAdditions: 1300,
      totalDeductions: 1140, unpaidVacations: 0, workingDays: 26,
    },
  } as AssembledRow;
}

async function load(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

/** The band caption covering a given column number, read off the sheet itself. */
function captionAt(sheet: ExcelJS.Worksheet, column: number): string {
  const row = sheet.getRow(PAYROLL_SECTION_ROW);
  for (let candidate = column; candidate >= 1; candidate -= 1) {
    const text = String(row.getCell(candidate).value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function columnOf(sheet: ExcelJS.Worksheet, header: string): number {
  const headerRow = sheet.getRow(5);
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    if (String(headerRow.getCell(column).value ?? "").trim() === header) return column;
  }
  return -1;
}

export async function runPayrollExportHouseIdentityTests() {
  // ── 1. bands are resolved from the headers actually written ──────────────────
  const fullBands = resolvePayrollBands([...payrollSheetHeaders]);
  assert.equal(fullBands[0].label, "Employee Data");
  assert.equal(fullBands[0].from, 1);
  assert.ok(
    fullBands.some((band) => band.label === "Governmental Deductions"),
    "the full sheet carries every section",
  );

  const part1Bands = resolvePayrollBands(PART1_HEADERS);
  const bandFor = (header: string) => {
    const index = PART1_HEADERS.indexOf(header as never);
    assert.ok(index >= 0, `${header} should be on the Part-1 sheet`);
    const band = part1Bands.find((candidate) => candidate.from <= index + 1 && candidate.to >= index + 1);
    return band?.label ?? "";
  };
  // THE REGRESSION. Finger Print sits at column 27 of the canonical list, inside "Internal
  // Deductions" — but at a much earlier position on the Part-1 subset, where the absolute band
  // numbers would have captioned it "Governmental Deductions".
  assert.equal(bandFor("Finger Print"), "Internal Deductions");
  assert.equal(bandFor("Medical Insurance"), "Internal Deductions");
  assert.equal(bandFor("Base Salary"), "Fixed Salary");
  assert.equal(bandFor("First Part"), "Payment Split");

  // Appended columns are captioned as appended, never folded into the last real section.
  const withExtras = resolvePayrollBands(PART1_HEADERS, ["Bank Name", "Bank Account"]);
  const last = withExtras[withExtras.length - 1];
  assert.equal(last.label, "Added for this download");
  assert.equal(last.to, PART1_HEADERS.length + 2);

  // ── 2. the same captions really reach the sheet, over the right columns ──────
  const rows = [
    assembled({ fullName: "Paid Person", hrId: "A-1" }),
    assembled({ fullName: "Held Person Example", hrId: "B-7", onHold: true }),
  ];
  const part1Buffer = await buildPart1SheetWorkbook({ rows, run });
  const part1 = await load(part1Buffer);
  const part1Sheet = part1.getWorksheet("Part 1");
  assert.ok(part1Sheet, "the Part 1 sheet must exist");
  assert.equal(
    captionAt(part1Sheet, columnOf(part1Sheet, "Finger Print")),
    "INTERNAL DEDUCTIONS",
    "the caption printed above Finger Print must name the section it truly belongs to",
  );

  // ── 3. HELD is carried by words, not only by colour ──────────────────────────
  const fullBuffer = await buildFullSheetWorkbook({ rows, run });
  const full = await load(fullBuffer);

  const cover = full.getWorksheet("Cover");
  assert.ok(cover, "a cover sheet must exist");
  const coverText: string[] = [];
  cover.eachRow((row) => {
    row.eachCell((cell) => coverText.push(String(cell.value ?? "")));
  });
  const joined = coverText.join(" | ");
  assert.match(
    joined,
    /Held · B-7/,
    "the cover must NAME each held person — a count does not say who is unpaid",
  );
  assert.match(
    joined,
    /SECOND part/,
    "and must say what is owed: the second part only, since paying full net would pay part one twice",
  );

  const payroll = full.getWorksheet("Payroll");
  assert.ok(payroll, "the payroll sheet must exist");
  const hrIdColumn = columnOf(payroll, "HR_ID");
  let heldNoted = false;
  payroll.eachRow((row) => {
    if (String(row.getCell(hrIdColumn).value ?? "") !== "B-7") return;
    const note = row.getCell(hrIdColumn).note;
    assert.ok(note, "the held row must carry a note saying what held costs");
    assert.match(String(JSON.stringify(note)), /dropped at publish/i);
    heldNoted = true;
  });
  assert.ok(heldNoted, "the held row must be present on the sheet");

  // ── 4. the step template still round-trips through the REAL parser ───────────
  const stepRows: StepRow[] = [
    {
      context: { "Days Worked": 4, "Hire Date": "2026-08-24", "Net Salary": 18000 },
      fullName: "Test Joiner", hrId: "HR-009", jobTitle: "Medical Rep", line: "CNS",
      onHold: false, reason: null,
      recommended: { baseForMonth: 2322.58, ecolPaid: 217.74, fuelPaid: 72.58 },
      values: { baseForMonth: 9000, ecolPaid: 500, fuelPaid: 250 },
    },
  ];
  const stepBuffer = await buildStepTemplateWorkbook({ rows: stepRows, run, stepKey: "p1_new_hires" });
  const parsed = await parseStepWorkbook({
    file: new File([stepBuffer as unknown as BlobPart], "step.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    stepKey: "p1_new_hires",
  });
  assert.equal(
    parsed.invalidHrIds,
    0,
    "the caption row above the header must not be mistaken for the header — the parser scans for " +
      "a cell reading \"hrid\", so a caption normalizing to that would swallow every edit",
  );
  assert.equal(parsed.edits.length, 1, "the edited row must come back");
  assert.deepEqual(parsed.edits[0].values, { baseForMonth: 9000, ecolPaid: 500, fuelPaid: 250 });

  // Read-only columns are LOCKED, not merely shaded — the upload parses editable labels only, so
  // an edit anywhere else used to be accepted by the sheet and then thrown away.
  const stepWorkbook = await load(stepBuffer);
  const stepSheet = stepWorkbook.worksheets[0];
  const columns = stepTemplateColumns("p1_new_hires");
  const firstDataRow = stepSheet.getRow(6);
  //
  // Asserted as "is it explicitly UNLOCKED", not "is locked === true": locked is Excel's default,
  // so ExcelJS omits it from the XML and it reads back undefined. Only `locked: false` is written.
  // Testing for `true` would have failed on a correctly locked sheet — and, worse, a test written
  // the other way round would pass on a sheet with no protection at all.
  columns.forEach((column, index) => {
    const locked = firstDataRow.getCell(index + 1).protection?.locked;
    if (column.editable) {
      assert.equal(locked, false, `"${column.label}" is typed into, so it must be explicitly unlocked`);
    } else {
      assert.notEqual(
        locked,
        false,
        `"${column.label}" is never parsed back, so it must not be left unlocked`,
      );
    }
  });
  assert.ok(
    columns.some((column) => column.editable),
    "the fixture must contain at least one editable column, or the check above proves nothing",
  );

  // ── 5. the batch download, and every emitted artifact, is structurally clean ─
  const batch: SalaryBatch = {
    approvedAt: "2026-08-01T00:00:00Z", approvedBy: null, createdAt: "2026-08-01T00:00:00Z",
    fileName: "july.xlsx", id: "batch-1", lockedAt: null, month: 7, part1PaidAt: null,
    part1PaidBy: null, part2ReadyAt: null, part2ReadyBy: null, rejectedReason: null,
    status: "approved", uploadedBy: null, year: 2026,
  };
  const record = {
    area: "Cairo", baseSalary: 12000, batchId: "batch-1", bonus: 0, calendarDays: 31, crm: 0,
    employeeCode: "A-1", employmentIncomeTax: 640, expenses: 0, extraCostOfLiving: 500,
    fingerPrint: 0, firstPart: 6000, fuelAllowance: 800, fullName: "Paid Person",
    governmentalDeductions: 1140, grossSalary: 13140, hireDate: "2022-06-01", hrId: "A-1",
    id: "rec-1", incentive: 0, jobTitle: "Medical Rep", line: "CNS", loans: 0, medicalInsurance: 0,
    monthSalary: 12000, nameAr: null, netSalary: 13300, otherAdditions: 0, otherDeductions: 0,
    overtime: 0, paymentMode: "two_parts", payrollComment: null, secondPart: 6000,
    socialInsurance: 500, totalAdditions: 1300, totalDeductions: 1140, unpaidVacations: 0,
  } as unknown as SalaryRecord;

  const batchBuffer = await buildSalaryBatchWorkbook({ batch, records: [record] });
  const batchWorkbook = await load(batchBuffer);
  const batchCover = batchWorkbook.getWorksheet("Cover");
  assert.ok(batchCover, "the batch download must carry a cover");
  const batchCoverText: string[] = [];
  batchCover.eachRow((row) => {
    row.eachCell((cell) => batchCoverText.push(String(cell.value ?? "")));
  });
  assert.match(
    batchCoverText.join(" | "),
    /Held people are NOT here/,
    "a published batch excludes held people entirely, so the row count is who was PAID — the " +
      "cover has to say so, or the number invites the opposite conclusion",
  );

  for (const [label, buffer] of [
    ["full sheet", fullBuffer],
    ["part 1 sheet", part1Buffer],
    ["step template", stepBuffer],
    ["salary batch", batchBuffer],
  ] as Array<[string, ArrayBuffer | Buffer]>) {
    // `Buffer.from` has no overload for the union — the three sheet builders hand back a Buffer and
    // the batch builder an ArrayBuffer, so narrow before converting rather than casting the call.
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const problems = await checkWorkbook(bytes, { quiet: true });
    assert.deepEqual(problems, [], `${label} must be structurally clean: ${problems.join("; ")}`);
  }
}
