import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  classifyTelegramInbound,
  classifyTelegramLinkError,
  isPermanentTelegramLinkOutcome,
  telegramLinkReply,
  telegramWebhookLogLabels,
  type TelegramLinkOutcome,
} from "../src/lib/notifications/telegram-webhook-outcome.ts";

function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The webhook now answers the person in the chat and writes one line per update. Before 2026-10-04 a
 * START press changed nothing anyone could see: fifteen connections sat "pending" with no used token,
 * the last completed link was 9 Aug, and the server could not say whether START ever arrived.
 */
export function runTelegramWebhookOutcomeTests() {
  // ── What an inbound message amounts to ────────────────────────────────────────
  assert.equal(classifyTelegramInbound("/start abc_DEF-123"), "start_with_token");
  assert.equal(classifyTelegramInbound("  /start@Some_bot abc123 "), "start_with_token");
  assert.equal(classifyTelegramInbound("/start"), "bare_start");
  assert.equal(classifyTelegramInbound("/start@Some_bot"), "bare_start");
  assert.equal(classifyTelegramInbound("hello"), "other");
  assert.equal(classifyTelegramInbound(null), "other");
  assert.equal(classifyTelegramInbound(undefined), "other");
  assert.equal(classifyTelegramInbound("/start two words"), "other", "a payload with a space is not a token");

  // ── How a refusal is told apart ───────────────────────────────────────────────
  assert.equal(classifyTelegramLinkError(new Error("Telegram connection token is invalid.")), "token_invalid");
  assert.equal(classifyTelegramLinkError(new Error("Telegram connection token is required.")), "token_invalid");
  assert.equal(classifyTelegramLinkError(new Error("Telegram connection token was already used.")), "token_used");
  assert.equal(classifyTelegramLinkError(new Error("Telegram connection token expired.")), "token_expired");
  assert.equal(classifyTelegramLinkError("TELEGRAM CONNECTION TOKEN EXPIRED."), "token_expired", "case never matters");
  assert.equal(classifyTelegramLinkError(new Error("connection terminated unexpectedly")), "failed", "a database failure is transient");
  assert.equal(classifyTelegramLinkError({ message: "boom" }), "failed");

  // Permanent outcomes ack Telegram (it must stop retrying); only a transient failure is retried.
  for (const outcome of ["token_invalid", "token_used", "token_expired"] as const) {
    assert.equal(isPermanentTelegramLinkOutcome(outcome), true, `${outcome} never succeeds on retry`);
  }
  assert.equal(isPermanentTelegramLinkOutcome("failed"), false, "a transient failure must be retried by Telegram");
  assert.equal(isPermanentTelegramLinkOutcome("linked"), false);

  // ── What the person is told ───────────────────────────────────────────────────
  const linked = telegramLinkReply("linked");
  assert.ok(linked, "a successful connect is confirmed in the chat");
  assert.match(linked.title, /Telegram connected/);
  assert.match(linked.message, /Notification Settings/, "it says where to turn the messages off");

  for (const outcome of ["token_expired", "token_used", "token_invalid"] as const satisfies readonly TelegramLinkOutcome[]) {
    const reply = telegramLinkReply(outcome);
    assert.ok(reply, `${outcome} is explained in the chat, not met with silence`);
    assert.match(reply.message, /Connect Telegram/, `${outcome} names the button that fixes it`);
  }
  assert.equal(telegramLinkReply("failed"), null, "a transient failure says nothing: Telegram retries it and the person would read a false refusal");

  // Nothing built for the chat or the log may carry a credential, an id or a handle.
  const all = (["linked", "token_expired", "token_used", "token_invalid"] as const)
    .map((o) => JSON.stringify(telegramLinkReply(o)))
    .join(" ");
  assert.doesNotMatch(all, /\/start|t\.me|token=|chat_id/i);
  assert.deepEqual(Object.keys(telegramWebhookLogLabels("start_with_token", "linked")).sort(), ["event", "kind", "outcome"]);
  assert.equal(telegramWebhookLogLabels("other", "ignored").event, "telegram_webhook_update", "the one event name a log search keys on");

  // ── The route is wired to all of it ───────────────────────────────────────────
  const route = stripComments(readFileSync(new URL("../app/api/integrations/telegram/webhook/route.ts", import.meta.url), "utf8"));
  assert.match(route, /telegramLinkReply\("linked"\)/, "success is confirmed in the chat");
  assert.match(route, /telegramLinkReply\(outcome\)/, "a permanent refusal is explained in the chat");
  assert.match(route, /logInfo\("Telegram connect link used\."/, "a successful connect is logged");
  assert.match(route, /logInfo\("Telegram webhook update ignored\."/, "an update that was not a connect is logged — it is how 'did START arrive' gets an answer");
  assert.match(route, /logError\("Telegram webhook failed\."/, "a transient failure is logged as an error");
  assert.match(route, /\.catch\(\(\) => \{\}\)/, "a reply failure must never turn into a webhook error");
  assert.match(route, /return NextResponse\.json\(\{ error: "telegram_webhook_failed", message \}, \{ status: 400 \}\)/, "a transient failure still answers 400 so Telegram retries");
  assert.match(route, /isPermanentTelegramLinkOutcome\(outcome\)/);
  // The log and the reply helpers never receive the token, the chat id or the username.
  const logCalls = route.match(/log(?:Info|Error)\([^;]*;/g) ?? [];
  assert.ok(logCalls.length >= 4, "all four log calls found");
  for (const call of logCalls) {
    assert.doesNotMatch(call, /\btoken\b|chatId|incomingChatId|username/, `a log call must not name a credential or a person: ${call}`);
  }
}
