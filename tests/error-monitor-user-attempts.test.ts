import assert from "node:assert/strict";

import { buildAccountDirectory } from "../src/lib/error-monitor/service.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

// The per-user attempt window and the real/unknown partition this file also pinned
// (resolveAttemptWindowFrom, partitionUserAttempts, DEFAULT_ATTEMPT_WINDOW_DAYS) were removed on
// 23 Oct 2026 with the System Issues page that was their only reader. The account directory stays:
// the login-security lens still names people through it.
export function runErrorMonitorUserAttemptsTests() {
  // ── Directory indexes accounts by BOTH login_id and hr_id ────────────────────
  // Failed logins are keyed by login_id; app errors by hr_id. For accounts where those
  // differ (the Super Admin logs in as "admin-HR" but has hr_id "PHX-1"), keying by only
  // one dropped the other's rows. Both ids must resolve to the same identity.
  const directory = buildAccountDirectory([
    { login_id: "admin-HR", hr_id: "PHX-1", name: "Owner", role: "Super Admin" }, // login != hr
    { login_id: "a-8", hr_id: "a-8", name: "Rasha Sabry", role: "Medical Rep" }, // login == hr
    { login_id: "b-10", hr_id: null, name: "Omar", role: "Super Admin" }, // hr missing
  ]);
  const lookup = (id: string) => directory.get(canonicalHrIdKey(id) ?? "");
  // The exact regression: the Super Admin resolves by BOTH ids to the same identity.
  assert.equal(lookup("admin-HR")?.name, "Owner");
  assert.equal(lookup("PHX-1")?.name, "Owner"); // app-error hr_id now resolves (was dropped before)
  assert.equal(lookup("PHX-1")?.role, "Super Admin");
  // The real-account predicate (directory presence) is now true for the hr_id form.
  assert.ok(lookup("PHX-1") != null, "PHX-1 must be recognized as a real account");
  // Normal accounts (login == hr) and hr-less rows still resolve.
  assert.equal(lookup("a-8")?.name, "Rasha Sabry");
  assert.equal(lookup("b-10")?.name, "Omar");
  // A genuinely unknown id stays unresolved (still filtered as noise).
  assert.equal(lookup("invalid-user"), undefined);
}
