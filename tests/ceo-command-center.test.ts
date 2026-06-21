import assert from "node:assert/strict";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";

export function runCeoCommandCenterTests() {
  // The CEO now lands on their dedicated, branded command center (was /sales).
  assert.equal(
    resolveLandingPathForRole("CEO"),
    "/admin/ceo-command-center",
    "CEO must land on the CEO Command Center",
  );
  // Landing normalizes case/whitespace, so variants resolve the same.
  assert.equal(resolveLandingPathForRole(" ceo "), "/admin/ceo-command-center");

  // Other roles' landings must be unchanged by this feature.
  assert.equal(resolveLandingPathForRole("Super Admin"), "/admin");
  assert.equal(
    resolveLandingPathForRole("Finance Manager"),
    "/admin/outstation/expense-command",
  );
  assert.equal(resolveLandingPathForRole("Employee"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Medical Rep"), "/employee-portals");
}
