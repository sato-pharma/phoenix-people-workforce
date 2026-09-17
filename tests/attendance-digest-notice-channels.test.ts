import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sanitizeEmailTemplateHtml } from "../src/lib/email/email-safety.ts";
import { interpolate } from "../src/lib/email-templates/render-core.ts";
import { emailKeepsLineBreaks, isAttendanceDigestModule, telegramKeepsParagraphs } from "../src/lib/notifications/attendance-digest-channels.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { telegramNotificationText } from "../src/lib/notifications/telegram.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

// Owner rule (2026-09-17, replacing 2026-09-15's "never email"): when a week of attendance is
// released, and when a reviewer decides a disputed day, the employee is told BY EMAIL to their own
// work address, BY TELEGRAM and IN-APP.
//
// What has to hold for that:
//   1. the policy row asks for all three, with email named before Telegram — a permanent Telegram
//      failure falls back to email only when email has not been tried yet, so the other order
//      emails the employee twice
//   2. both notices name the same three channels in the same order (explicit channels bypass the
//      policy's list)
//   3. nothing on the delivery path strips email for this module any more
//   4. Telegram is explicitly allowed with full content, or the unknown-module fail-safe disables it
//   5. the Telegram text keeps its paragraphs and carries no "Module:" line, and the email body shows
//      its line breaks — for this module only
//   6. the employee's direct manager is copied on the email (owner, 2026-09-17: "Also CC direct
//      manager"), which rests on the employee being named as the notice's subject

export function runAttendanceDigestNoticeChannelsTests() {
  for (const eventType of ["week_released", "dispute_decided"]) {
    const policy = resolveNotificationPolicy({ module: "attendance_digest", eventType });
    for (const channel of ["in_app", "email", "telegram"] as const) {
      assert.equal(policy.channels.includes(channel), true, `the attendance_digest policy for ${eventType} asks for ${channel}`);
    }
    assert.ok(
      policy.channels.indexOf("email") < policy.channels.indexOf("telegram"),
      `email is named before Telegram for ${eventType}, or a Telegram failure emails the employee a second time`,
    );
  }

  {
    const notify = readFileSync("src/lib/attendance/digest-notify.ts", "utf8");
    assert.equal(
      (notify.match(/channels: \["in_app", "email", "telegram"\],/g) ?? []).length,
      2,
      "the release notice and the dispute decision notice each go in-app, by email and on Telegram, email before Telegram",
    );
    assert.doesNotMatch(notify, /channels: \[[^\]]*"telegram"[^\]]*"email"/, "no notice names Telegram before email");

    // The manager's copy: the email system CCs the direct manager when the email names an employee
    // subject and that employee is the To recipient. Dropping the subject from either notice would
    // silently stop the copy the owner chose to keep.
    assert.equal(
      (notify.match(/subjectHrId: input\.employeeHrId,/g) ?? []).length,
      2,
      "both notices name the employee as the subject, which is what copies their direct manager on the email",
    );
    const email = readFileSync("src/lib/notifications/email.ts", "utf8");
    assert.match(
      email,
      /const templateEnriched = await enrichRecipientsWithManagerCc\(input, templateToClean\);/,
      "the templated notification email still adds the direct manager as CC",
    );
  }

  {
    // The old guard stripped email for this module on every path, including the Telegram-failure
    // fallback. Leaving a call to it anywhere would silently undo the owner's rule.
    const system = readFileSync("src/lib/notifications/system.ts", "utf8");
    assert.doesNotMatch(system, /enforceAttendanceDigestEmailBlock/, "system.ts must no longer strip email from the weekly attendance review");
    assert.doesNotMatch(system, /attendance-digest-channel-guard/, "the old email guard is gone");
    const base = system.slice(system.indexOf("function basePolicyChannels"), system.indexOf("function resolveBasePolicyChannels"));
    assert.ok(base.length > 0, "basePolicyChannels was found");
    assert.doesNotMatch(base, /AttendanceDigest/, "basePolicyChannels applies no attendance_digest block");

    // No "Module: Attendance digest" line in front of this module's Telegram message.
    const messageFor = system.slice(system.indexOf("function telegramMessageFor"), system.indexOf("Module: ${"));
    assert.match(
      messageFor,
      /if \(isAttendanceDigestModule\(input\.module\)\) return input\.message;/,
      "telegramMessageFor returns the weekly attendance review's message as it is, before the Module: line is added",
    );

    // An email held for quiet hours is sent when they end, so the held Telegram message must not
    // fall back to a second email if its retries run out (risk review, 2026-09-17).
    assert.match(
      system,
      /deferredMetadata\.emailInput = emailInput;[\s\S]{0,400}?emailAttempted = true;\s*\} else if \(channel === "email"\) \{/,
      "an email held for quiet hours counts as attempted, so a failed Telegram message does not email the person twice",
    );

    // Every Telegram send asks for paragraphs by module, and never for a generic-only message.
    assert.equal((system.match(/keepParagraphs: !governance\.genericOnly && telegramKeepsParagraphs\(telegram\.module\),/g) ?? []).length, 2, "both Telegram retry paths keep paragraphs by the stored module");
    assert.equal((system.match(/keepParagraphs: !genericTelegram && telegramKeepsParagraphs\(input\.module\),/g) ?? []).length, 1, "the live Telegram send keeps paragraphs by module");
  }

  {
    const policy = defaultTelegramPolicyFor("attendance_digest");
    assert.equal(policy.enabled, true, "attendance_digest needs an explicit Telegram policy, or the unknown-module fail-safe turns Telegram off");
    assert.equal(policy.genericOnly, false, "a generic ping does not tell the employee there is a deadline");
  }

  {
    assert.equal(telegramKeepsParagraphs("attendance_digest"), true);
    assert.equal(telegramKeepsParagraphs("  Attendance_Digest "), true);
    for (const other of ["attendance", "early_birds", "payroll", "phoenix_crm", null, undefined]) {
      assert.equal(telegramKeepsParagraphs(other), false, `${String(other)} keeps its one-block Telegram text`);
    }

    const title = "Attendance review — Wednesday 9 September";
    const message = "Your attendance on Wednesday 9 September has a deduction.\n\nChoose salary   or balance.\n\nPlease answer by Friday.";
    assert.equal(
      telegramNotificationText({ title, message, keepParagraphs: true }),
      "Attendance review — Wednesday 9 September\n\nYour attendance on Wednesday 9 September has a deduction.\n\nChoose salary or balance.\n\nPlease answer by Friday.",
      "the weekly attendance notice reaches Telegram as a letter: title, then each paragraph on its own",
    );
    assert.equal(
      telegramNotificationText({ title, message }),
      "Attendance review — Wednesday 9 September\n\nYour attendance on Wednesday 9 September has a deduction. Choose salary or balance. Please answer by Friday.",
      "every other module's message is still one block",
    );
    assert.doesNotMatch(telegramNotificationText({ title: "t", message: "<b>x</b>\n\ny", keepParagraphs: true }), /[<>]/, "markup is still stripped when paragraphs are kept");
  }

  {
    // The email body is HTML, where a bare line break collapses into a space: without this the
    // three paragraphs of the notice arrive as one block of text.
    assert.equal(emailKeepsLineBreaks("attendance_digest"), true);
    for (const other of ["attendance", "early_birds", "payroll", "phoenix_crm", null, undefined]) {
      assert.equal(emailKeepsLineBreaks(other), false, `${String(other)} keeps its email body as before`);
    }

    const body = "<p>{{summary}}</p>";
    const summary = "Your attendance on Wednesday 9 September has a deduction.\n\nChoose <salary> or balance.";
    const kept = interpolate(body, { summary }, true, undefined, { lineBreaks: true });
    assert.equal(
      kept,
      "<p>Your attendance on Wednesday 9 September has a deduction.<br /><br />Choose &lt;salary&gt; or balance.</p>",
      "asked for, each line break becomes a break, and the value is still escaped",
    );
    assert.equal(
      sanitizeEmailTemplateHtml(kept),
      kept,
      "the breaks survive the email sanitizer",
    );
    assert.equal(
      interpolate(body, { summary }, true),
      "<p>Your attendance on Wednesday 9 September has a deduction.\n\nChoose &lt;salary&gt; or balance.</p>",
      "not asked for, the body renders exactly as before, for every other email",
    );
    assert.equal(interpolate("{{summary}}", { summary }, false, undefined, { lineBreaks: true }), summary, "a text field is never given HTML breaks");

    // The flag has to reach the render from the notification's module.
    const email = readFileSync("src/lib/notifications/email.ts", "utf8");
    assert.match(email, /lineBreaks: emailKeepsLineBreaks\(input\.module\),/, "the templated notification email asks for breaks by module");
    const service = readFileSync("src/lib/email-templates/service.ts", "utf8");
    assert.match(service, /renderEmailTemplate\(template, context, to, customVariables, \{ heroStat: input\.heroStat, lineBreaks: input\.lineBreaks \}\)/, "sendTemplatedEmail passes it to the render");
    assert.match(service, /interpolate\(template\.bodyHtml, variables, true, htmlBlockTokens, \{ lineBreaks: options\.lineBreaks \}\)/, "the render applies it to the HTML body");
  }

  assert.equal(isAttendanceDigestModule("attendance_digest"), true);
  assert.equal(isAttendanceDigestModule("attendance"), false, "the plain attendance module is a different module");
  assert.equal(isAttendanceDigestModule(null), false);
}
