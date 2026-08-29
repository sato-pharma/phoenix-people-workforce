import assert from "node:assert/strict";

import {
  buildDeductionBuckets,
  chargeableDeductionDays,
  chargedDeductionDays,
  linesFor,
} from "../src/lib/automated-payroll/deductions-source.ts";
import { leaverDayDeduction, resolveLeaverBasis } from "../src/lib/automated-payroll/leaver-basis.ts";
import type { PayrollPeriod } from "../src/lib/automated-payroll/types.ts";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "../src/lib/deductions/types.ts";
import { sumDetectedDeductionDayWeights } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import type { PayrollSalarySource } from "../src/lib/payroll/salary-source-model.ts";

/**
 * THURSDAY IS A HALF DAY — ALL THE WAY TO THE MONEY.
 *
 * Owner rule, 2026-08-02: "medical reps working days are from sat to wednesday AM and PM, thursday
 * am or meeting or health day only." The CRM connector applies it when it prices a candidate
 * (`sumFieldWorkforceDeductionDayWeights` in connectors/crm.ts). The payroll wizard did not: it
 * read the flagged-DATE count and multiplied a day rate by it, so a Thursday was charged in full.
 *
 * Invisible until 2026-08-30, because the wizard used to display the module's own amount. Once the
 * leaver tab began deriving the charge from days at the net rate (the owner's "in the CRM, it must
 * prorate the net salary"), the unweighted count started producing the money directly.
 *
 * Measured on the live August 2026 run, all seven CRM candidates: six carry exactly one flagged
 * Thursday (6 August) and were set to be over-charged half a day each; B-112 carries none and was
 * correct. 1,758.06 EGP in total, recurring monthly.
 *
 * The fixtures below are those production rows verbatim. B-112 is here as the CONTROL: without a
 * row that has no Thursday, a test cannot tell "weights Thursdays" from "shaves every charge".
 */

const PERIOD: PayrollPeriod = { month: 8, year: 2026 }; // 31 days

// 6 August 2026 is a Thursday. 5th Wed, 8th Sat, 9th Sun — B-3's real flagged span.
const B3_DATES = ["2026-08-05", "2026-08-06", "2026-08-08", "2026-08-09"];
// B-112's real span, 1-5 August: Sat, Sun, Mon, Tue, Wed. No Thursday.
const B112_DATES = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"];

function candidate(overrides: {
  category?: DeductionsCategory;
  compact?: string;
  rawValue: number;
  estimatedAmount: number | null;
  dates: string[];
  status?: string | null;
  appliedValue?: number | null;
  appliedDates?: string[] | null;
}): DeductionsCandidateWithDecision {
  return {
    id: `c-${overrides.compact ?? "b3"}-${overrides.rawValue}`,
    category: overrides.category ?? "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "rec",
    candidateKey: "key",
    employeeHrId: "B-3",
    employeeHrIdCompact: overrides.compact ?? "b3",
    employeeName: "Ahmed Helal Eliwa Hussenin",
    monthKey: "2026-08",
    month: 8,
    year: 2026,
    unit: "days",
    rawValue: overrides.rawValue,
    estimatedAmount: overrides.estimatedAmount,
    calculationStatus: "calculated",
    severity: "Medium",
    reason: "No CRM/field visit activity recorded (leaver settlement span)",
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
      appliedAmount: null,
      appliedDates: overrides.appliedDates ?? null,
      decidedBy: "B-10",
      decidedAt: "",
      actorRoleAtDecision: "Super Admin",
      createdAt: "",
      updatedAt: "",
    },
  } as unknown as DeductionsCandidateWithDecision;
}

export async function runAutomatedPayrollThursdayHalfDayChargeTests() {
  // ---- the weight itself ---------------------------------------------------
  assert.equal(sumDetectedDeductionDayWeights(B3_DATES), 3.5, "Wed + Thu + Sat + Sun = 3.5 chargeable days");
  assert.equal(sumDetectedDeductionDayWeights(B112_DATES), 5, "a span with no Thursday is unweighted");
  assert.equal(sumDetectedDeductionDayWeights([]), 0);

  // THE SATURDAY TRAP. `fieldWorkforceDeductionDayWeight` treats Saturday as a weekly OFF unless
  // the job title is a Friday-only one, and no caller in the payroll wizard has a job title. Had
  // this been routed through the title-aware helper, B-3's Saturday AND Sunday would have weighed
  // 0 and his charge would have collapsed from 3.5 days to 1.5 — money deleted from a correct
  // deduction, in the same edit that fixed an over-charge.
  assert.equal(
    sumDetectedDeductionDayWeights(["2026-08-08"]),
    1,
    "a stored SATURDAY is a full chargeable day — it already passed the weekly-off filter at detection time",
  );
  assert.equal(sumDetectedDeductionDayWeights(["2026-08-06"]), 0.5, "a stored Thursday is half");

  // ---- evidence and charge stay separate -----------------------------------
  const b3 = candidate({ rawValue: 4, estimatedAmount: 1862.9, dates: B3_DATES });
  assert.equal(chargedDeductionDays(b3), 4, "the EVIDENCE is four flagged dates and must keep reading 4");
  assert.equal(chargeableDeductionDays(b3), 3.5, "the CHARGE is 3.5 — one of those four is a Thursday");
  assert.notEqual(
    chargedDeductionDays(b3),
    chargeableDeductionDays(b3),
    "fixture must discriminate — if these coincided the test could not fail",
  );

  // ---- the control: no Thursday, nothing weighted --------------------------
  const b112 = candidate({ compact: "b112", rawValue: 5, estimatedAmount: 2258.06, dates: B112_DATES });
  assert.equal(chargedDeductionDays(b112), 5);
  assert.equal(
    chargeableDeductionDays(b112),
    5,
    "no Thursday in the span -> the charge is untouched; a blanket discount would fail here",
  );

  // ---- NOT a blanket rule: only CRM ----------------------------------------
  // The Thursday half-day says a rep is expected in the field for half a Thursday. It says nothing
  // about attendance, unpaid leave or a loan instalment, and halving one of those would invent a
  // discount nobody granted.
  const fingerprintOnAThursday = candidate({
    category: "fingerprint",
    compact: "b9",
    rawValue: 1,
    estimatedAmount: 500,
    dates: ["2026-08-06"],
  });
  assert.equal(
    chargeableDeductionDays(fingerprintOnAThursday),
    1,
    "a FINGERPRINT day on a Thursday is a whole day — the half-day is a field-activity rule, not a discount",
  );

  // ---- a human's explicit day count is never second-guessed ----------------
  const narrowed = candidate({
    compact: "b7",
    rawValue: 4,
    estimatedAmount: 1862.9,
    dates: B3_DATES,
    appliedValue: 2,
  });
  assert.equal(
    chargeableDeductionDays(narrowed),
    2,
    "a stated appliedValue is a number a human typed after looking at the row — it is not re-weighted",
  );

  // ---- a candidate with no dates falls back rather than charging zero ------
  const noDates = candidate({ compact: "b8", rawValue: 3, estimatedAmount: 900, dates: [] });
  assert.equal(chargeableDeductionDays(noDates), 3, "no calendar to weigh -> fall back to the day count, never a confident 0");

  // ---- it reaches the payroll line ----------------------------------------
  const buckets = buildDeductionBuckets([b3, b112]);
  const [b3Line] = linesFor(buckets, "b3", "crm");
  assert.ok(b3Line, "sanity: an approved CRM candidate produces a line");
  assert.equal(b3Line.days, 4, "the breakdown still reports the four dates that were flagged");
  assert.equal(b3Line.chargeableDays, 3.5, "the line carries the chargeable count the money is built from");

  const [b112Line] = linesFor(buckets, "b112", "crm");
  assert.ok(b112Line);
  assert.equal(b112Line.chargeableDays, 5);

  // ---- END TO END: the money the leaver actually loses ---------------------
  // Ahmed Helal, B-3: base 16,500 + cost of living 2,000 + fuel 500 = 19,000 net, August = 31 days.
  const basis = resolveLeaverBasis({
    source: {
      baseSalary: 16500,
      basicSalary: null,
      employmentIncomeTax: null,
      extraCostOfLiving: 2000,
      fuelAllowance: 500,
      grossSalary: null,
      hasAnyRawCompensationFigure: true,
      netSalary: 19000,
      paymentMode: "two_parts",
      socialInsurance: null,
    } as PayrollSalarySource,
    lastWorkingDate: "2026-08-09",
    period: PERIOD,
    unpaidDaysInSpan: 0,
    draft: undefined,
  });
  assert.ok(basis);
  assert.equal(basis.daysWorked, 9);
  assert.equal(basis.netSalary, 19000, "the rate is built on the NET, per the 2026-08-30 rule");

  assert.equal(
    leaverDayDeduction(basis, chargeableDeductionDays(b3)),
    2145.16,
    "3.5 chargeable days at the net rate — what Ahmed Helal must actually be charged",
  );
  assert.equal(
    leaverDayDeduction(basis, chargedDeductionDays(b3)),
    2451.61,
    "charging the four FLAGGED days is the bug, and it is 306.45 EGP more",
  );
  assert.equal(
    Math.round((2451.61 - 2145.16) * 100) / 100,
    306.45,
    "half a day at the net rate — the exact per-leaver over-charge measured on the August run",
  );
}
