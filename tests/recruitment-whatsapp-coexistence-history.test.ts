import assert from "node:assert/strict";

import {
  buildWhatsAppIntakeInput,
  parseWhatsAppWebhookPayload,
} from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";

// Meta's coexistence backfill. Once the advertised HR handset is linked, Meta replays that phone's
// past conversations under `history` — the same message nodes as a live delivery, but TWO levels
// deeper (history[].threads[].messages[]) and carrying BOTH directions of every conversation.
const HANDSET_DISPLAY = "+20 11 59888247";
const HANDSET_ID = "999888777";
const APPLICANT = "201002223333";

function historyPayload(messages: unknown[]) {
  return {
    entry: [
      {
        changes: [
          {
            field: "history",
            value: {
              contacts: [{ profile: { name: "Mona Adel" }, wa_id: APPLICANT }],
              history: [
                {
                  metadata: { chunk_order: 1, phase: "0", progress: 100 },
                  threads: [{ id: APPLICANT, messages }],
                },
              ],
              messaging_product: "whatsapp",
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  };
}

const applicantCv = {
  document: { filename: "Mona-CV.pdf", id: "HMEDIA1", mime_type: "application/pdf" },
  from: APPLICANT,
  id: "wamid.HIST1",
  type: "document",
};

// The business's own reply, replayed in the same thread. `from` is the receiving number.
const businessReply = {
  document: { filename: "offer.pdf", id: "HMEDIA2", mime_type: "application/pdf" },
  from: "201159888247",
  id: "wamid.OUT1",
  type: "document",
};

export function runWhatsAppCoexistenceHistoryTests() {
  // --- THE REGRESSION --------------------------------------------------------------------------
  // The parser read only `value.messages`. A backfill therefore parsed to nothing, was answered
  // with a 200, and was thrown away — an entire CV backlog lost without one error being recorded.
  const parsed = parseWhatsAppWebhookPayload(historyPayload([applicantCv]));
  assert.equal(parsed.length, 1, "a coexistence history backfill must be ingested, not silently discarded");
  assert.equal(parsed[0].document?.mediaId, "HMEDIA1", "the replayed CV's media is what the worker downloads");
  assert.equal(parsed[0].historical, true, "a replayed message must be marked historical");
  assert.equal(parsed[0].deliveredToPhoneNumberId, HANDSET_ID, "the handset line the CV arrived on is recorded");
  assert.equal(parsed[0].contactName, "Mona Adel", "the sibling contacts[] name still resolves inside a history envelope");

  // --- direction ------------------------------------------------------------------------------
  // A thread replays both sides. Turning the business's own outgoing messages into candidates
  // would file the company as an applicant to itself, once per past conversation. This also pins
  // the format tolerance: Meta reports the line as "+20 11 59888247" and the sender as digits.
  const bothWays = parseWhatsAppWebhookPayload(historyPayload([applicantCv, businessReply]));
  assert.deepEqual(
    bothWays.map((m) => m.wamid),
    ["wamid.HIST1"],
    "the business's own outgoing message is not an applicant, despite the spaced display format",
  );

  // --- live traffic is untouched ---------------------------------------------------------------
  const live = parseWhatsAppWebhookPayload({
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ profile: { name: "Ahmed Samir" }, wa_id: "201004445555" }],
              messages: [
                {
                  document: { filename: "cv.pdf", id: "LIVE1", mime_type: "application/pdf" },
                  from: "201004445555",
                  id: "wamid.LIVE1",
                  type: "document",
                },
              ],
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  });
  assert.equal(live.length, 1);
  assert.equal(live[0].historical, false, "a live message must never be flagged as a replay");

  // --- both envelopes in one change ------------------------------------------------------------
  const mixed = historyPayload([applicantCv]) as unknown as {
    entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }>;
  };
  mixed.entry[0].changes[0].value.messages = [
    { document: { filename: "now.pdf", id: "NOW1", mime_type: "application/pdf" }, from: "201007778888", id: "wamid.NOW1", type: "document" },
  ];
  const mixedParsed = parseWhatsAppWebhookPayload(mixed);
  assert.deepEqual(
    mixedParsed.map((m) => [m.wamid, m.historical]),
    [
      ["wamid.NOW1", false],
      ["wamid.HIST1", true],
    ],
    "a change carrying both envelopes yields both, each correctly labelled",
  );

  // --- malformed shapes degrade, never throw ---------------------------------------------------
  assert.deepEqual(parseWhatsAppWebhookPayload(historyPayload([])), [], "an empty thread is not an error");
  const noThreads = historyPayload([]) as unknown as { entry: Array<{ changes: Array<{ value: { history: unknown } }> }> };
  noThreads.entry[0].changes[0].value.history = [{ metadata: { phase: "0" } }];
  assert.deepEqual(parseWhatsAppWebhookPayload(noThreads), [], "a history chunk with no threads is not an error");

  // --- the flag reaches the intake row ---------------------------------------------------------
  // This is what the health check reads. Without it a backfill resets the silence clock and inflates
  // public reach, proving the channel is open using messages that arrived while it was shut.
  const historicalInput = buildWhatsAppIntakeInput(parsed[0], null);
  assert.equal(
    (historicalInput.rawMetadata as { historyImport?: boolean }).historyImport,
    true,
    "a replayed CV is stamped historyImport so the health check can exclude it",
  );
  const liveInput = buildWhatsAppIntakeInput(live[0], null);
  assert.equal(
    (liveInput.rawMetadata as { historyImport?: boolean }).historyImport,
    undefined,
    "a live CV carries no historyImport key at all",
  );
  assert.equal(historicalInput.identitySource, "sender", "a replayed applicant is still identified by their own number");
  assert.equal(historicalInput.candidate.phone, `+${APPLICANT}`);
}
