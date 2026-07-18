import assert from "node:assert/strict";

import { isBirthdayEligibleEmployee } from "../src/lib/notifications/birthday-eligibility.ts";

export function runBirthdayEligibilityTests() {
  const birthDate = "1990-05-17";

  // Active-ish statuses (including on_leave, unset/null/empty) with a birth_date must be eligible.
  for (const status of ["active", "on_leave", null, undefined, ""] as const) {
    assert.equal(
      isBirthdayEligibleEmployee({ employment_status: status, birth_date: birthDate }),
      true,
      `status ${JSON.stringify(status)} with a birth_date should be eligible`,
    );
  }

  // Case-insensitivity, mirroring isTerminalEmploymentStatus.
  assert.equal(
    isBirthdayEligibleEmployee({ employment_status: "On_Leave", birth_date: birthDate }),
    true,
    "on_leave should be eligible regardless of casing",
  );

  // Terminal statuses must never be eligible, even with a birth_date present.
  for (const status of ["resigned", "terminated", "not_renewed", "inactive"]) {
    assert.equal(
      isBirthdayEligibleEmployee({ employment_status: status, birth_date: birthDate }),
      false,
      `status ${status} should never be eligible`,
    );
  }

  // No birth_date must never be eligible, regardless of status.
  for (const birth_date of [null, undefined, ""] as const) {
    for (const status of ["active", "on_leave", "resigned", null]) {
      assert.equal(
        isBirthdayEligibleEmployee({ employment_status: status, birth_date }),
        false,
        `falsy birth_date ${JSON.stringify(birth_date)} with status ${JSON.stringify(status)} should never be eligible`,
      );
    }
  }
}
