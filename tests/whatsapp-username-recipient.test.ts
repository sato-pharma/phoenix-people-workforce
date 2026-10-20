import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { addressedForGraph, isBusinessScopedUserId } from "../src/lib/recruitment/inbound/whatsapp-recipient.ts";

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

// A WhatsApp username sender is keyed on their user id; Meta addresses that through `recipient`, never `to`.
export async function runWhatsAppUsernameRecipientTests(): Promise<void> {
  assert.equal(isBusinessScopedUserId("EG.1773524767077450"), true);
  assert.equal(isBusinessScopedUserId("201126434978"), false);
  assert.equal(isBusinessScopedUserId(""), false);
  assert.equal(isBusinessScopedUserId(null), false);

  const bsuid = addressedForGraph({ messaging_product: "whatsapp", to: "EG.1773524767077450", type: "text" });
  assert.equal(bsuid.recipient, "EG.1773524767077450");
  assert.equal("to" in bsuid, false);

  const phone = addressedForGraph({ messaging_product: "whatsapp", to: "201221350653", type: "text" });
  assert.equal(phone.to, "201221350653");
  assert.equal("recipient" in phone, false);

  // The wire copy is the one that moves; the send goes through the helper.
  const send = read("../src/lib/recruitment/inbound/whatsapp-interactive.ts");
  assert.ok(send.includes("JSON.stringify(addressedForGraph(payload))"), "the Graph send addresses a username through recipient");

  // The webhook opens the questions for a username sender's CV and routes their taps by the user id.
  const route = read("../app/api/webhooks/whatsapp/route.ts");
  assert.ok(route.includes("waId: message.userId"), "a username sender's conversation is keyed on the user id");
  assert.ok(route.includes("const conversationKey = message.from ?? message.userId"), "a username sender's tap reaches the classify handlers");
}
