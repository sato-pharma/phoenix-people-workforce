import assert from "node:assert/strict";

import { currentCairoMinutesOfDay, currentCairoTimeHM } from "../src/lib/i18n/format.ts";
import { defaultTelegramModulePolicies, defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";
import { GENERIC_PAYSLIP_MESSAGE, TelegramTemplateError } from "../src/lib/notifications/telegram-template-types.ts";
import { renderTelegramTemplateText } from "../src/lib/notifications/telegram-template-placeholders.ts";
import { hashTelegramToken, telegramWebhookSecretToken } from "../src/lib/notifications/telegram.ts";

export function runTelegramHardeningTests() {
  // ── Webhook secret token is always Telegram-safe ([A-Za-z0-9_-], 1-256) ─────────
  // Telegram's setWebhook rejects a secret_token with other characters; a raw
  // NOTIFICATION_WEBHOOK_SECRET containing base64 "+/=" must be sanitized so the
  // webhook registers instead of 403-ing every inbound update.
  const savedSecret = process.env.NOTIFICATION_WEBHOOK_SECRET;
  const telegramSafe = /^[A-Za-z0-9_-]{1,256}$/;
  try {
    // Unset ⇒ null (no secret to register).
    delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    assert.equal(telegramWebhookSecretToken(), null, "no secret ⇒ null");

    // Already-compliant secret passes through untouched (backward compatible).
    process.env.NOTIFICATION_WEBHOOK_SECRET = "Abc_123-XYZ";
    assert.equal(telegramWebhookSecretToken(), "Abc_123-XYZ", "compliant secret is used as-is");

    // Non-compliant secret (base64 padding/symbols) ⇒ SHA-256 hex, which is Telegram-safe.
    const raw = "p+q/r=st uvw!"; // contains +, /, =, space, ! — all disallowed by Telegram
    process.env.NOTIFICATION_WEBHOOK_SECRET = raw;
    const derived = telegramWebhookSecretToken();
    assert.equal(derived, hashTelegramToken(raw), "non-compliant secret ⇒ deterministic SHA-256 hex");
    assert.match(String(derived), telegramSafe, "derived token must match Telegram's allowed charset");
    assert.equal(String(derived).length, 64, "SHA-256 hex is 64 chars (well within 256)");
  } finally {
    if (savedSecret === undefined) delete process.env.NOTIFICATION_WEBHOOK_SECRET;
    else process.env.NOTIFICATION_WEBHOOK_SECRET = savedSecret;
  }

  // ── Quiet hours: Cairo (Africa/Cairo) time, not server/UTC time ────────────────
  // 2026-01-15 22:30 UTC is winter (no Egypt DST) ⇒ Cairo is UTC+2 ⇒ 00:30 next day.
  const winter = new Date("2026-01-15T22:30:00Z");
  const cairo = currentCairoTimeHM(winter);
  assert.equal(cairo.hours, 0, "Cairo hour should be 0 (UTC+2 in winter)");
  assert.equal(cairo.minutes, 30, "Cairo minutes should be 30");
  assert.equal(currentCairoMinutesOfDay(winter), 30, "Cairo minutes-of-day should be 30");
  // It must differ from naive server/UTC hours (22:30 UTC), proving it isn't using the server clock.
  assert.notEqual(cairo.hours, winter.getUTCHours(), "Cairo hour must differ from UTC hour");

  // ── Module governance: unknown modules FAIL SAFE (disabled), sensitive ones gated ──
  assert.equal(defaultTelegramPolicyFor("totally_unknown_module_xyz").enabled, false, "Unknown module must default to disabled");
  assert.equal(defaultTelegramPolicyFor("offers").enabled, false, "offers must be disabled by default (sensitive)");
  assert.equal(defaultTelegramPolicyFor("deductions").enabled, false, "deductions must be disabled by default (sensitive)");
  assert.equal(defaultTelegramPolicyFor("coaching").genericOnly, true, "coaching must be generic-only");
  assert.equal(defaultTelegramPolicyFor("resignations").enabled, false, "resignations stay disabled (unchanged)");
  assert.equal(defaultTelegramPolicyFor("payroll").genericOnly, true, "payroll stays generic-only (unchanged)");
  // The newly-added modules are present in the default policy list.
  const moduleNames = new Set(defaultTelegramModulePolicies().map((policy) => policy.module));
  for (const expected of ["offers", "deductions", "coaching", "coaching_report", "outstation", "weekly_plans", "birthdays", "anniversary"]) {
    assert.ok(moduleNames.has(expected), `default policies should include ${expected}`);
  }

  // ── Centralised payslip redaction string ───────────────────────────────────────
  assert.equal(GENERIC_PAYSLIP_MESSAGE, "Your payslip is available.", "Generic payslip message constant is stable");

  // ── Template: optional placeholders don't throw at live send (preview-pass ⇒ prod-pass) ──
  // requiredPlaceholders=[] ⇒ a missing placeholder renders to empty, no throw.
  assert.equal(
    renderTelegramTemplateText("Hello {{name}}", {}, ["name"], []),
    "Hello ",
    "Optional missing placeholder should render empty without throwing",
  );
  // Provided value still renders.
  assert.equal(renderTelegramTemplateText("Hello {{name}}", { name: "Sam" }, ["name"], []), "Hello Sam");
  // A placeholder listed as required and missing still throws (so genuinely-required vars are caught).
  assert.throws(
    () => renderTelegramTemplateText("Hello {{name}}", {}, ["name"], ["name"]),
    (error: unknown) => error instanceof TelegramTemplateError && error.code === "missing_variables",
    "Missing required placeholder must throw missing_variables",
  );
  // Back-compat: with no requiredPlaceholders arg, every placeholder is required (strict, e.g. CTA URLs).
  assert.throws(
    () => renderTelegramTemplateText("Open {{actionUrl}}", {}, ["actionUrl"]),
    (error: unknown) => error instanceof TelegramTemplateError,
    "Strict mode (no requiredPlaceholders) must still throw on missing variable",
  );
}
