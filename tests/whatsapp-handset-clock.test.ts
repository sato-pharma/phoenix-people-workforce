import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  handsetDaysSinceSend,
  handsetLimitAt,
  handsetReminderMessage,
  handsetReminderPlan,
  handsetReminderStage,
} from "../src/lib/recruitment/inbound/whatsapp-handset-clock.ts";
import { evaluateWebhookRouting } from "../src/lib/recruitment/inbound/whatsapp-health.ts";

const DAY = 24 * 60 * 60 * 1000;

export function runWhatsappHandsetClockTests() {
  assert.equal(handsetReminderStage(0), null);
  assert.equal(handsetReminderStage(6), null, "under seven days nothing is said");
  assert.equal(handsetReminderStage(7), "seven");
  assert.equal(handsetReminderStage(9), "seven", "a missed fire on day 7 is still caught on day 8");
  assert.equal(handsetReminderStage(10), "ten");
  assert.equal(handsetReminderStage(11), "ten");
  assert.equal(handsetReminderStage(12), "twelve");
  assert.equal(handsetReminderStage(13), "thirteen");
  assert.equal(handsetReminderStage(14), "over");
  assert.equal(handsetReminderStage(40), "over");

  const send = "2026-10-20T17:27:00Z";
  assert.equal(handsetDaysSinceSend(send, Date.parse(send) + 14 * DAY - 1), 13, "elapsed time, because the limit is");
  assert.equal(handsetDaysSinceSend(send, Date.parse(send) + 14 * DAY), 14);

  // 20 Oct is on summer time and 3 Nov is not, so the limit lands an hour earlier on the clock.
  assert.equal(handsetLimitAt(send), "2026-11-03T17:27:00.000Z");
  assert.match(handsetReminderMessage("thirteen", 13, send), /3 November at 19:27|3 November, 19:27/);

  // Who hears what.
  assert.deepEqual(handsetReminderPlan("seven", send, "2026-10-27").channels, ["in_app"]);
  assert.deepEqual(handsetReminderPlan("ten", send, "2026-10-30").channels, ["in_app", "telegram", "push"]);
  assert.equal(handsetReminderPlan("twelve", send, "2026-11-01").priority, "high");

  // Once per silence for the first two, once a day for the last three.
  assert.equal(
    handsetReminderPlan("seven", send, "2026-10-27").idempotencyKey,
    handsetReminderPlan("seven", send, "2026-10-28").idempotencyKey,
    "days 7, 8 and 9 are one message",
  );
  assert.notEqual(
    handsetReminderPlan("over", send, "2026-11-04").idempotencyKey,
    handsetReminderPlan("over", send, "2026-11-05").idempotencyKey,
    "past the limit it repeats every day",
  );

  // Honest wording: a send proves an open, and the absence of one proves nothing.
  for (const stage of ["seven", "ten", "twelve", "thirteen", "over"] as const) {
    const message = handsetReminderMessage(stage, 14, send);
    assert.match(message, /No message has been sent from the HR handset/);
    assert.match(message, /Connected platform/, "the card that breaks the link must be named every time");
    assert.doesNotMatch(message, /has not been opened/, "an open with no send cannot be seen from here");
  }

  // The echoes field is read beside routing, and a lost one is not a routing problem: applicants still
  // arrive, and adding it to `problems` would page the intake alarm about something else.
  const fields = (names: string[]) => ({
    active: true,
    callback_url: "https://x.example/api/webhooks/whatsapp",
    fields: names.map((name) => ({ name })),
  });
  const input = { answerable: true, expectedCallbackUrl: "https://x.example/api/webhooks/whatsapp", numberOverrideUrl: null };
  const on = evaluateWebhookRouting({ ...input, subscription: fields(["messages", "smb_message_echoes"]) });
  const off = evaluateWebhookRouting({ ...input, subscription: fields(["messages"]) });
  assert.equal(on.echoesSubscribed, true);
  assert.equal(off.echoesSubscribed, false);
  assert.equal(off.ok, true, "routing stays healthy with echoes off");
  assert.deepEqual(off.problems, []);
  assert.equal(evaluateWebhookRouting({ ...input, answerable: false, subscription: null }).echoesSubscribed, null);

  // Him only, and never by email.
  const runner = readFileSync("src/lib/recruitment/inbound/whatsapp-handset-reminder.ts", "utf8");
  assert.match(runner, /REMINDER_ROLES: readonly PhoenixRole\[\] = \["Super Admin"\]/, "owner, 2026-11-03: Me only");
  assert.doesNotMatch(runner, /"email"/, "no outbound email");
}
