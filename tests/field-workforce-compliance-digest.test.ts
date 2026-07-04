import { strict as assert } from "node:assert";

import {
  isFieldWorkforceDigestDay,
  previousFieldWorkforceMonthKey,
} from "../src/lib/field-workforce-compliance/digest.ts";

export function runFieldWorkforceComplianceDigestTests() {
  // --- isFieldWorkforceDigestDay ---
  assert.equal(isFieldWorkforceDigestDay("2026-07-01T06:30:00.000Z"), true, "the 1st triggers the digest");
  assert.equal(isFieldWorkforceDigestDay("2026-07-01T23:59:59.000Z"), true, "any time on the 1st still triggers");
  assert.equal(isFieldWorkforceDigestDay("2026-07-02T06:30:00.000Z"), false, "the 2nd does not trigger");
  assert.equal(isFieldWorkforceDigestDay("2026-07-31T06:30:00.000Z"), false, "the last day of the month does not trigger");
  assert.equal(isFieldWorkforceDigestDay("2026-01-01T06:30:00.000Z"), true, "January 1st still triggers");

  // --- previousFieldWorkforceMonthKey ---
  assert.equal(previousFieldWorkforceMonthKey("2026-07-01T06:30:00.000Z"), "2026-06", "July 1st reports on June");
  assert.equal(previousFieldWorkforceMonthKey("2026-03-01T06:30:00.000Z"), "2026-02", "March 1st reports on February");
  assert.equal(
    previousFieldWorkforceMonthKey("2026-01-01T06:30:00.000Z"),
    "2025-12",
    "January 1st reports on December of the prior year (year wraparound)",
  );
  assert.equal(previousFieldWorkforceMonthKey("2026-12-01T06:30:00.000Z"), "2026-11", "December 1st reports on November");
}
