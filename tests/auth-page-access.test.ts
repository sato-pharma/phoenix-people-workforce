import assert from "node:assert/strict";

import { isGuestFallbackAccess } from "../src/lib/auth/page-access-guard.ts";

export function runAuthPageAccessTests() {
  // 1) The guest fallback (session expired/absent) has NEITHER a login_id NOR an hr_id.
  //    This is the exact shape resolveAccessContextFromPage returns for an anonymous
  //    request — it must be treated as "redirect to /login", never as a real Employee.
  assert.equal(isGuestFallbackAccess({ loginId: null, hrId: null }), true);
  assert.equal(isGuestFallbackAccess({ loginId: undefined, hrId: null }), true);
  assert.equal(isGuestFallbackAccess({ loginId: "", hrId: "" }), true);
  assert.equal(isGuestFallbackAccess({ loginId: null, hrId: "" }), true);

  // 2) A real session with EITHER identifier present is NOT the guest fallback and
  //    must be allowed through to the caller's own permission/role checks.
  assert.equal(isGuestFallbackAccess({ loginId: "phx-1", hrId: null }), false);
  assert.equal(isGuestFallbackAccess({ loginId: null, hrId: "B-155" }), false);
  assert.equal(isGuestFallbackAccess({ loginId: "phx-1", hrId: "B-155" }), false);

  // 3) A login_id-only session (e.g. the PHX-1 system account with no linked employee)
  //    is a legitimate signed-in user — it must pass, not be bounced to /login.
  assert.equal(isGuestFallbackAccess({ loginId: "system-admin", hrId: null }), false);

  // 4) A whitespace-only value is still truthy in JS; the predicate only treats
  //    null/undefined/"" as absent, so a non-empty string always counts as present.
  assert.equal(isGuestFallbackAccess({ loginId: " ", hrId: null }), false);
}
