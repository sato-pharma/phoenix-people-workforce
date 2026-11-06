import assert from "node:assert/strict";

import { assembleRows } from "../src/lib/automated-payroll/assemble.ts";
import {
  auditPayrollDataQuality,
  describePayrollDataQuality,
  PAYROLL_DATA_ISSUE_LABELS,
} from "../src/lib/automated-payroll/data-quality.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow, PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * Guards the missing-payroll-data gate, and the frozen-Part-1 fix beside it.
 *
 * Both come from one audit of the LIVE July 2026 run (2026-08-04). The owner
 * opened the sheet and found employees hired in August being paid a full July
 * month. PR #1710 fixed the dated case; two more kept appearing because their
 * hire_date is NULL and a null cannot be compared.
 *
 * Pulling that thread found one root cause behind four defects: payroll trusts
 * employee-master fields nobody validated, and each missing field silently
 * becomes a DEFAULT THAT PAYS MONEY —
 *
 *   no hire date    -> not a joiner -> "regular" -> a full unprorated month
 *   no salary       -> renders 0.00, indistinguishable from a real zero
 *   no payment mode -> a default decides the First/Second Part split
 *   joined after the Part 1 freeze -> assemble.ts recomputed the first part
 *                      LIVE, silently moving a total finance had already paid
 *
 * None of these throw, log, or look wrong on screen. That is exactly why they
 * survived, and it is why this test asserts on the DETECTION, not on a symptom.
 *
 * Real employees behind the fixtures, from the live run:
 *   AI-0005 Mahmoud Abdelreheem — no hire date, no salary
 *   AI-0006 Mohamed Yasser      — no hire date, no salary
 *   B-165   Gannatallah Amer    — no hire date, no payment mode, 17,500 net
 */

const PERIOD: PayrollPeriod = { month: 7, year: 2026 };

function employee(hrId: string, overrides: Partial<EmployeeDirectoryRow> = {}): EmployeeDirectoryRow {
  return {
    hrId,
    fullName: `Employee ${hrId}`,
    nameAr: null,
    jobTitle: "Medical Representative",
    lineName: "Line 1",
    areaName: "Cairo",
    hireDate: "2024-01-01",
    medicalInsurance: 0,
    bankName: "NBE",
    bankAccount: "123456",
    lastWorkingDate: null,
    ...overrides,
  } as unknown as EmployeeDirectoryRow;
}

function member(hrId: string, overrides: Partial<EmployeeDirectoryRow> = {}): PopulationMember {
  return {
    employee: employee(hrId, overrides),
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function sources(
  entries: Array<{
    hrId: string;
    baseSalary?: number | null;
    paymentMode?: string | null;
    hasAnyRawCompensationFigure?: boolean;
  }>,
): Map<string, PayrollSalarySource> {
  const map = new Map<string, PayrollSalarySource>();
  for (const entry of entries) {
    const source = {
      baseSalary: entry.baseSalary === undefined ? 14000 : entry.baseSalary,
      extraCostOfLiving: 0,
      fuelAllowance: 0,
      netSalary: entry.baseSalary === undefined ? 16500 : entry.baseSalary,
      grossSalary: entry.baseSalary === undefined ? 14000 : entry.baseSalary,
      socialInsurance: 0,
      employmentIncomeTax: 0,
      paymentMode: entry.paymentMode === undefined ? "two_parts" : entry.paymentMode,
      hasAnyRawCompensationFigure: entry.hasAnyRawCompensationFigure,
    } as unknown as PayrollSalarySource;
    map.set(entry.hrId.toLowerCase(), source);
    map.set(entry.hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""), source);
  }
  return map;
}

function draft(hrId: string, patch: Partial<DraftRow> = {}): DraftRow {
  return {
    runId: "run-1",
    employeeHrId: hrId,
    employeeHrIdCompact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    daysWorked: null,
    baseForMonth: null,
    ecolPaid: null,
    fuelPaid: null,
    fingerprintDays: null,
    fingerprintValue: null,
    expenses: null,
    expensesNote: null,
    incentive: null,
    bonus: null,
    overtime: null,
    unpaidVacations: null,
    crm: null,
    manualOtherDeductions: null,
    manualReason: null,
    additionsReason: null,
    resignationCrmDays: null,
    p1odCrmDays: null,
    p1odCrmValue: null,
    p1odCrmReason: null,
    p1odVacationDays: null,
    p1odVacationValue: null,
    p1odVacationReason: null,
    p1odNoRecordDays: null,
    p1odNoRecordValue: null,
    p1odNoRecordReason: null,
    p1odLoanDays: null,
    p1odLoanValue: null,
    p1odLoanReason: null,
    p1odOtherDays: null,
    p1odOtherValue: null,
    p1odOtherReason: null,
    specialDeductionDays: null,
    specialDeductionValue: null,
    specialAdditionDays: null,
    specialAdditionValue: null,
    specialSituationPart: null,
    firstPartFrozen: null,
    // Not frozen: these fixtures stand before Part 1 confirm, so the live rule still answers.
    settledInPart1: null,
    onHold: false,
    holdReason: null,
    excluded: false,
    excludedReason: null,
    source: "inline",
    editedBy: null,
    updatedAt: "",
    ...patch,
  };
}

export function runAutomatedPayrollDataQualityTests() {
  // ---- a clean employee must produce NOTHING -------------------------------
  // The most important negative: a gate that fires on everyone is a gate people
  // learn to click through, which is worse than no gate at all.
  const clean = auditPayrollDataQuality({
    members: [member("B-1")],
    sources: sources([{ hrId: "B-1" }]),
    draftRows: [draft("B-1", { firstPartFrozen: 7000 })],
    part1Confirmed: true,
  });
  assert.equal(clean.total, 0, "a fully-populated employee must raise no issue at all");
  assert.equal(describePayrollDataQuality(clean), "No missing payroll data.");

  // ---- the three real employees from the live July run ---------------------
  const report = auditPayrollDataQuality({
    members: [
      member("AI-0005", { fullName: "Mahmoud Abdelreheem", hireDate: null }),
      member("AI-0006", { fullName: "Mohamed Yasser", hireDate: null }),
      member("B-165", { fullName: "Gannatallah Amer", hireDate: null }),
      member("B-1"),
    ],
    sources: sources([
      { hrId: "AI-0005", baseSalary: null },
      { hrId: "AI-0006", baseSalary: null },
      { hrId: "B-165", baseSalary: 15000, paymentMode: null },
      { hrId: "B-1" },
    ]),
    draftRows: [
      draft("AI-0005"),
      draft("AI-0006"),
      draft("B-165"),
      draft("B-1", { firstPartFrozen: 7000 }),
    ],
    part1Confirmed: true,
  });

  assert.equal(report.total, 3, "exactly the three broken employees — the clean one must not be swept in");
  const byHrId = new Map(report.rows.map((row) => [row.hrId, row]));

  // AI-0005 / AI-0006: no hire date AND no salary. The hire date is the one that
  // pays a full month they never worked; the salary is the one that renders 0.00.
  for (const hrId of ["AI-0005", "AI-0006"]) {
    const row = byHrId.get(hrId);
    assert.ok(row, `${hrId} must be flagged`);
    assert.ok(
      row!.issues.includes("missing_hire_date"),
      `${hrId} has no hire date — without this flag they are paid a FULL UNPRORATED month they never worked`,
    );
    assert.ok(row!.issues.includes("missing_salary"), `${hrId} has no salary — they would be paid 0.00`);
    assert.ok(
      row!.issues.includes("joined_after_part1"),
      `${hrId} has no frozen first part on a confirmed run — they were not in the executed Part 1`,
    );
  }

  // B-165 is the one that must NOT be dropped from a sheet: a real employee with
  // a real salary whose record is simply incomplete (owner decision: keep, flag).
  const gannatallah = byHrId.get("B-165");
  assert.ok(gannatallah, "B-165 must be flagged");
  assert.ok(
    gannatallah!.issues.includes("missing_payment_mode"),
    "B-165 has no payment mode — a DEFAULT is deciding her First/Second Part split, on a 17,500 net",
  );
  assert.ok(!gannatallah!.issues.includes("missing_salary"), "B-165 does have a salary — do not over-flag");

  // The payroll builder hands over an ALREADY-NORMALISED mode — a missing one arrives as "two_parts" —
  // so the fixture above, with a raw null, never matched production. 17 of 142 active employees had
  // no mode on record and none was ever flagged (owner, 2026-11-07: warn on it).
  const normalisedSource = { ...sources([{ hrId: "B-170" }]).get("b-170")!, paymentModeOnRecord: false };
  const recordedSource = { ...sources([{ hrId: "B-171" }]).get("b-171")!, paymentModeOnRecord: true };
  const asBuilt = auditPayrollDataQuality({
    members: [member("B-170"), member("B-171")],
    sources: new Map([
      ["b-170", normalisedSource],
      ["b170", normalisedSource],
      ["b-171", recordedSource],
      ["b171", recordedSource],
    ]),
    draftRows: [draft("B-170", { firstPartFrozen: 7000 }), draft("B-171", { firstPartFrozen: 7000 })],
    part1Confirmed: true,
  });
  const asBuiltByHrId = new Map(asBuilt.rows.map((row) => [row.hrId, row]));
  assert.ok(
    asBuiltByHrId.get("B-170")?.issues.includes("missing_payment_mode"),
    "HEADLINE: a mode normalised to two parts with nothing on record is still flagged",
  );
  assert.ok(!asBuiltByHrId.has("B-171"), "and a mode that is on record is not");

  // ---- net-salary-only new hires must NOT read as "no salary" --------------
  // Real case, owner-reported 2026-08-08: 6 August new hires whose entered net
  // salary exactly equals their title's standard allowances (e.g. a Medical Rep's
  // 2500 = 2000 cost-of-living + 500 fuel), so the derived base salary is exactly
  // zero even though the employee record plainly has a compensation figure on
  // it. Confusing that with "nothing entered at all" is itself misleading — the
  // banner used to say "would be paid 0.00", which is false for this month (new
  // hires are prorated from NET, not base); what is actually true is that every
  // future day-rate deduction for them will compute as 0 until a base salary is
  // added.
  const zeroBaseReport = auditPayrollDataQuality({
    members: [
      member("PD-0007", { fullName: "Bahaa Gamal" }),
      member("A-12", { fullName: "Ali Mohamed Ali Elsayed" }),
    ],
    sources: sources([
      { hrId: "PD-0007", baseSalary: 0, hasAnyRawCompensationFigure: true },
      { hrId: "A-12", baseSalary: null, hasAnyRawCompensationFigure: false },
    ]),
    draftRows: [draft("PD-0007", { firstPartFrozen: 0 }), draft("A-12", { firstPartFrozen: 0 })],
    part1Confirmed: true,
  });
  const byZeroBaseHrId = new Map(zeroBaseReport.rows.map((row) => [row.hrId, row]));

  const netOnlyRow = byZeroBaseHrId.get("PD-0007");
  assert.ok(netOnlyRow, "PD-0007 (net salary present, zero derived base) must still be flagged");
  assert.ok(
    netOnlyRow!.issues.includes("zero_base_after_allowances"),
    "a net salary that nets to a zero base must get the accurate label, not the blanket 'no salary' one",
  );
  assert.ok(
    !netOnlyRow!.issues.includes("missing_salary"),
    "PD-0007 has a real compensation figure on record — 'no salary on record' would be false",
  );

  const noneRow = byZeroBaseHrId.get("A-12");
  assert.ok(noneRow, "A-12 (nothing on record at all) must still be flagged");
  assert.ok(
    noneRow!.issues.includes("missing_salary"),
    "an employee with truly nothing entered must keep the original 'no salary on record' label",
  );
  assert.ok(
    !noneRow!.issues.includes("zero_base_after_allowances"),
    "A-12 never had a raw figure to net against allowances — the net-only label must not apply",
  );
  assert.ok(
    PAYROLL_DATA_ISSUE_LABELS.zero_base_after_allowances.length > 10,
    "zero_base_after_allowances needs a plain-English label",
  );
  assert.doesNotMatch(
    PAYROLL_DATA_ISSUE_LABELS.zero_base_after_allowances,
    /paid 0\.00/,
    "this label must not claim they would be paid 0.00 — this month's pay is usually fine, only future day-rate deductions are the real risk",
  );

  // ---- part1Confirmed gates the frozen check -------------------------------
  // Before the freeze NOBODY is frozen, so flagging it would fire on the whole
  // company and drown the real signal.
  const beforeFreeze = auditPayrollDataQuality({
    members: [member("B-1")],
    sources: sources([{ hrId: "B-1" }]),
    draftRows: [draft("B-1")],
    part1Confirmed: false,
  });
  assert.equal(
    beforeFreeze.total,
    0,
    "a missing frozen first part is only meaningful AFTER Part 1 is confirmed — before that it is every employee",
  );

  // Every issue must have a human label; a code with no sentence is useless in a banner.
  for (const row of report.rows) {
    for (const issue of row.issues) {
      assert.ok(PAYROLL_DATA_ISSUE_LABELS[issue]?.length > 10, `${issue} needs a plain-English label`);
    }
  }
  assert.match(describePayrollDataQuality(report), /3 employee\(s\) have missing payroll data/);

  // ---- F3: a confirmed Part 1 must never be recomputed ----------------------
  // Somebody who entered the population after the freeze was NOT in the first
  // installment finance executed. Recomputing one for them silently moves a
  // total that has already been paid.
  const lateJoiner = [member("B-9")];
  const lateSources = sources([{ hrId: "B-9" }]);
  const lateDrafts = [draft("B-9")]; // firstPartFrozen: null

  const afterFreeze = assembleRows({
    members: lateJoiner,
    sources: lateSources,
    draftRows: lateDrafts,
    period: PERIOD,
    part1Confirmed: true,
  })[0];
  assert.equal(
    afterFreeze.row.firstPart,
    0,
    "an employee with no frozen first part on a CONFIRMED run gets 0 — they were not in the executed Part 1",
  );
  assert.equal(
    Math.round((afterFreeze.row.firstPart + afterFreeze.row.secondPart) * 100) / 100,
    afterFreeze.row.monthSalary,
    "the split invariant must still hold: their whole month simply pays in Part 2",
  );

  // ...and the PREVIEW must not break. While Part 1 is open, computing live is
  // correct and is the only thing HR has to look at.
  const beforeFreezeRow = assembleRows({
    members: lateJoiner,
    sources: lateSources,
    draftRows: lateDrafts,
    period: PERIOD,
    part1Confirmed: false,
  })[0];
  assert.ok(
    beforeFreezeRow.row.firstPart > 0,
    "while Part 1 is still open the first part must be computed live — otherwise the whole preview reads 0",
  );
}
