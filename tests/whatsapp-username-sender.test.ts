import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as parser from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";

// A WhatsApp user who adopts a USERNAME stops being identified by a phone number. Meta then sends
// `from_user_id` (the business-scoped user id, BSUID) on the message and `user_id` + `profile.username`
// on the contact, and OMITS `from` and `wa_id` unless the business exchanged messages with that phone
// in the last 30 days or holds it as a contact.
//
// 14 Sep 2026: a Future Talents intern with a username sent his closing videos and his submission id to
// the HR line, and production held nothing from him at all — the parser returned null for any message
// with no `from`, before a single row or log line was written. What this suite pins is that such a
// sender is KEPT (videos and typed id alike), that a message naming nobody is still RECORDED, and that
// none of it can reach a path that messages the sender.

const HANDSET_DISPLAY = "+20 11 59888247";
const HANDSET_ID = "999888777";
const BSUID = "EG.13491208655302741918";
const USERNAME = "realsheenanelson";
// 14 Sep 2026 09:00:00 UTC.
const SENT_UNIX = "1789376400";

function usernamePayload(messages: unknown[], contacts: unknown[] = defaultContacts()) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts,
              messages,
              messaging_product: "whatsapp",
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  };
}

/** Meta's documented shape: no `wa_id`, the BSUID as `user_id`, the handle under `profile`. */
function defaultContacts() {
  return [{ profile: { name: "Sheena Nelson", username: USERNAME }, user_id: BSUID }];
}

/** The camera-icon video from a username sender: `from_user_id`, and no `from` at all. */
const usernameVideo = {
  from_user_id: BSUID,
  id: "wamid.USERVIDEO1",
  timestamp: SENT_UNIX,
  type: "video",
  video: { id: "UVMEDIA1", mime_type: "video/mp4" },
};

/** The submission id the same intern typed next to the videos. */
const usernameSubmissionId = {
  from_user_id: BSUID,
  id: "wamid.USERID1",
  text: { body: "FTP-41575822" },
  timestamp: SENT_UNIX,
  type: "text",
};

export async function runWhatsAppUsernameSenderTests() {
  // --- a username sender's video is parsed, not dropped ---------------------------------------
  const videoParsed = parser.parseWhatsAppWebhookPayload(usernamePayload([usernameVideo]));
  assert.equal(videoParsed.length, 1, "a video from a sender with no `from` must be parsed, not silently dropped");
  const [video] = videoParsed;
  assert.equal(video.from, null, "there is no phone number, and none is invented");
  assert.equal(video.userId, BSUID, "the business-scoped user id identifies the sender");
  assert.equal(video.username, USERNAME, "the username is read from the contact's profile");
  assert.equal(video.contactName, "Sheena Nelson", "contacts[] keyed by user_id still supply the profile name");
  assert.equal(video.video?.mediaId, "UVMEDIA1");
  assert.equal(video.document, null, "a video is still never a CV");
  assert.equal(video.deliveredToPhoneNumberId, HANDSET_ID);

  // --- the typed submission id from the same sender is parsed too ------------------------------
  const [typedId] = parser.parseWhatsAppWebhookPayload(usernamePayload([usernameSubmissionId]));
  assert.ok(typedId, "a text from a username sender must be parsed");
  assert.equal(typedId.text, "FTP-41575822");
  assert.equal(typedId.userId, BSUID, "the id and the videos share one sender key, which is what lets them match");

  // --- the spelling in the brief, `user_id` on the message node, is accepted as well -----------
  const [altSpelling] = parser.parseWhatsAppWebhookPayload(
    usernamePayload([{ ...usernameVideo, from_user_id: undefined, id: "wamid.USERVIDEO2", user_id: BSUID }]),
  );
  assert.equal(altSpelling?.userId, BSUID, "a message node carrying `user_id` instead of `from_user_id` is still attributed");

  // --- a top-level `username` on the contact is read when there is no profile handle ------------
  const [topLevelHandle] = parser.parseWhatsAppWebhookPayload(
    usernamePayload([usernameVideo], [{ profile: { name: "Sheena Nelson" }, user_id: BSUID, username: USERNAME }]),
  );
  assert.equal(topLevelHandle.username, USERNAME);

  // --- when the phone IS shared, both identities are carried ----------------------------------
  const [both] = parser.parseWhatsAppWebhookPayload(
    usernamePayload(
      [{ ...usernameVideo, from: "201060213616", id: "wamid.BOTH1" }],
      [{ profile: { name: "Sheena Nelson", username: USERNAME }, user_id: BSUID, wa_id: "201060213616" }],
    ),
  );
  assert.equal(both.from, "201060213616", "a phone number that Meta did send is kept");
  assert.equal(both.userId, BSUID, "and the BSUID beside it, so a later phone-less message links to the same person");
  assert.equal(both.contactName, "Sheena Nelson");

  // A message with no `from` whose contact entry (matched by user_id) does carry the phone.
  const [phoneFromContact] = parser.parseWhatsAppWebhookPayload(
    usernamePayload([usernameVideo], [{ profile: { name: "Sheena Nelson" }, user_id: BSUID, wa_id: "201060213616" }]),
  );
  assert.equal(phoneFromContact.from, "201060213616", "the phone on the matching contact fills a message that omitted it");

  // --- a phone sender is unchanged ------------------------------------------------------------
  const [phoneOnly] = parser.parseWhatsAppWebhookPayload(
    usernamePayload(
      [{ from: "201012345678", id: "wamid.PHONE1", type: "video", video: { id: "PV1", mime_type: "video/mp4" } }],
      [{ profile: { name: "Yasmeen Elsafory" }, wa_id: "201012345678" }],
    ),
  );
  assert.equal(phoneOnly.from, "201012345678");
  assert.equal(phoneOnly.userId, null);
  assert.equal(phoneOnly.username, null);
  assert.equal(phoneOnly.contactName, "Yasmeen Elsafory");

  // --- a history replay from a username sender is kept, and still flagged ----------------------
  const history = {
    entry: [
      {
        changes: [
          {
            field: "history",
            value: {
              contacts: defaultContacts(),
              history: [{ threads: [{ id: BSUID, messages: [usernameVideo] }] }],
              messaging_product: "whatsapp",
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  };
  const [replayed] = parser.parseWhatsAppWebhookPayload(history);
  assert.equal(replayed?.userId, BSUID, "a replayed video from a username sender survives the history envelope");
  assert.equal(replayed.historical, true);

  // --- a message that names NOBODY is reported, never silently dropped ------------------------
  const delivery = parser.parseWhatsAppWebhookDelivery(
    usernamePayload([
      usernameVideo,
      { id: "wamid.NOBODY1", timestamp: SENT_UNIX, type: "video", video: { id: "NV1", mime_type: "video/mp4" } },
      { from_user_id: BSUID, timestamp: SENT_UNIX, type: "text", text: { body: "no id on this one" } },
    ]),
  );
  assert.equal(delivery.messages.length, 1, "only the attributable message becomes a parsed message");
  assert.equal(delivery.unattributed.length, 2, "both unusable nodes are handed back to be recorded");
  const [nobody, noWamid] = delivery.unattributed;
  assert.equal(nobody.wamid, "wamid.NOBODY1");
  assert.equal(nobody.reason, "no_sender");
  assert.equal(nobody.messageType, "video");
  assert.equal(nobody.hasMedia, true);
  assert.equal(nobody.deliveredToPhoneNumberId, HANDSET_ID);
  assert.equal(noWamid.wamid, null);
  assert.equal(noWamid.reason, "no_message_id");
  assert.equal(noWamid.userId, BSUID);
  assert.deepEqual(
    parser.parseWhatsAppWebhookPayload(usernamePayload([{ id: "wamid.NOBODY2", type: "text", text: { body: "hi" } }])),
    [],
    "the flat list keeps its contract: a message with no sender is not a parsed message",
  );

  // --- the CV builder copes with a sender who has no phone ------------------------------------
  const cvFromUsername = {
    ...parser.parseWhatsAppWebhookPayload(
      usernamePayload([
        { document: { filename: "cv.pdf", id: "UCV1", mime_type: "application/pdf" }, from_user_id: BSUID, id: "wamid.UCV1", type: "document" },
      ]),
    )[0],
  };
  const intake = parser.buildWhatsAppIntakeInput(cvFromUsername, null);
  assert.equal(intake.candidate.phone, null, "no phone is invented for a username sender");
  assert.equal(intake.senderIdentifier, BSUID, "the intake log names the sender by BSUID");
  assert.equal((intake.rawMetadata as { userId?: string }).userId, BSUID);
  assert.doesNotMatch(intake.candidate.fullName, /\+null|undefined/, "the fallback name never prints a missing phone");

  // --- the intake event written for a message that cannot be processed -------------------------
  const unattributed = await import("../src/lib/recruitment/inbound/whatsapp-unattributed-sender.ts");
  const usernameText = parser.parseWhatsAppWebhookPayload(usernamePayload([usernameSubmissionId]))[0];
  const textEvent = unattributed.buildUnattributedIntakeEvent({ kind: "no_phone", message: usernameText });
  assert.equal(textEvent.channel, "whatsapp");
  assert.equal(textEvent.outcome, "ignored_no_attachment", "a text with no CV reuses the outcome the CHECK constraint already allows");
  assert.equal(textEvent.provider_message_id, "wamid.USERID1", "idempotent on the message id, like every other intake event");
  assert.equal(textEvent.sender_identifier, BSUID);
  assert.equal(textEvent.sender_display_name, "Sheena Nelson");
  assert.equal((textEvent as Record<string, unknown>).candidate_id, undefined, "never a candidate");
  assert.equal(textEvent.raw_metadata.unattributedSender, true, "the flag a future count keys on");
  assert.equal(textEvent.raw_metadata.userId, BSUID);
  assert.equal(textEvent.raw_metadata.username, USERNAME);
  assert.equal(textEvent.raw_metadata.textOnly, undefined, "never counted as a text-only applicant, which is a path that replies");

  const cvEvent = unattributed.buildUnattributedIntakeEvent({ kind: "no_phone", message: cvFromUsername });
  assert.equal(cvEvent.outcome, "ignored_unsupported_attachment", "a CV that could not be processed stays in the CV-bearing count");
  assert.match(String(cvEvent.error_message), /username/i, "and says why, in words");

  const nobodyEvent = unattributed.buildUnattributedIntakeEvent({ kind: "unattributed", node: nobody });
  assert.equal(nobodyEvent.provider_message_id, "wamid.NOBODY1");
  assert.equal(nobodyEvent.sender_identifier, null, "nobody is named when nobody was sent");
  assert.equal(nobodyEvent.outcome, "ignored_unsupported_attachment", "a media message is recorded as an unprocessed attachment");
  assert.equal(nobodyEvent.raw_metadata.reason, "no_sender");

  // --- nothing on this path can message the sender --------------------------------------------
  const moduleSource = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-unattributed-sender.ts", import.meta.url),
    "utf8",
  ).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(moduleSource, /sendWhatsApp|whatsapp-interactive|whatsapp-reply|notify/i, "recording an unattributed message sends nothing to anyone");

  // --- the webhook routes a phone-less sender before any path that replies ---------------------
  const webhook = readFileSync(new URL("../app/api/webhooks/whatsapp/route.ts", import.meta.url), "utf8");
  const videoAt = webhook.indexOf("captureInboundVideo(");
  const idAt = webhook.indexOf("captureInboundSubmissionId(");
  const recordAt = webhook.indexOf("recordUnattributedWhatsAppMessage(");
  const unattributedAt = webhook.indexOf("for (const node of delivery.unattributed)");
  assert.ok(videoAt > 0 && idAt > 0 && recordAt > 0 && unattributedAt > 0, "the webhook captures videos, ids and unattributed messages");
  for (const replying of ["handleClassifyText({", "bufferWhatsAppMessage(message.from", "handleTextOnlyMessage({", "startClassification({"]) {
    const at = webhook.indexOf(replying);
    assert.ok(at > 0, `expected the webhook to still call ${replying}`);
    assert.ok(videoAt < at && recordAt < at, `a phone-less sender is settled before ${replying}, which can message them`);
  }
  assert.match(webhook, /userId: message\.userId/, "the BSUID reaches the holding tables");

  // --- the thank-you is never aimed at a sender with no phone --------------------------------
  // Sending to a BSUID needs Meta's `recipient` field, not `to`; until the owner decides, the one
  // permitted message goes only to a phone number, exactly as before.
  const thanks = readFileSync(new URL("../src/lib/whatsapp-videos/thanks.ts", import.meta.url), "utf8");
  assert.equal(
    (thanks.match(/\.not\("wa_id", "is", null\)/g) ?? []).length,
    2,
    "both the video and the id reads skip rows with no phone number",
  );

  // --- the holding tables accept a sender with no phone, but never one with no identity at all --
  const migration = readFileSync(
    new URL("../supabase/migrations/20260915090000_whatsapp_inbound_username_senders.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["whatsapp_inbound_video", "whatsapp_inbound_submission_id"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table}\\s+alter column wa_id drop not null`), `${table}.wa_id becomes nullable`);
    assert.match(migration, new RegExp(`${table}_has_sender[\\s\\S]*?check \\(wa_id is not null or user_id is not null\\)`), `${table} still refuses a row naming nobody`);
  }
}
