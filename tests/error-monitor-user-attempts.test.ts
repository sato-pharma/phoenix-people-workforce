import assert from "node:assert/strict";

import {
  buildAccountDirectory,
  DEFAULT_ATTEMPT_WINDOW_DAYS,
  partitionUserAttempts,
  resolveAttemptWindowFrom,
} from "../src/lib/error-monitor/service.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

export function runErrorMonitorUserAttemptsTests() {
  const now = new Date("2026-07-16T12:00:00Z").getTime();

  // ── Default window: no dateFrom → DEFAULT_ATTEMPT_WINDOW_DAYS (30) ago ───────
  const defaulted = resolveAttemptWindowFrom(null, now);
  const expected = new Date(now - DEFAULT_ATTEMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(defaulted, expected);
  // The applied bound is exactly ~30 days before "now" (guards against an off-by-one window).
  assert.equal((now - new Date(defaulted).getTime()) / 86_400_000, 30);
  // undefined behaves like null (both mean "no explicit filter").
  assert.equal(resolveAttemptWindowFrom(undefined, now), expected);

  // ── Explicit dateFrom overrides the default (UI widening keeps working) ──────
  assert.equal(resolveAttemptWindowFrom("2026-05-01", now), "2026-05-01");
  assert.equal(resolveAttemptWindowFrom("2026-05-01T00:00:00Z", now), "2026-05-01T00:00:00Z");

  // ── Partition: real accounts kept, identity-less rows folded into an aggregate ─
  const realKeys = new Set(["admin-hr", "aa", "b-10", "a-8", "a-12"]);
  const isReal = (hrId: string) => realKeys.has(hrId.trim().toLowerCase());
  const rows = [
    { hrId: "admin-hr", attemptCount: 2 }, // real
    { hrId: "AA", attemptCount: 1 }, // real (case-insensitive match)
    { hrId: "invalid-user", attemptCount: 5 }, // unknown / test noise
    { hrId: "__codex_probe__", attemptCount: 3 }, // unknown
    { hrId: "invalid-user", attemptCount: 4 }, // same unknown user, second bucket
    { hrId: "smoke-test-nonexistent-zzz", attemptCount: 1 }, // unknown
  ];
  const { realRows, unknownAttempts } = partitionUserAttempts(rows, isReal);

  // Only the two real accounts survive in the per-user list.
  assert.deepEqual(
    realRows.map((r) => r.hrId),
    ["admin-hr", "AA"],
  );
  // Every non-real attempt is summed: 5 + 3 + 4 + 1 = 13.
  assert.equal(unknownAttempts.attemptCount, 13);
  // Distinct unknown usernames (invalid-user counted once): 3.
  assert.equal(unknownAttempts.distinctCount, 3);

  // ── All-real input → empty unknown bucket, no rows dropped ───────────────────
  const allReal = partitionUserAttempts([{ hrId: "b-10", attemptCount: 9 }], isReal);
  assert.equal(allReal.realRows.length, 1);
  assert.equal(allReal.unknownAttempts.attemptCount, 0);
  assert.equal(allReal.unknownAttempts.distinctCount, 0);

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
