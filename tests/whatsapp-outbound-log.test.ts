import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildOutboundLogRow,
  outboundBodyFromPayload,
} from "../src/lib/recruitment/inbound/whatsapp-outbound-log.ts";

// On 2026-08-30 the owner asked "show me the reply that went out" and it could not be answered.
// Phoenix stored the inbound side of WhatsApp twice and the outbound side not at all — the only
// production tables matching '%whatsapp%' were both inbound, and `notification_events` proved a
// reply had been sent (`asked: true`) while holding no copy of it. The answer had to be
// reconstructed from whichever source commit was live at that second.
//
// This pins the record that replaces that reconstruction. Three things can silently regress:
//
//   1. THE ROW IS WRONG — the outcome fields drift out of step with the send result, so a row
//      reads as evidence of something that did not happen. The table has a CHECK for this, but a
//      row rejected by a CHECK is a row that does not exist, and this module never throws — so a
//      bad shape here means SILENT DATA LOSS, not an error. That is why it is asserted twice.
//   2. THE AUDIT IS BYPASSED — `sendToGraph` has four exits and a fifth added later must not
//      escape the log. That is why the send is WRAPPED rather than logged at each `return`.
//   3. A CREDENTIAL LEAKS IN — the payload is stored verbatim. It is safe today because the access
//      token travels in an Authorization header, but a future Graph call that moved a secret into
//      the body would start writing it to a table with no signal at all.

const INTERACTIVE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/whatsapp-interactive.ts", import.meta.url)),
  "utf8",
);

const LOG_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/whatsapp-outbound-log.ts", import.meta.url)),
  "utf8",
);

const TEXT_ONLY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts", import.meta.url)),
  "utf8",
);

const MIGRATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../supabase/migrations/20260830124500_whatsapp_outbound_message_log.sql", import.meta.url)),
  "utf8",
);

const TEXT_PAYLOAD = {
  messaging_product: "whatsapp",
  recipient_type: "individual",
  text: { body: "‏شكراً لتواصلك مع ساتو فارما 🌟", preview_url: false },
  to: "201010896990",
  type: "text",
};

export async function runWhatsAppOutboundLogTests(): Promise<void> {
  // ── 1. A successful send records what the person actually read ─────────────
  const sent = buildOutboundLogRow({
    context: { detail: { enquiry: "asked_about_the_job" }, inboundWamid: "wamid.INBOUND" },
    event: "whatsapp_classify_text_send",
    payload: TEXT_PAYLOAD,
    phoneNumberId: "1234567890",
    result: { ok: true, wamid: "wamid.OUTBOUND" },
    toWaId: "201010896990",
  });

  assert.equal(
    sent.body,
    "‏شكراً لتواصلك مع ساتو فارما 🌟",
    "THE POINT OF THE TABLE: the exact words sent are recorded, not a summary of them",
  );
  assert.equal(sent.to_wa_id, "201010896990", "and who they went to");
  assert.equal(sent.phone_number_id, "1234567890", "and which line they were sent FROM");
  assert.equal(sent.message_type, "text");
  assert.equal(sent.provider_message_id, "wamid.OUTBOUND", "Meta's id, so a row ties to Meta's own record");
  assert.equal(sent.inbound_wamid, "wamid.INBOUND", "and to the message it answered");
  assert.deepEqual(sent.context, { enquiry: "asked_about_the_job" }, "and which reply variant went out");
  assert.equal(sent.ok, true);
  assert.equal(sent.failure_reason, null, "a successful send carries no failure");
  assert.equal(sent.failure_detail, null);

  // ── 2. A failed send is recorded too, and is not mistakable for a success ──
  // A row that says we messaged someone when we did not is worse than no row: it would be read as
  // evidence. The table's CHECK enforces the same pairing, but a CHECK violation here is silent
  // data loss, because this module deliberately swallows its own errors.
  for (const reason of ["window_closed", "failed", "disabled", "invalid_menu"]) {
    const failed = buildOutboundLogRow({
      event: "whatsapp_classify_text_send",
      payload: TEXT_PAYLOAD,
      phoneNumberId: "1234567890",
      result: { detail: "Meta said no", ok: false, reason },
      toWaId: "201010896990",
    });
    assert.equal(failed.ok, false, `${reason}: recorded as not sent`);
    assert.equal(failed.failure_reason, reason, `${reason}: the reason is kept`);
    assert.equal(failed.failure_detail, "Meta said no", `${reason}: and Meta's own words`);
    assert.equal(
      failed.provider_message_id,
      null,
      `${reason}: a message that never sent has no id — a non-null one here would read as delivered`,
    );
    // Every value this builder can emit must satisfy the table's CHECK, or the row is dropped.
    assert.ok(
      MIGRATION_SOURCE.includes(`'${reason}'`),
      `${reason}: the migration's failure_reason CHECK must accept every reason WhatsAppSendResult can return`,
    );
  }

  // The CHECK constraint and this builder must agree in BOTH directions.
  assert.ok(
    /check \(\(ok and failure_reason is null\) or \(not ok and failure_reason is not null\)\)/.test(MIGRATION_SOURCE),
    "the table refuses a half-written row as well — belt and braces, because a dropped row is silent",
  );

  // ── 3. An interactive menu keeps its structure, and invents no body ────────
  // Flattening a list message into a fake paragraph would put words in the record that the reader
  // never saw as one. The content is kept whole in `payload` instead.
  const menu = buildOutboundLogRow({
    event: "whatsapp_classify_menu_send",
    payload: { interactive: { body: { text: "Pick your area" }, type: "list" }, to: "201010896990", type: "interactive" },
    phoneNumberId: "1234567890",
    result: { ok: true, wamid: "wamid.MENU" },
    toWaId: "201010896990",
  });
  assert.equal(menu.body, null, "an interactive message has no plain body to quote");
  assert.equal(menu.message_type, "interactive");
  assert.ok(menu.payload, "but its full structure is kept, so the menu is still recoverable");

  assert.equal(outboundBodyFromPayload(null), null, "a missing payload yields no body");
  assert.equal(outboundBodyFromPayload({}), null, "and neither does one with no text");
  assert.equal(outboundBodyFromPayload({ text: { body: 42 } }), null, "a non-string body is not coerced into one");

  // ── 4. NO CREDENTIAL MAY REACH THIS TABLE ─────────────────────────────────
  // The payload is stored verbatim, which is safe only because the token is a header. Pin that:
  // if a future Graph call moved a secret into the request body, it would be written to a database
  // row with no error and no warning anywhere.
  assert.ok(
    /headers: \{ Authorization: `Bearer \$\{token\}`/.test(INTERACTIVE_SOURCE),
    "the access token travels in a HEADER — the moment it moves into the body, the audit row leaks it",
  );
  assert.ok(
    !/token/i.test(JSON.stringify(sent.payload)),
    "and no stored payload carries anything token-shaped",
  );

  // ── 5. THE AUDIT CANNOT BE BYPASSED ───────────────────────────────────────
  // The wrapper is the whole design. If a later change inlines the send back into postToGraph, a
  // new early return stops being recorded and nothing anywhere reports that.
  assert.ok(
    /async function postToGraph\([\s\S]{0,400}?const result = await sendToGraph\(/.test(INTERACTIVE_SOURCE),
    "postToGraph delegates to sendToGraph and records the outcome — it does not send inline",
  );
  assert.ok(
    /await recordOutboundMessage\(\s*buildOutboundLogRow\(/.test(INTERACTIVE_SOURCE),
    "and it writes the row on EVERY path, because there is only one path out of the wrapper",
  );
  assert.ok(
    !/return \{ ok: true, wamid[\s\S]*?\n\}\n\nasync function sendToGraph/.test(INTERACTIVE_SOURCE),
    "sendToGraph's returns stay inside the wrapper",
  );
  // The audit is awaited. A floated promise is a write that sometimes lands, and an audit trail
  // with silent gaps is worse than none — it invites the false confidence it exists to prevent.
  assert.ok(
    /await recordOutboundMessage/.test(INTERACTIVE_SOURCE),
    "the write is awaited, not floated",
  );

  // ── 6. It never costs a reply ─────────────────────────────────────────────
  // An audit row is worth having; it is not worth an applicant's answer.
  assert.ok(
    /try \{[\s\S]*?catch \(error\) \{[\s\S]*?logWarning/.test(LOG_SOURCE),
    "recordOutboundMessage swallows its own failure — logging must never break a send",
  );
  assert.ok(
    !/throw /.test(LOG_SOURCE),
    "and it throws nothing at all",
  );

  // ── 7. The owner's question is answerable in one lookup ───────────────────
  // "What did the WhatsApp reply on it" needs the outbound row tied to the inbound message.
  assert.ok(
    /inboundWamid: input\.wamid/.test(TEXT_ONLY_SOURCE),
    "the text-only reply records which inbound message it answered",
  );
  assert.ok(
    /ats_whatsapp_outbound_messages_inbound_idx/.test(MIGRATION_SOURCE),
    "and there is an index for that lookup",
  );

  // ── 8. The table is not readable by a browser ─────────────────────────────
  // `public` is the only schema PostgREST exposes and Supabase grants anon SELECT on new tables
  // there by default. This one holds applicants' phone numbers next to what we said to them.
  assert.ok(
    /alter table public\.ats_whatsapp_outbound_messages enable row level security;/.test(MIGRATION_SOURCE),
    "RLS is on",
  );
  assert.ok(
    /revoke all on table public\.ats_whatsapp_outbound_messages from anon, authenticated;/.test(MIGRATION_SOURCE),
    "and anon is revoked explicitly, not left to the default",
  );
}
