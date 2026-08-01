import { strict as assert } from "node:assert";

import { detectSuspectDatesFromCounts, excludeSuspectDates } from "../src/lib/deductions/connectors/crm.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";

function draft(overrides: Partial<DeductionsCandidateDraft> = {}): DeductionsCandidateDraft {
  return {
    category: "crm",
    sourceSystem: "crm_visits_mirror",
    sourceRecordId: "rec-1",
    employeeHrId: "B-124",
    employeeName: "Test Employee",
    monthKey: "2026-06",
    month: 6,
    year: 2026,
    unit: "days",
    rawValue: 2,
    estimatedAmount: null,
    calculationStatus: "requires_review",
    reason: "Field Workforce Compliance no-activity candidate",
    evidence: {},
    dates: ["2026-06-11", "2026-06-22"],
    ...overrides,
  };
}

export async function runDeductionsModuleCrmGuardsTests(): Promise<void> {
  // 1. detectSuspectDatesFromCounts — flags a genuine same-weekday volume crater
  {
    // 2026-06-04, 06-11, 06-18, 06-25 are all Thursdays; 06-11 craters to ~15%
    // of the other three Thursdays' volume.
    const counts = new Map<string, number>([
      ["2026-06-04", 1000],
      ["2026-06-11", 154],
      ["2026-06-18", 980],
      ["2026-06-25", 1010],
    ]);
    const suspect = detectSuspectDatesFromCounts(counts);
    assert.ok(suspect.has("2026-06-11"), "a Thursday running at ~15% of the other Thursdays must be flagged");
    assert.equal(suspect.size, 1, "the three normal Thursdays must not be flagged");
  }

  // 2. detectSuspectDatesFromCounts — never flags a naturally-low weekly-off
  // day just because it's much lower than a busy weekday
  {
    // Fridays (2026-06-05, 06-12, 06-19, 06-26) are naturally near-zero;
    // comparing them to each other (not to weekdays) must not flag them.
    const counts = new Map<string, number>([
      ["2026-06-01", 900], // Monday
      ["2026-06-05", 8], // Friday
      ["2026-06-08", 950], // Monday
      ["2026-06-12", 6], // Friday
    ]);
    const suspect = detectSuspectDatesFromCounts(counts);
    assert.equal(suspect.size, 0, "a low-volume Friday compared only to other low-volume Fridays is not an anomaly");
  }

  // 3. detectSuspectDatesFromCounts — a single data point for a weekday (no
  // peer to compare against) is never flagged (median of one value equals
  // itself, so it can never be "half of its own baseline")
  {
    const counts = new Map<string, number>([["2026-06-30", 5]]);
    assert.equal(detectSuspectDatesFromCounts(counts).size, 0);
  }

  // 4. excludeSuspectDates — no-op when none of the candidate's dates are suspect
  {
    const original = draft({ dates: ["2026-06-22", "2026-06-23"] });
    const result = excludeSuspectDates(original, new Set(["2026-06-11"]), new Map());
    assert.equal(result, original, "must return the same draft unchanged when nothing overlaps the suspect set");
  }

  // 5. excludeSuspectDates — strips only the suspect date, recomputes days/amount
  // from the remaining reliable dates using the base-salary map
  {
    const result = excludeSuspectDates(
      draft({ employeeHrId: "B-124", dates: ["2026-06-11", "2026-06-22"], rawValue: 2 }),
      new Set(["2026-06-11"]),
      new Map([["b124", 8000]]),
    );
    assert.ok(result, "one reliable date must survive exclusion");
    assert.deepEqual(result!.dates, ["2026-06-22"]);
    assert.equal(result!.rawValue, 1);
    assert.equal(result!.estimatedAmount, 266.67); // calculateDeductionAmountFromBaseSalary rounds to cents
    assert.equal(result!.calculationStatus, "calculated");
    const evidence = result!.evidence as { excludedSuspectDates?: string[] };
    assert.deepEqual(evidence.excludedSuspectDates, ["2026-06-11"]);
  }

  // 6. excludeSuspectDates — returns null when EVERY date is suspect (nothing
  // reliable left), rather than publishing a zero-day candidate
  {
    const result = excludeSuspectDates(
      draft({ dates: ["2026-06-11"], rawValue: 1 }),
      new Set(["2026-06-11"]),
      new Map([["b124", 8000]]),
    );
    assert.equal(result, null, "a candidate with no reliable dates left must be dropped, not published at 0 days");
  }

  // 7. excludeSuspectDates — missing base salary still strips the suspect
  // date but leaves the amount unresolved (requires_review), never throws
  {
    const result = excludeSuspectDates(
      draft({ employeeHrId: "UNKNOWN-1", dates: ["2026-06-11", "2026-06-22"], rawValue: 2 }),
      new Set(["2026-06-11"]),
      new Map(),
    );
    assert.ok(result);
    assert.equal(result!.estimatedAmount, null);
    assert.equal(result!.calculationStatus, "requires_review");
  }
}
