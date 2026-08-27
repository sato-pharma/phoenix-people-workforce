import assert from "node:assert/strict";

import { notificationConfigWarnings } from "../src/lib/observability/config-drift.ts";

// Regression guard for the 2026-07-11 outage: EMAIL_NOTIFICATIONS_ENABLED silently went
// MISSING from the production Cloud Run service and email was dead ~2 days. The readiness
// probe now surfaces this drift. These tests pin the exact detection semantics:
//   - production + var UNSET     ⇒ warn (this is the drift that bit us)
//   - production + var ="false"  ⇒ NO warn (intentional pause switch, DR runbook §6)
//   - non-production             ⇒ never warn (for the production-only vars)
//
// 2026-08-27: CRON_SECRET and MASTER_MAP_SYNC_TOKEN joined the drift set with DIFFERENT gates
// (PR #2479 made 18 cron routes 401 on an unset CRON_SECRET on STAGING too, not just prod).
// The gate per var is now:
//   - CRON_SECRET            ⇒ warn on every DEPLOYED env (prod AND staging); silent only in
//                              local `development` — mirrors the routes' own bypass condition.
//   - MASTER_MAP_SYNC_TOKEN  ⇒ production-only (deliberately absent on staging), so it must be
//                              SILENT on staging or it fires false noise every readiness probe.
export function runConfigDriftTests() {
  const saved = {
    APP_ENV: process.env.APP_ENV,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    EMAIL_NOTIFICATIONS_ENABLED: process.env.EMAIL_NOTIFICATIONS_ENABLED,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NOTIFICATION_EMAIL_FROM: process.env.NOTIFICATION_EMAIL_FROM,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    NOTIFICATION_WEBHOOK_SECRET: process.env.NOTIFICATION_WEBHOOK_SECRET,
    CRON_SECRET: process.env.CRON_SECRET,
    MASTER_MAP_SYNC_TOKEN: process.env.MASTER_MAP_SYNC_TOKEN,
  };
  const clearAllDriftVars = () => {
    delete process.env.EMAIL_NOTIFICATIONS_ENABLED;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATION_EMAIL_FROM;
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.MASTER_MAP_SYNC_TOKEN;
  };
  // process.env.NODE_ENV is typed read-only (Next augments NodeJS.ProcessEnv — see AGENTS.md
  // §2.1), so assign it through a mutable view. CRON_SECRET's drift gate keys on NODE_ENV, so
  // these tests must vary it across production / staging / development.
  const setNodeEnv = (value: string) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };
  try {
    // ---- PRODUCTION, everything unset ⇒ every var flagged ------------------------------------
    // Force production runtime via APP_ENV (isProductionRuntime prefers it). NODE_ENV is set to
    // production too, matching a real production build (and keeping CRON_SECRET's NODE_ENV-based
    // gate deterministic regardless of what the test runner's NODE_ENV happens to be).
    process.env.APP_ENV = "production";
    setNodeEnv("production");
    delete process.env.VERCEL_ENV;
    clearAllDriftVars();

    let warnings = notificationConfigWarnings();
    assert.ok(
      warnings.some((w) => w.includes("EMAIL_NOTIFICATIONS_ENABLED")),
      "prod + unset EMAIL_NOTIFICATIONS_ENABLED must warn (the exact outage cause)",
    );
    assert.ok(warnings.some((w) => w.includes("RESEND_API_KEY")), "prod + unset RESEND_API_KEY must warn");
    assert.ok(
      warnings.some((w) => w.includes("NOTIFICATION_EMAIL_FROM")),
      "prod + unset NOTIFICATION_EMAIL_FROM must warn (same failure shape: notification outbox has no code fallback and silently skips every send)",
    );
    assert.ok(
      warnings.some((w) => w.includes("RESEND_WEBHOOK_SECRET")),
      "prod + unset RESEND_WEBHOOK_SECRET must warn (the resend webhook 500s on every delivery-event callback without it)",
    );
    assert.ok(
      warnings.some((w) => w.includes("TELEGRAM_BOT_TOKEN")),
      "prod + unset TELEGRAM_BOT_TOKEN must warn (every Telegram send silently skips without it)",
    );
    assert.ok(
      warnings.some((w) => w.includes("NOTIFICATION_WEBHOOK_SECRET")),
      "prod + unset NOTIFICATION_WEBHOOK_SECRET must warn (the inbound Telegram webhook 500s on every update without it)",
    );
    assert.ok(
      warnings.some((w) => w.includes("CRON_SECRET")),
      "prod + unset CRON_SECRET must warn (all 18 cron/notification routes 401 without it)",
    );
    assert.ok(
      warnings.some((w) => w.includes("MASTER_MAP_SYNC_TOKEN")),
      "prod + unset MASTER_MAP_SYNC_TOKEN must warn (the Master Map customer-sync route 401s without it)",
    );

    // ---- PRODUCTION, healthy ⇒ no warnings ---------------------------------------------------
    // Explicit "false" is a legitimate pause switch, NOT drift ⇒ no warning for that var.
    // Telegram has no such switch (its enable/disable lives in the DB), so both its vars
    // must simply be present to clear.
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";
    process.env.RESEND_API_KEY = "re_something";
    process.env.NOTIFICATION_EMAIL_FROM = "Phoenix HR <phoenix@send.satopharma.com>";
    process.env.RESEND_WEBHOOK_SECRET = "whsec_something";
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.NOTIFICATION_WEBHOOK_SECRET = "some-secret";
    process.env.CRON_SECRET = "cron_something";
    process.env.MASTER_MAP_SYNC_TOKEN = "mmst_something";
    warnings = notificationConfigWarnings();
    assert.equal(warnings.length, 0, "explicit false / present vars ⇒ no drift warnings");

    // Healthy production (email on, all vars present) ⇒ no warnings.
    process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
    assert.equal(notificationConfigWarnings().length, 0, "healthy prod config ⇒ no warnings");

    // ---- STAGING (the PR #2479 gap) ---------------------------------------------------------
    // A real staging build: APP_ENV=staging but NODE_ENV=production (Next sets it on every
    // production build, staging included). isProductionRuntime() is FALSE here.
    process.env.APP_ENV = "staging";
    setNodeEnv("production");
    clearAllDriftVars();

    warnings = notificationConfigWarnings();
    // CRON_SECRET MUST warn on staging — this is the whole reason it needs a deployment-wide
    // gate rather than the production-only one the notification vars use.
    assert.ok(
      warnings.some((w) => w.includes("CRON_SECRET")),
      "staging + unset CRON_SECRET must warn (PR #2479 made the 18 routes 401 on staging too — this is the gap being closed)",
    );
    // MASTER_MAP_SYNC_TOKEN is deliberately absent on staging, so it must stay SILENT there.
    assert.ok(
      !warnings.some((w) => w.includes("MASTER_MAP_SYNC_TOKEN")),
      "staging + unset MASTER_MAP_SYNC_TOKEN must NOT warn (deliberately absent on staging — would be false noise)",
    );
    // The production-only notification vars must stay silent on staging as before.
    assert.ok(
      !warnings.some((w) => w.includes("EMAIL_NOTIFICATIONS_ENABLED")),
      "staging must not warn on the production-only email vars",
    );

    // Staging with CRON_SECRET present (and MASTER_MAP still absent, as it should be) ⇒ silent.
    process.env.CRON_SECRET = "cron_something";
    assert.equal(
      notificationConfigWarnings().length,
      0,
      "healthy staging (CRON_SECRET present, MASTER_MAP legitimately absent) ⇒ no warnings",
    );

    // ---- DEVELOPMENT ⇒ never warns ----------------------------------------------------------
    // Local dev commonly omits every one of these, INCLUDING CRON_SECRET (the routes bypass on
    // NODE_ENV === "development"), so nothing may warn.
    process.env.APP_ENV = "development";
    setNodeEnv("development");
    clearAllDriftVars();
    assert.equal(notificationConfigWarnings().length, 0, "development must never warn, even with every var unset");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
