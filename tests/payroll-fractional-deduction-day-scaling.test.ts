import assert from "node:assert/strict";

import {
  buildDeductionBuckets,
  candidateAmount,
  chargedDeductionDays,
  linesFor,
} from "../src/lib/automated-payroll/deductions-source.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../src/lib/deductions/types.ts";

/**
 * A PARTIAL-DAY DEDUCTION MUST NOT REACH PAYROLL AS A WHOLE DAY.
 *
 * Found 2026-08-05 on production: armed, never fired. `candidateAmount` scaled
 * the candidate's estimate by `resolveAppliedDeductionDates().length` — a COUNT
 * OF DATES — against `rawValue`, which is measured in DAYS and is routinely
 * FRACTIONAL. For CRM the two coincide (5 no-activity days = 5 dates), which is
 * why it survived review. Fingerprint breaks it: a late arrival is 0.13 days
 * carrying ONE date, so `estimate / 0.13 * 1` rescaled it to a FULL day.
 *
 * Measured on the live July 2026 ledger: 62 candidates across 21 employees,
 * 26,671.23 EGP of real deductions that would have reached the sheet as
 * 70,545.20 EGP — +43,873.97 EGP. Worst single row 14.3x (0.07 days: 15.73 ->
 * 224.71 EGP). Nothing had been charged only because every fractional row was
 * still Pending, and the payroll bridge pays "Approved for Payroll" only —
 * approving one row was all it took.
 *
 * The numbers below are the real production rows, not invented ones, so this
 * test fails with the exact figures the owner would otherwise have paid.
 */

function candidate(overrides: {
  category?: DeductionsCategory;
  compact?: string;
  rawValue: number;
  estimatedAmount: number | null;
  dates: string[];
  status?: string | null;
  appliedValue?: number | null;
  appliedAmount?: number | null;
  appliedDates?: string[] | null;
}): DeductionsCandidateWithDecision {
  return {
    id: `c-${overrides.compact ?? "b1"}-${overrides.dates.join(",")}-${overrides.rawValue}`,
    category: overrides.category ?? "fingerprint",
    sourceSystem: "fingerprint_report",
    sourceRecordId: "rec",
    candidateKey: "key",
    employeeHrId: "B-1",
    employeeHrIdCompact: overrides.compact ?? "b1",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "days",
    rawValue: overrides.rawValue,
    estimatedAmount: overrides.estimatedAmount,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "Late arrival",
    evidence: {},
    dates: overrides.dates,
    hierarchySnapshot: {},
    createdBy: "test",
    createdAt: "",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: null,
    supersededByCandidateId: null,
    hireDate: null,
    holidayBridges: [],
    decision: {
      id: "d",
      candidateId: "c",
      decisionStatus: (overrides.status ?? "Approved for Payroll") as never,
      decisionReason: "",
      hrNote: "",
      appliedValue: overrides.appliedValue ?? null,
      appliedAmount: overrides.appliedAmount ?? null,
      appliedDates: overrides.appliedDates ?? null,
      decidedBy: "admin",
      decidedAt: "",
      actorRoleAtDecision: "Super Admin",
      createdAt: "",
      updatedAt: "",
    },
  } as unknown as DeductionsCandidateWithDecision;
}

export function runPayrollFractionalDeductionDayScalingTests() {
  // ---- THE HEADLINE ROW ----------------------------------------------------
  // Ali Mohamed Ali Elsayed, July 2026: 0.13 of a day late, 377.42 EGP.
  // The bug turned this into 2,903.23 EGP — a 7.7x charge on one employee for
  // being thirteen-hundredths of a day late.
  const lateArrival = candidate({
    rawValue: 0.13,
    estimatedAmount: 377.42,
    dates: ["2026-07-06"],
  });
  assert.equal(
    candidateAmount(lateArrival),
    377.42,
    "a 0.13-day fingerprint deduction must charge its own estimate, 377.42 EGP — scaling by dates.length (1) rescales it to a full day at 2,903.23 EGP",
  );
  assert.equal(
    chargedDeductionDays(lateArrival),
    0.13,
    "the charged quantity is 0.13 DAYS, not 1 date — the step sums this into the Deduction Days column HR reads",
  );

  // The whole worst-case row, at its real magnitude: 0.07 days -> 14.3x.
  assert.equal(
    candidateAmount(candidate({ rawValue: 0.07, estimatedAmount: 15.73, dates: ["2026-07-14"] })),
    15.73,
    "the worst production row (0.07 days, 15.73 EGP) must not become 224.71 EGP",
  );

  // ---- ONE EMPLOYEE'S REAL JULY SHEET --------------------------------------
  // Ali's five fingerprint candidates: 2.13 real days / 6,183.86 EGP, which the
  // bug reported as 5 days / 14,516.11 EGP.
  const ali = buildDeductionBuckets([
    candidate({ rawValue: 0.13, estimatedAmount: 377.42, dates: ["2026-07-06"] }),
    candidate({ rawValue: 0.5, estimatedAmount: 1451.61, dates: ["2026-07-13"] }),
    candidate({ rawValue: 0.5, estimatedAmount: 1451.61, dates: ["2026-07-14"] }),
    candidate({ rawValue: 0.5, estimatedAmount: 1451.61, dates: ["2026-07-20"] }),
    candidate({ rawValue: 0.5, estimatedAmount: 1451.61, dates: ["2026-07-21"] }),
  ]);
  assert.equal(
    ali.get("b1")?.buckets.fingerprint,
    6183.86,
    "five partial-day lates total 6,183.86 EGP — the dates.length bug reported 14,516.11 EGP for the same five rows",
  );
  const aliDays = linesFor(ali, "b1", "fingerprint").reduce((sum, line) => sum + line.days, 0);
  assert.equal(
    Math.round(aliDays * 100) / 100,
    2.13,
    "the Deduction Days column must read 2.13, not 5 — one row per date is not one day per date",
  );

  // A vacation row with the same shape: 0.5 unpaid day on a single date.
  assert.equal(
    candidateAmount(
      candidate({ category: "unpaid_vacation", rawValue: 0.5, estimatedAmount: 669.35, dates: ["2026-07-09"] }),
    ),
    669.35,
    "half an unpaid vacation day is 669.35 EGP, not the 1,338.70 EGP a full day would cost",
  );

  // ---- THE FIX MUST NOT OVER-CORRECT ---------------------------------------
  // Whole-day candidates were always right, and narrowing them must still scale.
  // A fix that simply stopped scaling would silently charge cleared days.
  assert.equal(
    candidateAmount(
      candidate({
        category: "crm",
        rawValue: 4,
        estimatedAmount: 400,
        dates: ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"],
        appliedDates: ["2026-07-01", "2026-07-02"],
      }),
    ),
    200,
    "narrowing 4 whole days to 2 still halves the money — the unit fix must not disable pro-rata narrowing",
  );
  assert.equal(
    candidateAmount(
      candidate({
        category: "crm",
        rawValue: 2,
        estimatedAmount: 1000,
        dates: ["2026-07-06", "2026-07-07"],
        appliedDates: [],
      }),
    ),
    0,
    "clearing every day charges nothing — an empty selection must never be read as 'charge them all'",
  );

  // Narrowing a FRACTIONAL candidate apportions by the fraction of days kept,
  // never by a re-count of dates. 0.30 days over 3 dates, one date cleared.
  assert.equal(
    chargedDeductionDays(
      candidate({
        rawValue: 0.3,
        estimatedAmount: 300,
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        appliedDates: ["2026-07-01", "2026-07-02"],
      }),
    ),
    0.2,
    "two of three dates kept on a 0.30-day candidate charges 0.20 days — a re-count would charge 2 whole days",
  );

  // ---- THE REVIEWER'S OWN NUMBER STILL WINS --------------------------------
  assert.equal(
    chargedDeductionDays(candidate({ rawValue: 0.5, estimatedAmount: 500, dates: ["2026-07-06"], appliedValue: 0.25 })),
    0.25,
    "a stored appliedValue is the reviewer's explicit decision and outranks anything derived from dates",
  );
  assert.equal(
    candidateAmount(
      candidate({ rawValue: 0.5, estimatedAmount: 500, dates: ["2026-07-06"], appliedAmount: 123.45 }),
    ),
    123.45,
    "a decided appliedAmount is paid exactly as decided, with no rescaling of any kind",
  );

  // ---- NOTHING UNAPPROVED MOVES, WHATEVER THE ARITHMETIC -------------------
  assert.equal(
    buildDeductionBuckets([
      candidate({ rawValue: 0.13, estimatedAmount: 377.42, dates: ["2026-07-06"], status: "Pending" }),
    ]).get("b1")?.buckets.fingerprint ?? 0,
    0,
    "a Pending partial-day row still pays nothing — the day-scaling fix must not widen what reaches the sheet",
  );

  // An unresolvable estimate stays 0 rather than NaN: it must show on the step
  // where HR can see and fix it, not poison the employee's whole row.
  assert.equal(
    candidateAmount(candidate({ rawValue: 0.13, estimatedAmount: null, dates: ["2026-07-06"] })),
    0,
    "a missing base salary yields 0.00, never NaN — NaN would silently corrupt the employee's net pay",
  );
}
