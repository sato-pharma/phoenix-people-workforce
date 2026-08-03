import assert from "node:assert/strict";

import {
  buildDeductionBuckets,
  candidateAmount,
  linesFor,
} from "../src/lib/automated-payroll/deductions-source.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import { stepPhase } from "../src/lib/automated-payroll/types.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../src/lib/deductions/types.ts";

/**
 * Guards the bridge from the Deductions module to the payroll sheet (owner-
 * reported 2026-08-03).
 *
 * THE BUG THIS CLOSES. Two deduction systems shipped with table names one letter
 * apart — `deductions_candidates` (the workspace HR confirms in) and
 * `deduction_candidates` (the older governance flow). Payroll read the second.
 * Measured on production for July 2026: 32 employees and 34,443.50 EGP approved
 * in the workspace against 8,480.60 EGP across 9 employees in the payroll run,
 * with exactly ONE employee agreeing. The two had never been connected.
 *
 * What matters most here is not the arithmetic — it is WHICH CANDIDATES COUNT.
 *
 * OWNER RULE, 2026-08-03: "only the deductions I confirmed to payroll will
 * appear in Automated Payroll." Every category, without exception, reaches the
 * sheet only on "Approved for Payroll".
 *
 * This deliberately DIVERGES from the Deductions module's own
 * `isEligibleForPublish`, which treats `crm` as mandatory and counts it while
 * still Pending. That rule still governs the module's Overview and its publish
 * snapshot — it does not govern payroll. The trigger was concrete: one
 * undecided July CRM row would have charged an employee 8,709.68 EGP with no
 * decision recorded against it.
 *
 * The failure this pins is therefore money leaving the company that nobody
 * approved. It must fail CLOSED — an unknown or missing status pays nothing.
 */

function candidate(overrides: {
  category: DeductionsCategory;
  compact?: string;
  rawValue?: number;
  estimatedAmount?: number | null;
  dates?: string[];
  unit?: "days" | "amount";
  status?: string | null;
  appliedAmount?: number | null;
  appliedDates?: string[] | null;
  supersededAt?: string | null;
}): DeductionsCandidateWithDecision {
  const dates = overrides.dates ?? ["2026-07-06", "2026-07-07"];
  return {
    id: `${overrides.category}-${overrides.compact ?? "b1"}-${dates.join(",")}`,
    category: overrides.category,
    sourceSystem: "test",
    sourceRecordId: "rec",
    candidateKey: "key",
    employeeHrId: "B-1",
    employeeHrIdCompact: overrides.compact ?? "b1",
    employeeName: "Test Employee",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: overrides.unit ?? "days",
    rawValue: overrides.rawValue ?? dates.length,
    estimatedAmount: overrides.estimatedAmount === undefined ? 1000 : overrides.estimatedAmount,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "No CRM activity",
    evidence: {},
    dates,
    hierarchySnapshot: {},
    createdBy: "test",
    createdAt: "",
    refreshedAt: null,
    lockedAt: null,
    supersededAt: overrides.supersededAt ?? null,
    supersededByCandidateId: null,
    hireDate: null,
    holidayBridges: [],
    decision:
      overrides.status === undefined
        ? null
        : {
            id: "d",
            candidateId: "c",
            decisionStatus: overrides.status as never,
            decisionReason: "",
            hrNote: "",
            appliedValue: null,
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

export function runAutomatedPayrollReadsDeductionsModuleTests() {
  // ---- CONFIRMED, OR NOTHING — for every category without exception --------
  // CRM is the one that used to be different, so it is the one that matters
  // most: the module still treats it as mandatory, and payroll deliberately
  // does not.
  assert.equal(
    buildDeductionBuckets([candidate({ category: "crm", status: undefined })]).get("b1")?.buckets.crm ?? 0,
    0,
    "an undecided CRM row must pay NOTHING — this is the 8,709.68 EGP July row that would otherwise have been charged with no decision behind it",
  );
  assert.equal(
    buildDeductionBuckets([candidate({ category: "crm", status: "Approved for Payroll" })]).get("b1")?.buckets.crm,
    1000,
    "a confirmed CRM row must reach payroll — withholding it would be the opposite failure",
  );

  // Every non-approved state pays nothing, whatever the category. Fail CLOSED:
  // an unrecognised status must never be read as permission to deduct.
  for (const status of ["Pending", "Do Not Take Action", "Needs Follow-up", "Disputed", "Some Future Status"]) {
    for (const category of ["crm", "fingerprint", "unpaid_vacation", "loan", "other"] as const) {
      const built = buildDeductionBuckets([candidate({ category, status, unit: "amount" })]);
      const total = Object.values(built.get("b1")?.buckets ?? {}).reduce((sum, value) => sum + value, 0);
      assert.equal(
        total,
        0,
        `a "${status}" ${category} row must deduct nothing — only "Approved for Payroll" releases money`,
      );
    }
  }

  // ...and every category DOES flow once confirmed, so the gate cannot be
  // "safe" by simply paying nothing.
  for (const category of ["crm", "fingerprint", "unpaid_vacation", "loan", "other"] as const) {
    const built = buildDeductionBuckets([
      candidate({ category, status: "Approved for Payroll", unit: "amount", estimatedAmount: 250 }),
    ]);
    const total = Object.values(built.get("b1")?.buckets ?? {}).reduce((sum, value) => sum + value, 0);
    assert.equal(total, 250, `a confirmed ${category} deduction must reach payroll`);
  }

  // ---- category → payroll bucket, including the two that share a column -----
  const mapped = buildDeductionBuckets([
    candidate({ category: "crm", status: "Approved for Payroll" }),
    candidate({ category: "fingerprint", status: "Approved for Payroll", estimatedAmount: 200 }),
    candidate({ category: "unpaid_vacation", status: "Approved for Payroll", estimatedAmount: 300 }),
    candidate({
      category: "insufficient_balance_vacation",
      status: "Approved for Payroll",
      estimatedAmount: 400,
      dates: ["2026-07-20"],
    }),
    candidate({ category: "loan", status: "Approved for Payroll", unit: "amount", estimatedAmount: 500 }),
    candidate({ category: "other", status: "Approved for Payroll", unit: "amount", estimatedAmount: 600 }),
  ]);
  const buckets = mapped.get("b1")!.buckets;
  assert.equal(buckets.crm, 1000);
  assert.equal(buckets.fingerprint, 200);
  assert.equal(
    buckets.unpaidVacation,
    700,
    "both vacation categories share the unpaid_vacations salary column, so they must sum into ONE payroll figure",
  );
  assert.equal(buckets.loan, 500);
  assert.equal(buckets.other, 600);

  // ---- a superseded candidate is history, never money ----------------------
  assert.equal(
    buildDeductionBuckets([
      candidate({ category: "crm", status: "Approved for Payroll", supersededAt: "2026-07-30T00:00:00Z" }),
    ]).get("b1")?.buckets.crm ?? 0,
    0,
    "a superseded candidate was replaced by a newer one — counting it double-charges the same days, even though it was approved",
  );

  // ---- amount resolution ---------------------------------------------------
  assert.equal(
    candidateAmount(candidate({ category: "crm", status: "Approved for Payroll", appliedAmount: 777.5 })),
    777.5,
    "the reviewer's decided amount always wins over the estimate",
  );
  assert.equal(
    candidateAmount(
      candidate({
        category: "crm",
        dates: ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"],
        rawValue: 4,
        estimatedAmount: 400,
        status: "Approved for Payroll",
        appliedDates: ["2026-07-01", "2026-07-02"],
      }),
    ),
    200,
    "narrowing the charged days must scale the money — 2 of 4 days is half the estimate",
  );
  assert.equal(
    candidateAmount(
      candidate({
        category: "crm",
        rawValue: 2,
        estimatedAmount: 1000,
        status: "Approved for Payroll",
        appliedDates: [],
      }),
    ),
    0,
    "clearing EVERY day means zero — an empty selection must never be read as 'charge them all'",
  );
  assert.equal(
    candidateAmount(candidate({ category: "crm", estimatedAmount: null, status: "Approved for Payroll" })),
    0,
    "an unresolvable amount is 0, not NaN — it still shows on the step where HR can see and fix it",
  );

  // ---- the breakdown must foot to the figure it explains -------------------
  const lines = linesFor(mapped, "b1", "unpaidVacation");
  assert.equal(lines.length, 2, "each confirmed candidate is its own line");
  assert.equal(
    Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100,
    buckets.unpaidVacation,
    "the expandable breakdown must sum to exactly the figure on the row — a panel that disagrees with its own total destroys trust in the number",
  );
  assert.ok(
    linesFor(mapped, "b1", "crm").every((line) => line.category === "crm"),
    "a bucket's breakdown must only contain that bucket's own categories",
  );

  // ---- the steps must actually be wired to this source ---------------------
  // A feeder nothing reads is exactly the failure being fixed: the Deductions
  // module was itself a fully-built system that fed nothing for two weeks.
  for (const stepKey of ["p1_fingerprint", "p2_crm", "p2_vacation"] as const) {
    const definition = STEP_DEFINITIONS[stepKey];
    assert.match(
      definition.subtitle,
      /Deductions module/,
      `${stepKey} must tell HR its figure comes from the Deductions module, not from a recalculation here`,
    );
  }

  // ---- which installment each deduction belongs to (owner, 2026-08-03) -----
  // "the fingerprint is only for part 1". This matters beyond tidiness: a
  // confirmed Part 1 is FROZEN (assemble.ts prefers draft.firstPartFrozen and
  // never recomputes it, and the wizard locks every Part 1 step once Part 1 is
  // confirmed). Moving fingerprint to Part 2 would quietly re-charge, in the
  // second installment, money the first installment already settled.
  // Loan and Other are offered in TWO places — the Part 1 tab for employees
  // settled there, the Part 2 catch-all for everyone else — split by
  // isSettledInPart1. Both must say so, because the failure mode is silent: the
  // same confirmed loan charged once in each installment.
  assert.match(
    STEP_DEFINITIONS.p1_other_deductions.subtitle,
    /Part 2/,
    "the Part 1 loan/other tab must name where continuing employees get theirs instead",
  );
  assert.match(
    STEP_DEFINITIONS.p2_manual_deductions.subtitle,
    /Part 1/,
    "the Part 2 catch-all must name where settled-in-Part-1 employees get theirs instead",
  );

  assert.equal(STEP_DEFINITIONS.p1_fingerprint.phase, "part1", "fingerprint is a Part 1 deduction, always");
  assert.equal(stepPhase("p1_fingerprint"), "part1");
  for (const stepKey of ["p2_crm", "p2_vacation"] as const) {
    assert.equal(STEP_DEFINITIONS[stepKey].phase, "part2", `${stepKey} settles in Part 2 for continuing employees`);
    assert.equal(stepPhase(stepKey), "part2");
  }
}
