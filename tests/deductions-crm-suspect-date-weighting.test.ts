import assert from "node:assert/strict";

import { excludeSuspectDates } from "../src/lib/deductions/connectors/crm.ts";
import { sumFieldWorkforceDeductionDayWeights } from "../src/lib/field-workforce-compliance/weekend-policy.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

/**
 * SUSPECT-DATE EXCLUSION MUST KEEP THE THURSDAY HALF-DAY WEIGHTING.
 *
 * Thursday is a half working day for the field workforce (owner rule 2026-08-02), so every path that
 * turns no-activity DATES into money weights a Thursday at 0.5 — the emit path does, via
 * sumFieldWorkforceDeductionDayWeights (crm.ts:371 and the continuing-employee weighting). But when a
 * company-wide sync gap made a date "suspect", excludeSuspectDates re-priced the survivors on their
 * raw COUNT, so a surviving Thursday was charged as a full day. This pins the weighting on the
 * exclusion path too.
 */
function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "rec-1",
    employeeHrId: "B-50",
    employeeName: "Test Rep",
    monthKey: "2026-07",
    month: 7,
    year: 2026,
    unit: "days",
    rawValue: 3,
    estimatedAmount: null,
    calculationStatus: "requires_review",
    reason: "Field Workforce Compliance no-activity candidate",
    evidence: {},
    // Wed 2026-07-01, Thu 2026-07-02, Fri 2026-07-03.
    dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
    ...overrides,
  };
}

export function runDeductionsCrmSuspectDateWeightingTests() {
  const title = "Medical Representative"; // a Friday-only (field) title — Thursday is a half day
  // The company-wide sync gap fell on the Friday, so it is the suspect date; the Wednesday (full)
  // and the Thursday (half) survive. base 9,300 / 31 July days = 300.00 per full day.
  const result = excludeSuspectDates(
    draft(),
    new Set(["2026-07-03"]),
    new Map([["b50", 9300]]),
    title,
  );

  assert.ok(result, "two reliable dates survive, so the candidate is kept");
  assert.deepEqual(result!.dates, ["2026-07-01", "2026-07-02"], "the suspect Friday is removed, the rest survive");

  // The headline: the surviving Thursday is a HALF day, so the MONEY weighs 1.5 days, not 2.
  const expectedWeight = sumFieldWorkforceDeductionDayWeights(["2026-07-01", "2026-07-02"], title);
  assert.equal(expectedWeight, 1.5, "Wed (1) + Thu (0.5) = 1.5 — the reference weighting the emit path uses");

  // rawValue stays the RAW surviving-day count (2), exactly like both emit paths (crm.ts:397, :662):
  // the evidence and the charge stay separately auditable, AND a fractional rawValue would break
  // scaleDeductionAmountToDays's exact passthrough — a carried full-day selection (appliedDays 2)
  // would then scale 450 → 600, re-charging the surviving Thursday as a full day on the carry path.
  assert.equal(result!.rawValue, 2, "rawValue stays the RAW surviving-day count (2), never the weighted 1.5");

  // And the money follows the WEIGHTED days: 300.00/day × 1.5 = 450.00, never the 600.00 a 2-full-day
  // charge gives. This is the assertion that fires if the amount ever stops being weighted.
  assert.equal(result!.estimatedAmount, 450, "the amount is priced off the weighted 1.5 days, not 2.0");
  assert.equal(result!.calculationStatus, "calculated");
}
