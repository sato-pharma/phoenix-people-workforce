import assert from "node:assert/strict";

import { isPermanentTelegramDeliveryError } from "../src/lib/notifications/telegram-delivery-errors.ts";

export function runTelegramDeliveryErrorsTests() {
  // Permanent: the bot can never reach this chat again until the user re-links. These are the
  // exact Telegram Bot API strings (as seen in production after the 2026-07-09 bot swap).
  const permanent = [
    "Bad Request: chat not found",
    "Forbidden: bot was blocked by the user",
    "Forbidden: user is deactivated",
    "Forbidden: bot can't initiate a conversation with a user",
    "Bad Request: PEER_ID_INVALID",
  ];
  for (const message of permanent) {
    assert.equal(isPermanentTelegramDeliveryError(message), true, `expected permanent: ${message}`);
  }

  // Case-insensitive: Telegram casing must not change the classification.
  assert.equal(isPermanentTelegramDeliveryError("BAD REQUEST: CHAT NOT FOUND"), true);

  // Transient / retryable: these must NOT be treated as permanent, or a temporary hiccup would
  // wrongly tear down a healthy connection.
  const transient = [
    "Telegram request timed out.",
    "Too Many Requests: retry after 5",
    "Telegram sendMessage unavailable.",
    "Bad Gateway",
    "Internal Server Error",
    "",
  ];
  for (const message of transient) {
    assert.equal(isPermanentTelegramDeliveryError(message), false, `expected transient: ${message}`);
  }

  // Null/undefined must not throw (defensive: callers pass error.message which can be missing).
  assert.equal(isPermanentTelegramDeliveryError(undefined as unknown as string), false);
  assert.equal(isPermanentTelegramDeliveryError(null as unknown as string), false);
}
