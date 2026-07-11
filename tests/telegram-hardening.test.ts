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
  // "deductions" has no real caller (verified 2026-07-11: no createSystemNotification call in
  // the codebase uses this module string) and was removed from the default list; it still
  // resolves disabled via the unknown-module fail-safe, so this behavior is unchanged.
  assert.equal(defaultTelegramPolicyFor("deductions").enabled, false, "deductions falls through to the fail-safe default (no real caller, entry removed)");
  assert.equal(defaultTelegramPolicyFor("coaching").genericOnly, true, "coaching must be generic-only");
  assert.equal(defaultTelegramPolicyFor("resignations").enabled, false, "resignations stay disabled (unchanged)");
  assert.equal(defaultTelegramPolicyFor("payroll").genericOnly, true, "payroll stays generic-only (unchanged)");
  // Regression guard (2026-07-11 audit): the real module string every birthday
  // createSystemNotification call uses is singular "birthday" (app/api/notifications/birthdays/route.ts),
  // not plural "birthdays" — the old policy entry never matched a real send.
  assert.equal(defaultTelegramPolicyFor("birthday").enabled, true, "birthday (singular, the real module string) must be enabled");
  // attendance and field_workforce_compliance are real, live Telegram senders (verified via
  // createSystemNotification call sites in src/lib/attendance/ and
  // src/lib/field-workforce-compliance/) that previously had NO policy row at all, so they
  // fail-closed by the unknown-module safety net regardless of any template card.
  assert.equal(defaultTelegramPolicyFor("attendance").enabled, true, "attendance must have an explicit enabled policy");
  assert.equal(defaultTelegramPolicyFor("field_workforce_compliance").enabled, true, "field_workforce_compliance must have an explicit enabled policy");
  // The modules with real live callers are present in the default policy list.
  const moduleNames = new Set(defaultTelegramModulePolicies().map((policy) => policy.module));
  for (const expected of ["offers", "coaching", "outstation", "weekly_plans", "birthday", "attendance", "field_workforce_compliance"]) {
    assert.ok(moduleNames.has(expected), `default policies should include ${expected}`);
  }
  // Orphaned entries with zero real callers under ANY spelling (verified by grepping every
  // createSystemNotification call site) must not linger — they only make future audits slower.
  // NOTE: "excuses" (plural) is also a zero-caller orphan by that same test, but
  // tests/excuses.test.ts explicitly pins it as deliberate defensive coverage from a prior
  // session, so it is intentionally NOT in this removal list.
  for (const removed of ["payslip", "payslips", "contracts", "leave", "deductions", "coaching_report", "anniversary", "birthdays"]) {
    assert.ok(!moduleNames.has(removed), `orphaned policy "${removed}" must be removed (no real caller uses this exact module string)`);
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
