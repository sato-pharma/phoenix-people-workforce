import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import { buildFinanceSheetWorkbook } from "../src/lib/automated-payroll/exports/finance-sheet.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";
import { escapeLikePattern } from "../src/lib/payroll/payslip-center.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * FOUR SCREENS THAT SAID NOTHING, AND ONE THAT SAID A CODE.
 *
 * Each of these is a surface that looked like it worked. None of them threw, none logged, and every
 * one of them left the person reading it with a wrong belief:
 *
 *  27 — "Apply changes" after a spreadsheet upload did nothing at all. The change handler clears
 *       `input.value` so re-picking the same file fires `change` again; that empties `input.files`,
 *       so Apply read `undefined`, hit its `if (file)` guard and returned. The preview stayed on
 *       screen, so the edits looked pending rather than lost.
 *  47 — the expense route says which decisions never reached payroll. This screen read only
 *       `requestDecisions.skipped`, dropped `payrollWarnings`, and printed "Approvals saved."
 *  38 — the one workbook finance executes a whole month from never mentioned holds on its cover,
 *       while held rows sat in its table being not-paid.
 *  54 — the excluded-people panel printed the raw HR code at the person it was asking HR about.
 *  55 — the Payslips Center matched an HR id with `.eq`, case-sensitively, against a database that
 *       stores them mixed-case. A lower-case search answered "no payslips", which reads as a fact
 *       about the employee rather than about the query.
 */

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const run: MonthlySalaryRun = {
  id: "run-silent-1",
  month: 9,
  year: 2026,
  monthKey: "2026-09",
  phase: "ready",
  part1ConfirmedAt: "2026-09-05T00:00:00.000Z",
  part1ConfirmedBy: "B-10",
  part2ConfirmedAt: "2026-09-20T00:00:00.000Z",
  part2ConfirmedBy: "B-10",
  publishedBatchId: null,
  publishedAt: null,
  publishedBy: null,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
};

/** A minimal AssembledRow — only the fields the sheet writer actually reads. */
function assembledRow(overrides: { hrId: string; fullName: string; onHold: boolean }): AssembledRow {
  return {
    row: {
      hrId: overrides.hrId,
      fullName: overrides.fullName,
      nameAr: "موظف",
      jobTitle: "Medical Representative",
      line: "CNS",
      area: "GZ1",
      hireDate: "2025-01-01",
      baseSalary: 10000,
      grossSalary: 12000,
      netSalary: 9000,
      monthSalary: 9000,
      firstPart: 4500,
      secondPart: 4500,
      totalDeductions: 0,
      totalAdditions: 0,
      extraCostOfLiving: 0,
      fuelAllowance: 0,
      fingerPrint: 0,
      medicalInsurance: 0,
      socialInsurance: 0,
      employmentIncomeTax: 0,
      crm: 0,
      unpaidVacations: 0,
      loans: 0,
      otherDeductions: 0,
      otherAdditions: 0,
      expenses: 0,
      incentive: 0,
      overtime: 0,
      bonus: 0,
      governmentalDeductions: 0,
      comment: null,
      paymentMode: null,
    },
    bankName: "FAB",
    bankAccount: "007111110009",
    carriedForwardApplied: 0,
    overpaidResidual: 0,
    onHold: overrides.onHold,
    holdReason: overrides.onHold ? "Paid by hand this month" : null,
  } as unknown as AssembledRow;
}

/** The Cover sheet read back out of the EMITTED workbook, as {label: value}. */
async function readCover(buffer: Buffer): Promise<Map<string, string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Cover");
  assert.ok(sheet, "the finance workbook must still carry a Cover sheet");
  const cover = new Map<string, string>();
  sheet!.eachRow((row) => {
    const label = String(row.getCell(1).value ?? "").trim();
    const value = String(row.getCell(2).value ?? "").trim();
    if (label) cover.set(label, value);
  });
  return cover;
}

export async function runPayrollSilentScreensTests() {
  // ==== 27: a button that did nothing at all =====================================================
  const step = stripComments(source("src/components/automated-payroll/recommendation-step.tsx"));
  assert.doesNotMatch(
    step,
    /const file = fileRef\.current\?\.files\?\.\[0\];/,
    "HEADLINE: Apply changes must never read the file back off the input — the change handler has already emptied it, which is why the button did nothing",
  );
  assert.match(
    step,
    /setPendingUpload\(file\);\s*void onUpload\(file, false\);/,
    "the previewed workbook is remembered before input.value is cleared",
  );
  assert.match(
    step,
    /void onUpload\(pendingUpload, true\);/,
    "HEADLINE: Apply changes commits the workbook the preview describes",
  );
  assert.match(
    step,
    /disabled=\{busy \|\| !pendingUpload\}/,
    "and cannot be pressed when there is nothing to apply, instead of silently doing nothing",
  );
  assert.match(
    step,
    /The uploaded file is no longer available/,
    "a lost file says so out loud rather than no-opping — the whole shape of this defect",
  );
  const commitBranch = step.slice(step.indexOf("if (commit) {"));
  assert.match(
    commitBranch.slice(0, 200),
    /setPendingUpload\(null\);/,
    "a committed upload is forgotten, so the next preview cannot apply the previous file",
  );

  // ==== 47: a warning the server sent and the screen threw away ==================================
  // Rebuilt 2026-11-07: the save loop is the hook's, the banner is review-banners.tsx.
  const workspace = stripComments(
    source("src/components/outstation/expense-review/use-expense-review.ts") +
      source("src/components/outstation/expense-review/review-banners.tsx"),
  );
  assert.match(
    workspace,
    /const warnings = payload\?\.payrollWarnings;/,
    "HEADLINE: the screen reads the payroll warnings the route has been sending all along",
  );
  assert.match(
    workspace,
    /setSavePayrollWarnings\(\[\.\.\.new Set\(payrollNotApplied\)\]\)/,
    "and keeps them for the banner rather than dropping them on the floor",
  );
  assert.match(
    workspace,
    /savePayrollWarnings\.map\(\(line\) => \(/,
    "HEADLINE: every warning is rendered, not counted",
  );
  assert.match(
    workspace,
    /saveSkipped\.length > 0 \|\| savePayrollWarnings\.length > 0\s*\?\s*"warning"/,
    "HEADLINE: a save that did not reach payroll never wears a green tick",
  );

  // ==== 38: the cover of the document the month is executed from =================================
  // Read from the EMITTED workbook, never from the source: a cover row can be built and still not
  // reach the file, and this is the one document finance pays a month from.
  const held = await buildFinanceSheetWorkbook({
    run,
    rows: [
      assembledRow({ hrId: "B-1", fullName: "Paid Normally", onHold: false }),
      assembledRow({ hrId: "B-7", fullName: "Held This Month", onHold: true }),
    ],
    scope: "full",
  });
  const heldCover = await readCover(held);
  const heldLine = heldCover.get("On hold");
  assert.ok(heldLine, "HEADLINE: the finance cover must say how many people are on hold");
  assert.match(heldLine!, /^1 of 2\b/, "it counts them against the headcount printed beside it");
  assert.match(heldLine!, /NOT paid by this run/, "and says plainly that a held row is not paid");
  assert.match(
    heldLine!,
    /SECOND part is owed, not the whole month/,
    "HEADLINE: the cover carries the rule that stops a held person being paid twice",
  );

  const clean = await buildFinanceSheetWorkbook({
    run,
    rows: [assembledRow({ hrId: "B-1", fullName: "Paid Normally", onHold: false })],
    scope: "full",
  });
  const cleanCover = await readCover(clean);
  assert.match(
    String(cleanCover.get("On hold") ?? ""),
    /^None/,
    "a month with no holds says so, so the line's absence can never be read as 'none'",
  );
  assert.equal(cleanCover.get("Employees"), "1", "the existing provenance rows are untouched");
  assert.ok(
    String(cleanCover.get("Protection") ?? "").includes("Finance Edit"),
    "and so is the protection promise finding 40 pinned",
  );

  // ==== 54: a code where a name belongs =========================================================
  const service = stripComments(source("src/lib/automated-payroll/run-service.ts"));
  assert.match(
    service,
    /excludedPeople: excluded\.map\(\(row\) => \(\{/,
    "HEADLINE: the run view names who is excluded, because a draft row carries only the code",
  );
  assert.match(
    service,
    /fullName: names\.get\(compactHrKey\(row\.employeeHrId\)\) \|\| row\.employeeHrId,/,
    "matched on the compact key, because HR ids are stored mixed-case — and falling back to the code, so nobody vanishes",
  );
  const wizard = stripComments(source("src/components/automated-payroll/automated-payroll-wizard.tsx"));
  // Scoped to the excluded panel on purpose: the disappeared-people callout above it renders the
  // same name-then-code shape, so an unscoped match would stay green with this panel back on codes.
  const excludedPanel = wizard.slice(wizard.indexOf("{excludedPeople.map((person) => ("));
  assert.ok(excludedPanel.length > 0, "the excluded panel must still render from excludedPeople");
  assert.match(
    excludedPanel.slice(0, 900),
    /<span className="font-semibold">\{person\.fullName\}<\/span> \(\{person\.hrId\}\)/,
    "HEADLINE: the excluded panel shows the person, then the code — never the code alone",
  );
  assert.match(
    wizard,
    /submitInclude\(person\.hrId, person\.fullName\)/,
    "and re-including them says their name back, rather than their code twice",
  );

  // ==== 55: a search that answered 'no payslips' about the query ================================
  const centre = stripComments(source("src/lib/payroll/payslip-center.ts"));
  assert.doesNotMatch(
    centre,
    /base\.eq\(column, query\)/,
    "HEADLINE: an HR id search must not be case-sensitive — the ids are mixed-case, so a lower-case search found nothing and read as 'this person has no payslips'",
  );
  assert.match(
    centre,
    /base\.ilike\(column, escapeLikePattern\(query\)\)/,
    "HEADLINE: it matches the WHOLE id ignoring case — ilike with no wildcard is equality that ignores case",
  );
  assert.doesNotMatch(
    centre,
    /base\.ilike\(column, `%\$\{query\}%`\)/,
    "and the name search escapes its input too, so a typed wildcard stays a character",
  );

  assert.equal(escapeLikePattern("B-10"), "B-10", "an ordinary HR id passes through untouched");
  assert.equal(escapeLikePattern("A_5"), "A\\_5", "an underscore is a LIKE wildcard and must be escaped");
  assert.equal(escapeLikePattern("50%"), "50\\%", "so is a percent");
  assert.equal(escapeLikePattern("A*5"), "A\\*5", "and a star, which PostgREST turns into a percent");
}
