import assert from "node:assert/strict";

import { isAttendanceTracked, isAttendanceTrackingEligible } from "../src/lib/attendance/eligibility.ts";

/**
 * The attendance/fingerprint report and policy admin decide who is "tracked"
 * via isAttendanceTracked. The office fingerprint device captures HQ/office
 * staff (HR, Finance, Marketing, NSMs, Product/Training managers, admins) whose
 * job titles are NOT field roles. Tracking must therefore key off the device
 * enrolment (authoritative) as well as the legacy field-role-by-title signal —
 * otherwise every office punch is silently filtered out and the page is blank.
 */
export function runAttendanceTrackingEligibilityTests() {
  // 1. Device-mapped office staff ARE tracked, regardless of their title.
  for (const jobTitle of ["Hr Manager", "Finance Manager", "Sfe Manager", "Office Coordinator", "Buffet", null]) {
    assert.equal(
      isAttendanceTracked({ hasDeviceMapping: true, jobTitle }),
      true,
      `an actively device-mapped employee must be tracked (title: ${String(jobTitle)})`,
    );
  }

  // 2. Office staff WITHOUT a device mapping are NOT tracked by title alone.
  assert.equal(
    isAttendanceTracked({ hasDeviceMapping: false, jobTitle: "Hr Manager" }),
    false,
    "an office title with no device mapping must not be tracked",
  );

  // 3. Field roles remain tracked by title even before a device mapping exists
  //    (no regression to the original Medical Rep / DM / RSM behaviour).
  for (const jobTitle of ["Medical Representative", "Medical Rep", "District Sales Manager", "Regional Sales Manager"]) {
    assert.equal(
      isAttendanceTracked({ hasDeviceMapping: false, jobTitle }),
      true,
      `field role must stay tracked by title without a device mapping (title: ${jobTitle})`,
    );
    // The underlying title rule must agree.
    assert.equal(isAttendanceTrackingEligible(jobTitle), true, `${jobTitle} must be a field-eligible title`);
  }

  // 4. A non-field title with no device mapping is not tracked.
  assert.equal(
    isAttendanceTracked({ hasDeviceMapping: false, jobTitle: "Marketing Manager" }),
    false,
    "non-field title without a device mapping must not be tracked",
  );

  // 5. Either signal alone is sufficient (device mapping OR field title).
  assert.equal(
    isAttendanceTracked({ hasDeviceMapping: true, jobTitle: "Medical Rep" }),
    true,
    "device-mapped field rep is tracked",
  );
}
