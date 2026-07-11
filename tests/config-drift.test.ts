import assert from "node:assert/strict";

import { notificationConfigWarnings } from "../src/lib/observability/config-drift.ts";

// Regression guard for the 2026-07-11 outage: EMAIL_NOTIFICATIONS_ENABLED silently went
// MISSING from the production Cloud Run service and email was dead ~2 days. The readiness
// probe now surfaces this drift. These tests pin the exact detection semantics:
//   - production + var UNSET     ⇒ warn (this is the drift that bit us)
//   - production + var ="false"  ⇒ NO warn (intentional pause switch, DR runbook §6)
//   - non-production             ⇒ never warn
export function runConfigDriftTests() {
  const saved = {
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    EMAIL_NOTIFICATIONS_ENABLED: process.env.EMAIL_NOTIFICATIONS_ENABLED,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  try {
    // Force production runtime via APP_ENV (isProductionRuntime prefers it).
    process.env.APP_ENV = "production";
    delete process.env.VERCEL_ENV;

    // Both notification vars unset ⇒ both flagged.
    delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
    delete process.env.RESEND_API_KEY;
    let warnings = notificationConfigWarnings();
    assert.ok(
      warnings.some((w) => w.includes("EMAIL_NOTIFICATIONS_ENABLED")),
      "prod + unset EMAIL_NOTIFICATIONS_ENABLED must warn (the exact outage cause)",
    );
    assert.ok(warnings.some((w) => w.includes("RESEND_API_KEY")), "prod + unset RESEND_API_KEY must warn");

    // Explicit "false" is a legitimate pause switch, NOT drift ⇒ no warning for that var.
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
    process.env.RESEND_API_KEY = "re_something";
    warnings = notificationConfigWarnings();
    assert.equal(warnings.length, 0, "explicit false / present key ⇒ no drift warnings");

    // Healthy production (email on, key present) ⇒ no warnings.
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    assert.equal(notificationConfigWarnings().length, 0, "healthy prod config ⇒ no warnings");

    // Non-production never warns, even when everything is unset (dev/preview commonly omit these).
    process.env.APP_ENV = "development";
    delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
    delete process.env.RESEND_API_KEY;
    assert.equal(notificationConfigWarnings().length, 0, "non-production must never warn");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
