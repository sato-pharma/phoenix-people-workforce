import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canUseWhatsAppInbox } from "../src/lib/whatsapp-inbox/access.ts";
import {
  buildTemplateMessage,
  INBOX_UPLOAD_MAX_BYTES,
  mapInboxTemplate,
  mediaLimitProblem,
  missingTemplateFields,
  outboundMediaTypeFor,
  renderInboxTemplate,
} from "../src/lib/whatsapp-inbox/graph.ts";
import { findWhatsAppInboxLine, whatsAppInboxLineLabel, whatsAppInboxLines } from "../src/lib/whatsapp-inbox/lines.ts";
import { buildInboxOutboundRow } from "../src/lib/whatsapp-inbox/record.ts";
import { isSameWhatsAppNumber, parseInboxDelivery, unixSecondsToIso } from "../src/lib/whatsapp-inbox/webhook-parse.ts";
import {
  conversationTitle,
  describeDeliveryStatus,
  formatListTime,
  formatWindowLeft,
  isNewCairoDay,
} from "../src/components/whatsapp-inbox/inbox-format.ts";

// The WhatsApp Inbox (owner, 2026-09-15): both company numbers read, answered and saved inside Phoenix,
// by the Super Admin only. What this suite pins:
//
//   · the webhook reader keeps every message on both numbers, both directions — live, echoed from the
//     handset, and replayed from the phone's history — and never files the company as a contact;
//   · a Phoenix send is recorded from exactly what was posted, and a failure carries its reason;
//   · a template's title blank and message blank never share one value;
//   · the Super Admin gate is on the page AND on every route, and every mutation checks its origin;
//   · the webhook records the inbox BEFORE the recruitment pipeline, and never fails the delivery.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const RECRUITMENT_ID = "1319071451278873";
const RECRUITMENT_DISPLAY = "+20 10 98500699";
const HANDSET_ID = "477586495433549";
const HANDSET_DISPLAY = "+20 11 59888247";
const APPLICANT = "201001234567";
// 15 Sep 2026 09:00:00 UTC = 12:00 Cairo.
const SENT_UNIX = "1789462800";

function delivery(value: Record<string, unknown>, phoneNumberId = RECRUITMENT_ID, display = RECRUITMENT_DISPLAY) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { display_phone_number: display, phone_number_id: phoneNumberId }, ...value },
          },
        ],
      },
    ],
    object: "whatsapp_business_account",
  };
}

function runParserTests() {
  // A live text from an applicant, with their WhatsApp name.
  const live = parseInboxDelivery(
    delivery({
      contacts: [{ profile: { name: "Mona Adel" }, wa_id: APPLICANT }],
      messages: [{ from: APPLICANT, id: "wamid.live1", text: { body: "مساء الخير\nI sent my CV" }, timestamp: SENT_UNIX, type: "text" }],
    }),
  );
  assert.equal(live.messages.length, 1);
  const [text] = live.messages;
  assert.equal(text!.direction, "inbound");
  assert.equal(text!.origin, "contact");
  assert.equal(text!.contactWaId, APPLICANT);
  assert.equal(text!.contactName, "Mona Adel");
  assert.equal(text!.phoneNumberId, RECRUITMENT_ID);
  assert.equal(text!.body, "مساء الخير\nI sent my CV");
  assert.equal(text!.historical, false);
  assert.equal(text!.sentAt, "2026-09-15T09:00:00.000Z");

  // A message the business number itself appears to send on `messages` must not become a chat with the company.
  const self = parseInboxDelivery(
    delivery({ messages: [{ from: "201098500699", id: "wamid.self", text: { body: "hi" }, timestamp: SENT_UNIX, type: "text" }] }),
  );
  assert.equal(self.messages.length, 0, "the company is never filed as its own contact");

  // Typed on the handset's own WhatsApp Business app: the smb_message_echoes field.
  const echo = parseInboxDelivery(
    delivery(
      { message_echoes: [{ from: "201159888247", id: "wamid.echo1", text: { body: "Come in at 10" }, timestamp: SENT_UNIX, to: APPLICANT, type: "text" }] },
      HANDSET_ID,
      HANDSET_DISPLAY,
    ),
  );
  assert.equal(echo.messages.length, 1);
  assert.equal(echo.messages[0]!.direction, "outbound");
  assert.equal(echo.messages[0]!.origin, "handset");
  assert.equal(echo.messages[0]!.contactWaId, APPLICANT, "an echo's contact is its recipient, never the business");
  assert.equal(echo.messages[0]!.phoneNumberId, HANDSET_ID);

  // History replay: BOTH directions in one thread, the thread id naming the contact.
  const history = parseInboxDelivery(
    delivery(
      {
        history: [
          {
            threads: [
              {
                id: APPLICANT,
                messages: [
                  { from: APPLICANT, id: "wamid.h1", text: { body: "Hello" }, timestamp: SENT_UNIX, type: "text" },
                  { from: "201159888247", history_context: { status: "READ" }, id: "wamid.h2", text: { body: "Welcome" }, timestamp: SENT_UNIX, type: "text" },
                ],
              },
            ],
          },
        ],
      },
      HANDSET_ID,
      HANDSET_DISPLAY,
    ),
  );
  assert.equal(history.messages.length, 2);
  const [theirs, ours] = history.messages;
  assert.equal(theirs!.direction, "inbound");
  assert.equal(theirs!.historical, true);
  assert.equal(ours!.direction, "outbound");
  assert.equal(ours!.origin, "handset");
  assert.equal(ours!.contactWaId, APPLICANT, "a replayed handset message is filed under the thread's contact");
  assert.equal(ours!.replayStatus, "read");
  assert.equal(ours!.historical, true);

  // A username-only sender (no phone) is kept, keyed by the business-scoped user id.
  const username = parseInboxDelivery(
    delivery({
      contacts: [{ profile: { name: "Sheena", username: "sheena" }, user_id: "EG.1349" }],
      messages: [{ from_user_id: "EG.1349", id: "wamid.user1", text: { body: "hi" }, timestamp: SENT_UNIX, type: "text" }],
    }),
  );
  assert.equal(username.messages.length, 1);
  assert.equal(username.messages[0]!.contactWaId, null);
  assert.equal(username.messages[0]!.contactUserId, "EG.1349");
  assert.equal(username.messages[0]!.contactUsername, "sheena");

  // Structures read as sentences, never as type codes.
  const shapes = parseInboxDelivery(
    delivery({
      messages: [
        { from: APPLICANT, id: "wamid.loc", location: { address: "Tahrir Sq", latitude: 30.04, longitude: 31.23, name: "Office" }, timestamp: SENT_UNIX, type: "location" },
        { from: APPLICANT, id: "wamid.react", reaction: { emoji: "👍", message_id: "wamid.ours" }, timestamp: SENT_UNIX, type: "reaction" },
        { document: { filename: "cv.pdf", id: "media-1", mime_type: "application/pdf" }, from: APPLICANT, id: "wamid.doc", timestamp: SENT_UNIX, type: "document" },
        { from: APPLICANT, id: "wamid.live1", text: { body: "duplicate of an earlier node" }, timestamp: SENT_UNIX, type: "text" },
        { from: APPLICANT, id: "wamid.live1", text: { body: "same wamid twice in one delivery" }, timestamp: SENT_UNIX, type: "text" },
      ],
    }),
  );
  const byId = new Map(shapes.messages.map((message) => [message.wamid, message]));
  assert.equal(byId.get("wamid.loc")!.body, "Shared a location: Office, Tahrir Sq (30.04, 31.23)");
  assert.equal(byId.get("wamid.react")!.body, "Reacted 👍");
  assert.equal(byId.get("wamid.react")!.replyToWamid, "wamid.ours");
  assert.deepEqual(byId.get("wamid.doc")!.media, { fileName: "cv.pdf", id: "media-1", mimeType: "application/pdf" });
  assert.equal(shapes.messages.filter((message) => message.wamid === "wamid.live1").length, 1, "one wamid is one row");

  // Delivery ticks, with the reason a failure gives.
  const ticks = parseInboxDelivery(
    delivery({
      statuses: [
        { id: "wamid.out1", recipient_id: APPLICANT, status: "delivered", timestamp: SENT_UNIX },
        { errors: [{ code: 131047, error_data: { details: "Message failed to send because more than 24 hours have passed" }, title: "Re-engagement message" }], id: "wamid.out2", status: "failed", timestamp: SENT_UNIX },
        { id: "wamid.out3", status: "deleted", timestamp: SENT_UNIX },
      ],
    }),
  );
  assert.equal(ticks.statuses.length, 2, "an unknown status is ignored, not stored");
  assert.equal(ticks.statuses[0]!.status, "delivered");
  assert.equal(ticks.statuses[0]!.failureDetail, null);
  assert.equal(ticks.statuses[1]!.failureDetail, "Message failed to send because more than 24 hours have passed");

  assert.equal(isSameWhatsAppNumber("+20 10 98500699", "201098500699"), true);
  assert.equal(isSameWhatsAppNumber("201098500699", "201098500698"), false);
  assert.equal(unixSecondsToIso("not a time"), null, "a bad timestamp is null, never 1970");
}

function runOutboundRowTests() {
  const now = new Date("2026-09-15T09:00:00.000Z");
  const text = buildInboxOutboundRow({
    event: "whatsapp_inbox_text_send",
    inbox: { sentByHrId: "B-10" },
    now,
    payload: { messaging_product: "whatsapp", text: { body: "See you at 10" }, to: "+20 100 123 4567", type: "text" },
    phoneNumberId: RECRUITMENT_ID,
    result: { ok: true, wamid: "wamid.sent1" },
  });
  assert.ok(text);
  assert.equal(text.contact_wa_id, "201001234567", "the recipient is stored as digits, the key the conversation uses");
  assert.equal(text.body, "See you at 10");
  assert.equal(text.status, "accepted");
  assert.equal(text.wamid, "wamid.sent1");
  assert.equal(text.origin, "phoenix");
  assert.equal(text.direction, "outbound");
  assert.equal(text.sent_by_hr_id, "B-10");
  assert.equal(text.failure_reason, null);

  const failed = buildInboxOutboundRow({
    event: "whatsapp_inbox_text_send",
    now,
    payload: { text: { body: "late" }, to: APPLICANT, type: "text" },
    phoneNumberId: RECRUITMENT_ID,
    result: { detail: "More than 24 hours have passed", ok: false, reason: "window_closed" },
  });
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_reason, "window_closed", "a failed row carries its reason (the table's check requires it)");
  assert.equal(failed.wamid, null, "a refused send has no wamid");

  const template = buildInboxOutboundRow({
    event: "whatsapp_inbox_template_send",
    inbox: { renderedBody: "Hello Mona, please send your ID." },
    now,
    payload: { template: { language: { code: "en" }, name: "document_request" }, to: APPLICANT, type: "template" },
    phoneNumberId: RECRUITMENT_ID,
    result: { ok: true, wamid: "wamid.t1" },
  });
  assert.equal(template!.body, "Hello Mona, please send your ID.", "a template is stored as the words the person read");
  assert.equal(template!.template_name, "document_request");

  const media = buildInboxOutboundRow({
    event: "whatsapp_inbox_media_send",
    inbox: { mediaByteSize: 2048, mediaFileName: "offer.pdf", mediaMimeType: "application/pdf", mediaStoragePath: "outbound/2026-09/x-offer.pdf" },
    now,
    payload: { document: { caption: "Your offer", filename: "offer.pdf", id: "media-9" }, to: APPLICANT, type: "document" },
    phoneNumberId: RECRUITMENT_ID,
    result: { ok: true, wamid: "wamid.m1" },
  });
  assert.equal(media!.body, "Your offer");
  assert.equal(media!.media_id, "media-9");
  assert.equal(media!.media_storage_path, "outbound/2026-09/x-offer.pdf");
  assert.equal(media!.media_fetched_at, now.toISOString(), "a file already in our storage is marked fetched, so the cron never re-downloads it");

  assert.equal(
    buildInboxOutboundRow({ event: "x", payload: { text: { body: "no one" }, type: "text" }, phoneNumberId: RECRUITMENT_ID, result: { ok: true, wamid: "w" } }),
    null,
    "a payload with no recipient cannot be placed in a chat",
  );
}

function runTemplateTests() {
  // Positional title AND body both number their blanks from 1 — they must stay two separate values.
  const positional = mapInboxTemplate({
    components: [
      { example: { header_text: ["Interview"] }, format: "TEXT", text: "{{1}} invitation", type: "HEADER" },
      { example: { body_text: [["Mona", "Sunday"]] }, text: "Hello {{1}}, your interview is on {{2}}.", type: "BODY" },
      { text: "Sato Pharma", type: "FOOTER" },
    ],
    language: "en",
    name: "interview_invite",
    status: "APPROVED",
  });
  assert.ok(positional);
  assert.deepEqual(positional.headerFields.map((field) => field.key), ["header:1"]);
  assert.deepEqual(positional.bodyFields.map((field) => field.key), ["body:1", "body:2"]);
  const values = { "body:1": "Mona", "body:2": "Sunday", "header:1": "Interview" };
  assert.equal(
    renderInboxTemplate(positional, values),
    "Interview invitation\n\nHello Mona, your interview is on Sunday.\n\nSato Pharma",
    "the title's blank 1 and the message's blank 1 are filled from their own values",
  );
  const built = buildTemplateMessage(positional, values) as unknown as { template: { components: Array<{ type: string; parameters: Array<Record<string, string>> }> } };
  assert.deepEqual(built.template.components, [
    { parameters: [{ text: "Interview", type: "text" }], type: "header" },
    { parameters: [{ text: "Mona", type: "text" }, { text: "Sunday", type: "text" }], type: "body" },
  ]);
  assert.deepEqual(missingTemplateFields(positional, { "body:1": "Mona" }), ["Title blank 1", "Message blank 2"]);

  const named = mapInboxTemplate({
    components: [{ example: { body_text_named_params: [{ example: "Mona", param_name: "first_name" }] }, text: "Hi {{first_name}}", type: "BODY" }],
    language: "en",
    name: "named_hello",
    parameter_format: "NAMED",
  });
  assert.equal(named!.bodyFields[0]!.name, "first_name");
  assert.equal(named!.bodyFields[0]!.example, "Mona");
  const namedBuilt = buildTemplateMessage(named!, { "body:first_name": "Mona" }) as unknown as { template: { components: Array<{ parameters: Array<Record<string, string>> }> } };
  assert.equal(namedBuilt.template.components[0]!.parameters[0]!.parameter_name, "first_name", "a named template sends its parameter names");

  const imageHeader = mapInboxTemplate({ components: [{ format: "IMAGE", type: "HEADER" }, { text: "Hi", type: "BODY" }], language: "en", name: "with_photo" });
  assert.ok(imageHeader!.unsupportedReason, "a media-header template is shown but refused, not sent broken");
  const dynamicUrl = mapInboxTemplate({
    components: [{ text: "Hi", type: "BODY" }, { buttons: [{ text: "Open", type: "URL", url: "https://x.test/{{1}}" }], type: "BUTTONS" }],
    language: "en",
    name: "with_link",
  });
  assert.ok(dynamicUrl!.unsupportedReason);
  // Two unsupported templates in a row: a /g regex's lastIndex must not leak between them.
  const dynamicUrlAgain = mapInboxTemplate({
    components: [{ text: "Hi", type: "BODY" }, { buttons: [{ text: "Open", type: "URL", url: "https://x.test/{{1}}" }], type: "BUTTONS" }],
    language: "en",
    name: "with_link_2",
  });
  assert.ok(dynamicUrlAgain!.unsupportedReason);
  assert.equal(mapInboxTemplate({ components: [], language: "en" }), null, "a template with no name is skipped");
}

function runMediaTests() {
  assert.equal(outboundMediaTypeFor("image/jpeg"), "image");
  assert.equal(outboundMediaTypeFor("image/webp"), "document", "a type WhatsApp will not show as a photo goes as a file");
  assert.equal(outboundMediaTypeFor("video/mp4"), "video");
  assert.equal(outboundMediaTypeFor("audio/ogg"), "audio");
  assert.equal(outboundMediaTypeFor("application/pdf"), "document");
  assert.ok(mediaLimitProblem("image", 6 * 1024 * 1024), "a 6 MB photo is over Meta's 5 MB ceiling");
  assert.equal(mediaLimitProblem("image", 4 * 1024 * 1024), null);
  assert.equal(mediaLimitProblem("document", 20 * 1024 * 1024), null);
  assert.equal(INBOX_UPLOAD_MAX_BYTES, 25 * 1024 * 1024);
}

function runFormatTests() {
  const now = new Date("2026-09-15T20:00:00.000Z"); // 23:00 Cairo
  assert.equal(formatListTime("2026-09-15T09:05:00.000Z", now), "12:05", "today's time is Cairo time");
  // 22:30 UTC on the 14th is 01:30 Cairo on the 15th — still TODAY in Cairo.
  assert.equal(formatListTime("2026-09-14T22:30:00.000Z", now), "01:30");
  assert.equal(formatListTime("2026-09-14T12:00:00.000Z", now), "Yesterday");
  assert.equal(formatListTime(null, now), "");
  assert.equal(isNewCairoDay("2026-09-14T20:59:00.000Z", "2026-09-14T21:01:00.000Z"), true, "midnight Cairo splits the day");
  assert.equal(isNewCairoDay("2026-09-15T09:00:00.000Z", "2026-09-15T10:00:00.000Z"), false);
  assert.equal(formatWindowLeft("2026-09-15T12:30:00.000Z", Date.parse("2026-09-15T09:18:00.000Z")), "3 h 12 min left");
  assert.equal(formatWindowLeft("2026-09-15T09:00:00.000Z", Date.parse("2026-09-15T09:18:00.000Z")), null, "a closed window says nothing is left");
  assert.equal(describeDeliveryStatus("failed"), "Not delivered");
  assert.equal(conversationTitle({ contactName: null, contactPhone: null, contactUsername: "sheena" }), "@sheena");
  assert.equal(conversationTitle({ contactName: " ", contactPhone: "+20 10 0123 4567", contactUsername: null }), "+20 10 0123 4567");
}

function runLineTests() {
  const lines = whatsAppInboxLines();
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0]!.businessAccountId, lines[1]!.businessAccountId, "the two numbers sit in two business accounts, so templates are never shared");
  assert.equal(findWhatsAppInboxLine(HANDSET_ID)?.label, "HR handset");
  assert.equal(whatsAppInboxLineLabel("999", "+20 12 0000 0000"), "WhatsApp +20 12 0000 0000", "an unknown line is shown as a number, never hidden");
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

function runGateTests() {
  const access = (role: string, source = "session") => ({ role, source }) as Parameters<typeof canUseWhatsAppInbox>[0];
  assert.equal(canUseWhatsAppInbox(access("Super Admin")), true);
  for (const role of ["CEO", "HR Advisory", "HR Operations", "Talent Acquisition Specialist", "Employee"]) {
    assert.equal(canUseWhatsAppInbox(access(role)), false, `${role} cannot open the inbox`);
  }
  assert.equal(canUseWhatsAppInbox(access("Super Admin", "guest")), false);

  const http = read("app/api/whatsapp-inbox/_lib/inbox-http.ts");
  assert.match(http, /canUseWhatsAppInbox\(access\)/, "the routes' 403 is the same Super Admin rule");

  const routes = listRouteFiles(path.join(ROOT, "app/api/whatsapp-inbox"));
  assert.equal(routes.length, 9, "every inbox route is checked here");
  const registry = read("src/lib/security/access-registry.ts");
  for (const file of routes) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const method of ["GET", "POST", "PATCH"]) {
      const at = source.indexOf(`export async function ${method}(`);
      if (at < 0) continue;
      const next = source.indexOf("export async function", at + 1);
      const body = source.slice(at, next < 0 ? undefined : next);
      const accessAt = body.indexOf('requireRecruitmentAccess(request, "recruitment", "update")');
      const forbiddenAt = body.indexOf("inboxForbidden(access)");
      assert.ok(accessAt > 0 && forbiddenAt > accessAt, `${relative} ${method}: signed in, then Super Admin only`);
      assert.ok(body.indexOf("if (forbidden) return forbidden;") > forbiddenAt, `${relative} ${method}: the 403 is returned, not ignored`);
      if (method !== "GET") {
        const csrfAt = body.indexOf("assertSameOriginMutation(request)");
        assert.ok(csrfAt > 0 && csrfAt < accessAt, `${relative} ${method}: the origin is checked before anything else`);
      }
    }
    const apiPath = "/" + relative.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "*");
    assert.ok(registry.includes(`pattern: "${apiPath}"`), `${apiPath} is declared in the access registry`);
  }

  const page = read("app/(admin)/recruitment/whatsapp-inbox/page.tsx");
  assert.match(page, /\n {2}if \(access\.role !== "Super Admin"\) redirect\("\/employee-portals"\);/, "the page itself is Super Admin only");
  const nav = read("src/config/system-navigation.ts");
  assert.match(nav, /href: "\/recruitment\/whatsapp-inbox"[^\n]*roles: \["Super Admin"\]/, "the sidebar row is offered to the Super Admin only");
}

function runWiringTests() {
  const webhook = read("app/api/webhooks/whatsapp/route.ts");
  const recordAt = webhook.indexOf("await recordInboxDelivery(payload)");
  const loopAt = webhook.indexOf("for (const message of messages)");
  assert.ok(recordAt > 0 && recordAt < loopAt, "the inbox is recorded before the recruitment pipeline runs");
  assert.match(webhook.slice(recordAt, loopAt), /\.catch\(/, "a failure to record never fails the webhook delivery");

  const cron = read("app/api/cron/inbound-intake/route.ts");
  const cacheAt = cron.indexOf("await cacheInboxMedia()");
  assert.ok(cacheAt > cron.indexOf("withDeadMansSwitch("), "copying attachments runs outside the CV queue's dead man's switch");
  assert.match(cron.slice(cacheAt, cacheAt + 200), /\.catch\(/);

  const interactive = read("src/lib/recruitment/inbound/whatsapp-interactive.ts");
  assert.match(interactive, /await recordInboxOutbound\(/, "every Phoenix send, automated or typed, lands in the inbox");

  const record = read("src/lib/whatsapp-inbox/record.ts");
  for (const name of ["recordInboxDelivery", "applyInboxStatuses", "recordInboxOutbound"]) {
    const at = record.indexOf(`export async function ${name}(`);
    const guardAt = record.indexOf("isTestSuite()", at);
    const writeAt = record.indexOf("getSupabaseAdmin()", at);
    assert.ok(at > 0 && guardAt > at && guardAt < writeAt, `${name} writes nothing from the test suite, which runs on production credentials`);
  }
}

function runMigrationTests() {
  const sql = read("supabase/migrations/20260915200000_whatsapp_inbox.sql");
  assert.match(sql, /alter table public\.whatsapp_inbox_conversations enable row level security/i);
  assert.match(sql, /alter table public\.whatsapp_inbox_messages enable row level security/i);
  assert.match(sql, /revoke all on (table )?public\.whatsapp_inbox_messages[^;]*from[^;]*anon/i, "no browser role can read the chats");
  assert.match(sql, /revoke all on (table )?public\.whatsapp_inbox_conversations[^;]*from[^;]*authenticated/i);
  assert.match(sql, /'whatsapp-inbox-media',\s*'whatsapp-inbox-media',\s*false/i, "the attachment bucket is private");
  assert.match(sql, /wamid text unique/i, "one Meta message is one row");
  assert.match(sql, /unique \(phone_number_id, contact_key\)/i, "one person on one number is one chat");
  assert.match(sql, /on delete set null/i, "deleting a candidate never deletes a chat");
}

export async function runWhatsAppInboxTests() {
  runParserTests();
  runOutboundRowTests();
  runTemplateTests();
  runMediaTests();
  runFormatTests();
  runLineTests();
  runGateTests();
  runWiringTests();
  runMigrationTests();
}
