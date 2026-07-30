import assert from "node:assert/strict";

import {
  deriveAppErrorStatus,
  deriveFailedLoginStatus,
  deriveGcpStatus,
  shouldPersistErrorEvents,
  signatureKey,
} from "../src/lib/error-monitor/derived-status.ts";

/** Runs `fn` with process.env patched, restoring the previous values afterwards. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function runErrorMonitorDerivedStatusTests() {
  // ── signatureKey: stable module|route grouping, null route normalized ──────
  assert.equal(signatureKey("payroll", "/admin/payroll"), "payroll|/admin/payroll");
  assert.equal(signatureKey("payroll", null), "payroll|");

  // ── deriveAppErrorStatus: Active iff the signature occurred on the current release ─
  const active = new Set<string>(["payroll|/admin/payroll", "auth|"]);
  assert.equal(deriveAppErrorStatus("payroll|/admin/payroll", active), "active");
  assert.equal(deriveAppErrorStatus("auth|", active), "active");
  // Not on current release (old/null-release error) → Resolved, no human action.
  assert.equal(deriveAppErrorStatus("sales|/sales", active), "resolved");
  assert.equal(deriveAppErrorStatus("anything|", new Set()), "resolved");

  // ── deriveGcpStatus: Active iff the entry is on the current Cloud Run revision ──
  assert.equal(deriveGcpStatus("phoenix-hr-00066-toh", "phoenix-hr-00066-toh"), "active");
  assert.equal(deriveGcpStatus("phoenix-hr-00032-bfm", "phoenix-hr-00066-toh"), "resolved");
  // No revision on either side (e.g. local dev) → Resolved, never a false Active.
  assert.equal(deriveGcpStatus(null, "phoenix-hr-00066-toh"), "resolved");
  assert.equal(deriveGcpStatus("phoenix-hr-00066-toh", null), "resolved");

  // ── deriveFailedLoginStatus: Active iff the last failure is within the window ──
  const now = new Date("2026-07-12T12:00:00Z").getTime();
  const oneHourAgo = new Date("2026-07-12T11:00:00Z").toISOString();
  const threeDaysAgo = new Date("2026-07-09T12:00:00Z").toISOString();
  assert.equal(deriveFailedLoginStatus(oneHourAgo, now), "active");
  assert.equal(deriveFailedLoginStatus(threeDaysAgo, now), "resolved");
  // Exactly at the 24h boundary counts as still active (<=).
  const exactly24h = new Date("2026-07-11T12:00:00Z").toISOString();
  assert.equal(deriveFailedLoginStatus(exactly24h, now), "active");
  // Unparseable timestamp never falsely reads Active.
  assert.equal(deriveFailedLoginStatus("not-a-date", now), "resolved");

  // ── shouldPersistErrorEvents: only a real deployed build writes app_error_events ──
  // Local `next dev` must NOT insert: .env.local points at the PRODUCTION Supabase project,
  // so dev iteration was polluting the production error table (103 dev rows vs 46 real ones
  // in the 7 days to 2026-07-30) and making triage read like an outage.
  withEnv({ NODE_ENV: "development", PHOENIX_PERSIST_DEV_ERROR_EVENTS: undefined }, () => {
    assert.equal(shouldPersistErrorEvents(), false);
  });
  // Both deployed Cloud Run services build with NODE_ENV=production. Staging keeps its own
  // error events — they land in the staging project, not production.
  withEnv({ NODE_ENV: "production", PHOENIX_PERSIST_DEV_ERROR_EVENTS: undefined }, () => {
    assert.equal(shouldPersistErrorEvents(), true);
  });
  // Test/unknown environments are treated as non-deployed: never write.
  withEnv({ NODE_ENV: "test", PHOENIX_PERSIST_DEV_ERROR_EVENTS: undefined }, () => {
    assert.equal(shouldPersistErrorEvents(), false);
  });
  // Explicit opt-in re-enables persistence locally (deliberate ingestion debugging).
  withEnv({ NODE_ENV: "development", PHOENIX_PERSIST_DEV_ERROR_EVENTS: "true" }, () => {
    assert.equal(shouldPersistErrorEvents(), true);
  });
  // Only the exact string "true" opts in — no accidental truthiness.
  withEnv({ NODE_ENV: "development", PHOENIX_PERSIST_DEV_ERROR_EVENTS: "1" }, () => {
    assert.equal(shouldPersistErrorEvents(), false);
  });
}
