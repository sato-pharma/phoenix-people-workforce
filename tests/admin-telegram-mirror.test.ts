import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ADMIN_STANDING_EMAIL, buildAdminMirrorMessage } from "@/lib/email/admin-telegram-mirror.ts";
import { shouldMirrorEmailToAdminTelegram } from "@/lib/email/transactional-types.ts";

/**
 * Every automated email must fire a Telegram "twin" to the standing admin — since 2026-11-06 his
 * only copy (the always-BCC it once mirrored was stopped: "Stop the BCC copies") — and that mirror
 * must never be able to break the email send.
 */
export async function runAdminTelegramMirrorTests() {
  // --- The standing admin is the owner's own mailbox identity ---------------------
  assert.equal(
    ADMIN_STANDING_EMAIL,
    "omar.anwar@satopharma.com",
    "the Telegram mirror targets the standing admin, the owner's own mailbox identity",
  );

  // --- Subject → title, recipient + body preview into the message -------------------
  const basic = buildAdminMirrorMessage({
    subject: "Direct order pending approval",
    to: ["anwar.gaweesh@satopharma.com"],
    text: "A new direct order from Cairo is waiting for your approval.",
  });
  assert.equal(basic.title, "Direct order pending approval", "the email subject becomes the Telegram title");
  assert.match(basic.message, /To: anwar\.gaweesh@satopharma\.com/, "the visible recipient is shown");
  assert.match(basic.message, /waiting for your approval/, "the body preview is included");

  // --- A blank subject falls back to a stable title, never empty --------------------
  const noSubject = buildAdminMirrorMessage({ subject: "  ", to: ["a@b.com"] });
  assert.equal(noSubject.title, "Phoenix email", "a blank subject falls back to a stable title");

  // --- HTML-only mail is stripped to readable text ----------------------------------
  const fromHtml = buildAdminMirrorMessage({
    subject: "Expense needs review",
    to: ["mgr@satopharma.com"],
    html: "<div><b>Rasha</b> submitted <i>647.61 EGP</i></div>",
  });
  assert.doesNotMatch(fromHtml.message, /<[^>]+>/, "no HTML tags survive into the Telegram text");
  assert.match(fromHtml.message, /Rasha submitted 647\.61 EGP/, "the visible text is preserved");

  // --- Long recipient lists are summarised, not dumped ------------------------------
  const many = buildAdminMirrorMessage({
    subject: "Fan-out",
    to: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"],
  });
  assert.match(many.message, /\(\+2 more\)/, "recipients beyond the shown cap are counted, not listed");

  // --- Over-long previews are truncated with an ellipsis ----------------------------
  const long = buildAdminMirrorMessage({ subject: "s", to: ["a@b.com"], text: "x".repeat(900) });
  assert.ok(long.message.length < 900, "an over-long preview is truncated");
  assert.match(long.message, /…$/, "a truncated preview ends with an ellipsis");

  // --- Wiring: the mirror is invoked from the ONE email chokepoint, safely -----------
  const sendSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(sendSource, /mirrorEmailToAdminTelegram/, "the send path calls the Telegram mirror");
  assert.match(
    sendSource,
    /sendPreparedEmailWithFailover\(prepared\)[\s\S]*mirrorEmailToAdminTelegram/,
    "the mirror fires AFTER the email is dispatched, never before",
  );
  // Since 23 Oct 2026 the gate is one decision, shouldMirrorEmailToAdminTelegram, which also withholds
  // the two credential emails (owner: "Skip credential emails"). It is still fed the testing redirect,
  // and the call stays fire-and-forget.
  assert.match(
    sendSource,
    /if \(shouldMirrorEmailToAdminTelegram\(\{ credentialEmail: input\.credentialEmail, testingRedirectActive: Boolean\(testingRecipients\) \}\)\) \{\s*void mirrorEmailToAdminTelegram/,
    "the mirror is fire-and-forget (void) and skipped in testing-redirect mode",
  );
  assert.equal(
    shouldMirrorEmailToAdminTelegram({ credentialEmail: null, testingRedirectActive: true }),
    false,
    "the mirror is fire-and-forget (void) and skipped in testing-redirect mode",
  );
  assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: null, testingRedirectActive: false }), true, "an ordinary email keeps its Telegram twin");

  // --- Wiring: the mirror module can never throw into the caller ---------------------
  const mirrorSource = readFileSync("src/lib/email/admin-telegram-mirror.ts", "utf8");
  assert.match(mirrorSource, /sendTelegramNotification/, "the mirror sends via the shared Telegram client");
  assert.match(mirrorSource, /catch \(error\)/, "the mirror swallows failures so email is never affected");
}
