import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { splitApprovalsLineDelivery } from "../src/lib/approvals/urgent-whatsapp-rules.ts";
import { probeAllWhatsAppNumbers, resolveConfiguredPhoneNumberIds } from "../src/lib/recruitment/inbound/whatsapp-health.ts";
import { sendWhatsAppPayload } from "../src/lib/recruitment/inbound/whatsapp-interactive.ts";
import { parseWhatsAppWebhookDelivery } from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";
import { approvalsLinePhoneNumberId, findWhatsAppInboxLine, hrHandsetInboxLine, isApprovalsLine, whatsAppApprovalsLine, whatsAppInboxLines } from "../src/lib/whatsapp-inbox/lines.ts";
import { parseInboxDelivery } from "../src/lib/whatsapp-inbox/webhook-parse.ts";

const THIRD = "333000333000333";
const RECRUITMENT = "1319071451278873";

function change(phoneNumberId: string, value: Record<string, unknown>) {
  return { field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "201000000000", phone_number_id: phoneNumberId }, ...value } };
}

function textFrom(from: string, id: string, body: string) {
  return { contacts: [{ profile: { name: "Someone" }, wa_id: from }], messages: [{ from, id, text: { body }, timestamp: "1762156800", type: "text" }] };
}

function delivery(...changes: unknown[]) {
  return { entry: [{ changes, id: "2265574670642375" }], object: "whatsapp_business_account" };
}

function testAReplyGoesNowhere() {
  const reply = delivery(change(THIRD, textFrom("201012345678", "wamid.reply", "ok thanks")));

  // The control: left in, the reply really would reach both the bot's parser and the inbox.
  assert.equal(parseWhatsAppWebhookDelivery(reply).messages.length, 1, "unfiltered, the pipeline sees the reply");
  assert.equal(parseInboxDelivery(reply).messages.length, 1, "unfiltered, the inbox files the reply, whatever line it came in on");

  const split = splitApprovalsLineDelivery(reply, THIRD);
  assert.equal(split.droppedChanges, 1);
  assert.equal(split.droppedMessages, 1, "it is logged as dropped");
  assert.equal(parseWhatsAppWebhookDelivery(split.payload).messages.length, 0, "the applicant bot and Talent Acquisition never see it");
  assert.equal(parseInboxDelivery(split.payload).messages.length, 0, "HR Resourcing never sees it");
}

function testAnApplicantInTheSameDeliveryStillGetsThrough() {
  const mixed = delivery(
    change(THIRD, textFrom("201012345678", "wamid.reply", "ok thanks")),
    change(RECRUITMENT, textFrom("201112345678", "wamid.applicant", "here is my CV")),
  );
  const before = JSON.stringify(mixed);
  const split = splitApprovalsLineDelivery(mixed, THIRD);
  assert.deepEqual(parseWhatsAppWebhookDelivery(split.payload).messages.map((message) => message.wamid), ["wamid.applicant"], "split per change, not per delivery");
  assert.deepEqual(parseInboxDelivery(split.payload).messages.map((message) => message.wamid), ["wamid.applicant"]);
  assert.equal(JSON.stringify(mixed), before, "the delivery it was given is not altered");
}

function testUnsetOrUnrelatedChangesNothing() {
  const other = delivery(change(RECRUITMENT, textFrom("201112345678", "wamid.applicant", "hello")));
  assert.equal(splitApprovalsLineDelivery(other, null).payload, other, "with no third number set up, the very same delivery goes on");
  assert.equal(splitApprovalsLineDelivery(other, "  ").payload, other);
  assert.equal(splitApprovalsLineDelivery(other, THIRD).payload, other, "a delivery with nothing on it is untouched");
  for (const strange of [null, "text", 7, [], {}, { entry: "no" }, { entry: [null, { changes: "no" }, { changes: [null, {}] }] }]) {
    assert.doesNotThrow(() => splitApprovalsLineDelivery(strange, THIRD), `a strange body never throws: ${JSON.stringify(strange)}`);
  }
}

function testDeliveryTicksAreCollected() {
  const ticks = delivery(
    change(THIRD, {
      statuses: [
        { id: "wamid.a", status: "delivered" },
        { errors: [{ code: 131026, title: "Message undeliverable" }], id: "wamid.b", status: "failed" },
        { status: "read" },
      ],
    }),
  );
  const split = splitApprovalsLineDelivery(ticks, THIRD);
  assert.deepEqual(split.statuses, [
    { errorCode: null, status: "delivered", wamid: "wamid.a" },
    { errorCode: "131026", status: "failed", wamid: "wamid.b" },
  ]);
  assert.equal(parseInboxDelivery(split.payload).statuses.length, 0, "and they never reach the inbox");
}

function testTheOrderInTheWebhook() {
  const source = stripComments(readFileSync("app/api/webhooks/whatsapp/route.ts", "utf8"));
  const exit = source.indexOf("splitApprovalsLineDelivery(payload");
  assert.ok(exit > 0, "the webhook takes the third number out");
  assert.ok(exit > source.indexOf("JSON.parse(body)"), "after it has a delivery");
  assert.ok(exit < source.indexOf("recordInboxDelivery(payload)"), "before the inbox files anything");
  assert.ok(exit < source.indexOf("parseWhatsAppWebhookDelivery(payload)"), "and before the recruitment pipeline reads anything");
  assert.ok(/payload = approvalsLine\.payload;/u.test(source), "and what they read is the filtered delivery");
  assert.ok(source.includes("applyApprovalsLineStatuses(approvalsLine.statuses)"), "and Meta's delivery ticks reach the reminders' own ledger, so a dead number reads failed");

  const vendor = stripComments(readFileSync("src/lib/needs-you/vendor-accounts.ts", "utf8"));
  assert.ok(vendor.includes("probeAllWhatsAppNumbers([approvalsLinePhoneNumberId()])"), "the vendor read asks about the third number as well");
}

function testTheOutboundSideKeepsItsOwnLedger() {
  const source = stripComments(readFileSync("src/lib/recruitment/inbound/whatsapp-interactive.ts", "utf8"));
  const body = source.slice(source.indexOf("async function postToGraph"), source.indexOf("async function sendToGraph"));
  const guard = body.indexOf("if (isApprovalsLine(phoneNumberId)) return result;");
  assert.ok(guard > 0, "the shared sender knows the third number");
  assert.ok(guard < body.indexOf("recordOutboundMessage("), "before the recruitment outbound report");
  assert.ok(guard < body.indexOf("recordInboxOutbound("), "and before the WhatsApp Inbox");
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testTheThirdNumberIsNeverAnInboxOrIntakeLine() {
  await withEnv(
    { WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: undefined, WHATSAPP_APPROVALS_PHONE_NUMBER_ID: undefined, WHATSAPP_PHONE_NUMBER_ID: RECRUITMENT, WHATSAPP_PHONE_NUMBER_IDS: undefined },
    () => {
      assert.equal(approvalsLinePhoneNumberId(), null, "it has no default");
      assert.equal(whatsAppApprovalsLine(), null);
      assert.equal(isApprovalsLine(RECRUITMENT), false);
      assert.equal(isApprovalsLine(undefined), false, "an absent id is never read as this line while it is unset");
    },
  );
  await withEnv({ WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: undefined, WHATSAPP_APPROVALS_PHONE_NUMBER_ID: THIRD }, () => {
    assert.equal(whatsAppApprovalsLine(), null, "without its business account it cannot send");
    assert.equal(isApprovalsLine(THIRD), true, "but its replies are already dropped");
  });
  await withEnv(
    { WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: "waba-3", WHATSAPP_APPROVALS_PHONE_NUMBER_ID: THIRD, WHATSAPP_PHONE_NUMBER_ID: RECRUITMENT, WHATSAPP_PHONE_NUMBER_IDS: undefined },
    () => {
      assert.deepEqual(whatsAppApprovalsLine(), { businessAccountId: "waba-3", phoneNumberId: THIRD });
      assert.equal(findWhatsAppInboxLine(THIRD), null, "HR Resourcing has no such line");
      assert.ok(!whatsAppInboxLines().some((line) => line.phoneNumberId === THIRD));
      assert.ok(!resolveConfiguredPhoneNumberIds().includes(THIRD), "a fault on it must not read as the recruitment intake being down");
    },
  );

  // 🔴 Set by mistake to a line people write to, the webhook would drop every applicant and still answer 200.
  await withEnv(
    { WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: "waba-3", WHATSAPP_APPROVALS_PHONE_NUMBER_ID: RECRUITMENT, WHATSAPP_PHONE_NUMBER_ID: RECRUITMENT, WHATSAPP_PHONE_NUMBER_IDS: undefined },
    () => {
      assert.equal(approvalsLinePhoneNumberId(), null, "the recruitment number can never be the third number");
      assert.equal(whatsAppApprovalsLine(), null, "so the reminders stay off");
      assert.equal(isApprovalsLine(RECRUITMENT), false, "and its applicants are never dropped");
    },
  );
  await withEnv(
    { WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: "waba-3", WHATSAPP_APPROVALS_PHONE_NUMBER_ID: "777", WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_PHONE_NUMBER_IDS: `${RECRUITMENT}, 777` },
    () => {
      assert.equal(approvalsLinePhoneNumberId(), null, "nor any number on the intake list");
    },
  );
  await withEnv(
    { WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: "waba-3", WHATSAPP_APPROVALS_PHONE_NUMBER_ID: hrHandsetInboxLine().phoneNumberId, WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_PHONE_NUMBER_IDS: undefined },
    () => {
      assert.equal(approvalsLinePhoneNumberId(), null, "nor the HR handset");
    },
  );
}

async function testOnTheWire() {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }], verified_name: "x", display_phone_number: "1", quality_rating: "GREEN", code_verification_status: "VERIFIED" }), { status: 200 });
  }) as typeof fetch;
  try {
    await withEnv(
      { WHATSAPP_ACCESS_TOKEN: "fake-token", WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID: "waba-3", WHATSAPP_APPROVALS_PHONE_NUMBER_ID: THIRD, WHATSAPP_PHONE_NUMBER_ID: RECRUITMENT, WHATSAPP_PHONE_NUMBER_IDS: undefined },
      async () => {
        const sent = await sendWhatsAppPayload({
          event: "approval_whatsapp_reminder",
          message: { template: { name: "x" }, type: "template" },
          phoneNumberId: THIRD,
          toWaId: "201012345678",
        });
        assert.equal(sent.ok, true);
        assert.equal(asked.length, 1, "one call and no audit write beside it");
        assert.ok(asked[0]?.includes(`/${THIRD}/messages`), "it goes out on the third number and not the recruitment line");

        asked.length = 0;
        await probeAllWhatsAppNumbers([THIRD, null, RECRUITMENT]);
        assert.deepEqual(asked.map((url) => url.includes(THIRD)).sort(), [false, true], "the vendor read asks about the third number too, once each");
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function runApprovalWhatsAppReplyExitTests() {
  testAReplyGoesNowhere();
  testAnApplicantInTheSameDeliveryStillGetsThrough();
  testUnsetOrUnrelatedChangesNothing();
  testDeliveryTicksAreCollected();
  testTheOrderInTheWebhook();
  testTheOutboundSideKeepsItsOwnLedger();
  await testTheThirdNumberIsNeverAnInboxOrIntakeLine();
  await testOnTheWire();
}
