import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decideTextOnlyAction,
  isTextOnlyReplyEnabled,
  previewInboundText,
  textOnlyReplyText,
  textOnlySenderLabel,
  type TextOnlyContext,
} from "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts";

// An applicant who messages the advertised WhatsApp line WITHOUT attaching a CV used to be dropped
// silently: buffered for source context, no intake event, nobody notified, and erased 24 hours
// later by the buffer's own retention sweep. Measured on production 2026-08-29, that was the
// largest loss on the channel — 461 intake events from 18 senders, of which two forwarding
// handsets carried 439, leaving 22 events from 16 people in five weeks on a number printed across
// many job adverts.
//
// This test pins the two halves that can silently regress:
//   1. the guard set, which decides who gets replied to and who is left alone, and
//   2. that the webhook actually calls the handler — the rule the old code broke by simply
//      `continue`-ing past a message with no document.
//
// Half 2 is the one worth having. The guards are pure and obvious; the wiring is what was missing.

const WEBHOOK_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/webhooks/whatsapp/route.ts", import.meta.url)),
  "utf8",
);

const CHANNEL_GUARD_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/notifications/recruitment-cv-channel-guard.ts", import.meta.url)),
  "utf8",
);

/** A first-time applicant: nothing known about them, reply switched on. */
function newContact(overrides: Partial<TextOnlyContext> = {}): TextOnlyContext {
  return {
    hasOpenClassifySession: false,
    hasRecentCv: false,
    historical: false,
    isImportSender: false,
    priorTextOnlyEventsInWindow: 0,
    replyEnabled: true,
    ...overrides,
  };
}

export function runWhatsAppTextOnlyApplicantTests() {
  // ── The case the whole feature exists for ──────────────────────────────────
  const first = decideTextOnlyAction(newContact());
  assert.deepEqual(
    first,
    { ask: true, notify: true, record: true, reason: "new_contact" },
    "a first-time applicant with no CV is recorded, asked for the file, and reported to a human",
  );

  // ── The forwarders: 95% of this channel's traffic ──────────────────────────
  // Without this guard the owner's own handset is told to send its CV as a file, once per forwarded
  // message, and Talent Acquisition is notified hundreds of times.
  const importSender = decideTextOnlyAction(newContact({ isImportSender: true }));
  assert.deepEqual(
    importSender,
    { ask: false, notify: false, record: false, reason: "import_sender" },
    "a bulk-import handset is never replied to, never notified about, and never recorded as a lost applicant",
  );

  // The import guard must outrank everything, including a sender who looks brand new.
  assert.equal(
    decideTextOnlyAction(newContact({ isImportSender: true, priorTextOnlyEventsInWindow: 0 })).ask,
    false,
    "the import guard outranks first-contact",
  );

  // ── A coexistence history replay is not somebody writing in now ────────────
  assert.deepEqual(
    decideTextOnlyAction(newContact({ historical: true })),
    { ask: false, notify: false, record: false, reason: "historical" },
    "a replayed months-old message never reaches a person or a counter",
  );

  // ── Mid-conversation: they already sent a CV and we are asking them questions ──
  assert.deepEqual(
    decideTextOnlyAction(newContact({ hasOpenClassifySession: true })),
    { ask: false, notify: false, record: false, reason: "classify_open" },
    "someone answering our own menus is never asked to send the CV they already sent",
  );

  // ── Following up on a CV they already sent ─────────────────────────────────
  const followUp = decideTextOnlyAction(newContact({ hasRecentCv: true }));
  assert.equal(followUp.ask, false, "never ask for a CV that arrived inside the window");
  assert.equal(followUp.notify, true, "but a human should still see the follow-up");
  assert.equal(followUp.record, true, "and it is still counted");
  assert.equal(followUp.reason, "already_applied");

  // A follow-up's SECOND message the same day stays quiet, so a chase does not become a stream.
  assert.equal(
    decideTextOnlyAction(newContact({ hasRecentCv: true, priorTextOnlyEventsInWindow: 2 })).notify,
    false,
    "one notification per person per day, follow-ups included",
  );

  // ── One reply and one notification per person per day ──────────────────────
  const repeat = decideTextOnlyAction(newContact({ priorTextOnlyEventsInWindow: 1 }));
  assert.deepEqual(
    repeat,
    { ask: false, notify: false, record: true, reason: "already_handled" },
    "a chatty applicant is counted every time but answered and reported only once",
  );

  // ── The kill switch stops the reply and NOTHING else ───────────────────────
  // The point of the switch is to stop messaging strangers, not to make the channel deaf again.
  const replyOff = decideTextOnlyAction(newContact({ replyEnabled: false }));
  assert.equal(replyOff.ask, false, "the switch stops the outbound reply");
  assert.equal(replyOff.notify, true, "but a human is still told a real person wrote in");
  assert.equal(replyOff.record, true, "and the loss is still countable");
  assert.equal(replyOff.reason, "reply_disabled");

  // ── The switch defaults ON ─────────────────────────────────────────────────
  // A feature that ships dark is indistinguishable from a broken one, which this repo has paid for
  // before. Only the literal string "false" turns it off.
  const savedFlag = process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
  try {
    delete process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
    assert.equal(isTextOnlyReplyEnabled(), true, "unset means ON — the reply works on deploy");
    process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED = "FALSE";
    assert.equal(isTextOnlyReplyEnabled(), false, "the switch is case-insensitive");
    process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED = "true";
    assert.equal(isTextOnlyReplyEnabled(), true);
  } finally {
    if (savedFlag === undefined) delete process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED;
    else process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED = savedFlag;
  }

  // ── What the applicant is actually told ────────────────────────────────────
  const reply = textOnlyReplyText();
  assert.ok(/[؀-ۿ]/.test(reply), "the reply speaks Arabic — that is what applicants write in");
  assert.ok(reply.includes("PDF"), "it names the formats that work");
  assert.ok(
    /photo/i.test(reply),
    "and rules out the photographed CV — 20 events from 5 people were unsupported image attachments",
  );
  const arabicIndex = reply.search(/[؀-ۿ]/);
  assert.ok(arabicIndex < reply.indexOf("Thanks"), "Arabic comes first, not buried under English");

  // ── The notification has to be readable on a phone ─────────────────────────
  assert.equal(previewInboundText(null), "(no text)", "an empty body is stated, never rendered blank");
  assert.equal(previewInboundText("  hello   there \n\n world "), "hello there world", "whitespace is flattened");
  const long = previewInboundText("x".repeat(400));
  assert.ok(long.length <= 161, "a long message is bounded before it reaches a push notification");
  assert.equal(
    previewInboundText("short message", 160),
    "short message",
    "a message inside the bound is never touched",
  );

  assert.equal(
    textOnlySenderLabel("Ahmed Hassan", "+201234567890"),
    "Ahmed Hassan (+201234567890)",
    "a human name is shown, with the number — the owner's rule is names, never raw ids alone",
  );
  assert.equal(
    textOnlySenderLabel("   ", "+201234567890"),
    "+201234567890",
    "a blank profile name falls back to the number rather than an empty label",
  );

  // ── THE WIRING — the half that was actually broken ─────────────────────────
  // The old code read:  if (!message.document) { outcomes.push(...); continue; }
  // with no handler call at all. That single `continue` is the whole defect this feature repairs,
  // so assert the handler is genuinely reached rather than trusting the module's existence.
  assert.ok(
    WEBHOOK_SOURCE.includes("handleTextOnlyMessage"),
    "the webhook calls the text-only handler — without this the module is dead code and the channel is deaf again",
  );
  const noDocumentBranch = WEBHOOK_SOURCE.indexOf("if (!message.document)");
  assert.ok(noDocumentBranch > 0, "the no-document branch still exists");
  assert.ok(
    WEBHOOK_SOURCE.indexOf("handleTextOnlyMessage", noDocumentBranch) > noDocumentBranch,
    "and the handler is called INSIDE that branch, not merely imported somewhere above it",
  );

  // ── The owner's channel rule ───────────────────────────────────────────────
  // "New CV received" notices are in-app + Telegram + push and NEVER email. This event is the same
  // class of notice, and the guard is the enforcement that survives the Telegram-failure fallback
  // re-entering the pipeline with email in its channel list.
  assert.ok(
    CHANNEL_GUARD_SOURCE.includes("recruitment_whatsapp_text_only"),
    "the text-only event is inside the email block — it is a 'someone applied' notice like the others",
  );
}
