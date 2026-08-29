import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decideUnreadableCvAction,
  isUnreadableCvReplyEnabled,
  unreadableCvReplyText,
  type UnreadableCvContext,
} from "../src/lib/recruitment/inbound/whatsapp-unreadable-cv.ts";
import { enforceRecruitmentCvEmailBlock } from "../src/lib/notifications/recruitment-cv-channel-guard.ts";

// An applicant who sends a PHOTOGRAPH of their CV — the way a phone makes easiest — reached a dead
// end. The image was downloaded and read, the content check judged it not to be a CV, the intake
// event was written, and then nothing: no candidate, no reply to the applicant, no alert to anyone.
// Measured on production 2026-08-29, four members of the public hit this since 25 July. One rescued
// herself by sending a PDF five seconds later; the other three were never heard from again. One of
// them, Hind, had been told by Phoenix minutes earlier to "send it as a file" and had answered with
// a picture — which is the whole reason the reply below names the paperclip and the Document button
// instead of repeating a sentence already measured not to work.
//
// This pins the three halves that can silently regress:
//   1. the guard set, which decides who is written to and who is left alone,
//   2. that the WORKER actually calls the handler on that outcome — the wiring, which is what was
//      missing before, exactly as it was for the text-only sibling, and
//   3. that this notice can never be emailed, the standing owner rule for "somebody applied".

const WORKER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/intake-worker.ts", import.meta.url)),
  "utf8",
);

/** A first-time unreadable attachment: nothing known about this sender, reply switched on. */
function firstAttempt(overrides: Partial<UnreadableCvContext> = {}): UnreadableCvContext {
  return {
    historical: false,
    isImportSender: false,
    priorUnreadableInWindow: 0,
    replyEnabled: true,
    ...overrides,
  };
}

export async function runWhatsAppUnreadableCvTests(): Promise<void> {
  // --- the guards ------------------------------------------------------------------------------

  const fresh = decideUnreadableCvAction(firstAttempt());
  assert.equal(fresh.reason, "unreadable", "a first unreadable attachment is the real case");
  assert.equal(fresh.ask, true, "and the applicant is asked to resend it as a file");
  assert.equal(fresh.notify, true, "and a human is told, because only a human can open the picture");

  assert.equal(
    decideUnreadableCvAction(firstAttempt({ isImportSender: true })).ask,
    false,
    "a bulk-forwarding handset is not the applicant and must never be written to",
  );
  assert.equal(
    decideUnreadableCvAction(firstAttempt({ isImportSender: true })).notify,
    false,
    "nor paged — the owner forwarding his own certificates is not an incident",
  );
  assert.equal(
    decideUnreadableCvAction(firstAttempt({ historical: true })).ask,
    false,
    "a coexistence history replay must not message months of past senders at once",
  );

  const repeat = decideUnreadableCvAction(firstAttempt({ priorUnreadableInWindow: 3 }));
  assert.equal(repeat.reason, "already_handled", "a photographed multi-page certificate is ONE conversation");
  assert.equal(repeat.ask, false, "so it is answered once, not once per page");
  assert.equal(repeat.notify, false, "and paged once, not once per page");

  // The kill switch stops Phoenix TALKING; it must never stop it telling a human somebody is
  // waiting. Muting both is how a switch flipped in an incident becomes a second, silent outage.
  const muted = decideUnreadableCvAction(firstAttempt({ replyEnabled: false }));
  assert.equal(muted.reason, "reply_disabled");
  assert.equal(muted.ask, false, "the applicant is not written to when the reply is switched off");
  assert.equal(muted.notify, true, "but a human is STILL told");

  // Order matters: an import sender that is also a repeat must answer import_sender, because the
  // cheap guards have to win before anything reaches the database.
  assert.equal(
    decideUnreadableCvAction(firstAttempt({ isImportSender: true, priorUnreadableInWindow: 9 })).reason,
    "import_sender",
    "the no-database guards are answered first",
  );

  // --- the kill switch default ------------------------------------------------------------------

  const savedFlag = process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
  try {
    delete process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
    assert.equal(isUnreadableCvReplyEnabled(), true, "unset means ON — the recovery is the default");
    process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED = "FALSE";
    assert.equal(isUnreadableCvReplyEnabled(), false, "and the switch is case-insensitive");
  } finally {
    if (savedFlag === undefined) delete process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
    else process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED = savedFlag;
  }

  // --- what the applicant reads -----------------------------------------------------------------

  const photoReply = unreadableCvReplyText("not_recognised");
  assert.ok(/[؀-ۿ]/.test(photoReply), "Arabic is present — the applicants write in Arabic");
  assert.ok(
    photoReply.search(/[؀-ۿ]/) < photoReply.indexOf("Thanks for contacting"),
    "and Arabic comes FIRST, not buried under an English paragraph",
  );
  assert.ok(photoReply.includes("Document"), "it names the Document option, which is the actionable part");
  assert.ok(
    photoReply.includes("PDF") && photoReply.includes("Word"),
    "and the two formats that actually work",
  );
  assert.ok(
    !/rejected|not a CV|ليست سيرة/i.test(photoReply),
    "it never tells anyone their CV was rejected — the content check is not accurate enough to say so",
  );

  // The size ceiling is env-overridable, so the number in the message must be DERIVED. A hard-coded
  // one sends people away to shrink a file the system would have accepted.
  const bigReply = unreadableCvReplyText("too_large", 25 * 1024 * 1024);
  assert.ok(bigReply.includes("25 MB"), "the size limit is read from the real ceiling, not written down twice");
  assert.ok(!bigReply.includes("15 MB"), "and the default does not leak through when a ceiling is given");
  assert.ok(
    unreadableCvReplyText("too_large").includes("15 MB"),
    "with the documented default when none is given",
  );

  // --- the owner rule: this notice can never be emailed -----------------------------------------

  assert.deepEqual(
    enforceRecruitmentCvEmailBlock(
      ["email", "in_app", "telegram", "push"],
      "recruitment",
      "recruitment_whatsapp_unreadable_cv",
    ),
    ["in_app", "telegram", "push"],
    "email is stripped even when a call site or the Telegram fallback re-adds it",
  );

  // --- the wiring, which is the half that was actually missing -----------------------------------

  assert.ok(
    WORKER_SOURCE.includes("handleUnreadableWhatsAppCv"),
    "the worker imports and calls the handler",
  );
  const outcomeBranch = WORKER_SOURCE.indexOf('result.outcome === "ignored_unsupported_attachment"');
  assert.ok(outcomeBranch > 0, "the worker still branches on the unsupported-attachment outcome");
  assert.ok(
    WORKER_SOURCE.indexOf("handleUnreadableWhatsAppCv", outcomeBranch) > outcomeBranch,
    "and the handler is called INSIDE that branch, not merely imported somewhere above it",
  );
  // The oversized file returns EARLY, before the branch above is ever reached. That path was silent
  // too, and a refactor that drops its call would be invisible to the assertion above.
  const tooLargeBranch = WORKER_SOURCE.indexOf("WhatsAppMediaTooLargeError");
  assert.ok(tooLargeBranch > 0 && tooLargeBranch < outcomeBranch, "the too-large early return still exists");
  assert.ok(
    WORKER_SOURCE.indexOf("handleUnreadableWhatsAppCv", tooLargeBranch) < outcomeBranch,
    "and it too tells the applicant, rather than returning in silence",
  );
}
