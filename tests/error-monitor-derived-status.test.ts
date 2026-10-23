import assert from "node:assert/strict";

import { shouldPersistErrorEvents } from "../src/lib/error-monitor/derived-status.ts";

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
  // The deploy-derived Active/Resolved status (signatureKey, deriveAppErrorStatus, deriveGcpStatus,
  // deriveFailedLoginStatus) was retired with the System Issues dashboard on 23 Oct 2026 — a deploy
  // is not a fix. What stays is the write gate below.

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
