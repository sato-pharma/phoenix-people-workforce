import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  buildWhatsAppIntakeInput,
  parseWhatsAppWebhookPayload,
} from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";
import {
  verifyWhatsAppWebhookHandshake,
  verifyWhatsAppWebhookSignature,
} from "../src/lib/recruitment/inbound/whatsapp-webhook-events.ts";

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function documentMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ profile: { name: "Jane Doe" }, wa_id: "201001234567" }],
              messages: [
                {
                  document: { filename: "cv.pdf", id: "MEDIA123", mime_type: "application/pdf" },
                  from: "201001234567",
                  id: "wamid.ABC123",
                  type: "document",
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function runRecruitmentWhatsAppIntakeTests() {
  // --- verifyWhatsAppWebhookSignature ---------------------------------------------------------
  const secret = "test-app-secret";
  const body = JSON.stringify({ hello: "world" });
  const validHeader = sign(body, secret);

  assert.equal(verifyWhatsAppWebhookSignature({ body, header: validHeader, secret }), true);
  assert.equal(
    verifyWhatsAppWebhookSignature({ body: `${body}tampered`, header: validHeader, secret }),
    false,
    "a tampered body must fail even with an otherwise-valid-looking signature",
  );
  assert.equal(verifyWhatsAppWebhookSignature({ body, header: validHeader, secret: "wrong-secret" }), false);
  assert.equal(verifyWhatsAppWebhookSignature({ body, header: null, secret }), false);
  assert.equal(verifyWhatsAppWebhookSignature({ body, header: "not-prefixed-correctly", secret }), false);
  assert.equal(verifyWhatsAppWebhookSignature({ body, header: "sha256=", secret }), false, "empty signature value is rejected");

  // --- verifyWhatsAppWebhookHandshake ----------------------------------------------------------
  assert.equal(
    verifyWhatsAppWebhookHandshake({ challenge: "echo-me", mode: "subscribe", token: "correct-token", verifyToken: "correct-token" }),
    "echo-me",
  );
  assert.equal(
    verifyWhatsAppWebhookHandshake({ challenge: "echo-me", mode: "unsubscribe", token: "correct-token", verifyToken: "correct-token" }),
    null,
    "wrong hub.mode is rejected",
  );
  assert.equal(
    verifyWhatsAppWebhookHandshake({ challenge: "echo-me", mode: "subscribe", token: "wrong-token", verifyToken: "correct-token" }),
    null,
    "wrong hub.verify_token is rejected",
  );
  assert.equal(
    verifyWhatsAppWebhookHandshake({ challenge: null, mode: "subscribe", token: "correct-token", verifyToken: "correct-token" }),
    null,
    "missing challenge is rejected",
  );

  // --- parseWhatsAppWebhookPayload -------------------------------------------------------------
  assert.deepEqual(parseWhatsAppWebhookPayload(null), [], "null payload -> empty, never throws");
  assert.deepEqual(parseWhatsAppWebhookPayload({}), [], "empty object -> empty");
  assert.deepEqual(parseWhatsAppWebhookPayload("not an object"), []);

  const [documentMsg] = parseWhatsAppWebhookPayload(documentMessagePayload());
  assert.equal(documentMsg.wamid, "wamid.ABC123");
  assert.equal(documentMsg.from, "201001234567");
  assert.equal(documentMsg.contactName, "Jane Doe");
  assert.equal(documentMsg.messageType, "document");
  assert.deepEqual(documentMsg.document, { filename: "cv.pdf", mediaId: "MEDIA123", mimeType: "application/pdf" });

  // Text message (no document attachment at all).
  const [textMsg] = parseWhatsAppWebhookPayload(
    documentMessagePayload({ document: undefined, text: { body: "hi" }, type: "text" }),
  );
  assert.equal(textMsg.messageType, "text");
  assert.equal(textMsg.document, null, "a non-document message never carries a document field, even if one is present in the raw payload");

  // Image message — also never treated as a document (no OCR support).
  const [imageMsg] = parseWhatsAppWebhookPayload(
    documentMessagePayload({ document: undefined, image: { id: "IMG1", mime_type: "image/jpeg" }, type: "image" }),
  );
  assert.equal(imageMsg.document, null);

  // No matching contact profile -> contactName is null, not a crash.
  const noContactPayload = documentMessagePayload();
  (noContactPayload.entry[0].changes[0].value as { contacts?: unknown }).contacts = [];
  const [noContactMsg] = parseWhatsAppWebhookPayload(noContactPayload);
  assert.equal(noContactMsg.contactName, null);

  // Message missing a required field (from) is dropped entirely, not partially included.
  const missingFromPayload = documentMessagePayload({ from: undefined });
  assert.deepEqual(parseWhatsAppWebhookPayload(missingFromPayload), []);

  // --- buildWhatsAppIntakeInput ----------------------------------------------------------------
  const withAttachment = buildWhatsAppIntakeInput(documentMsg, {
    bytes: Buffer.from("fake"),
    fileName: "cv.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(withAttachment.candidate.fullName, "Jane Doe");
  assert.equal(withAttachment.candidate.phone, "+201001234567");
  assert.equal(withAttachment.senderIdentifier, "+201001234567");
  assert.equal(withAttachment.providerMessageId, "wamid.ABC123");
  assert.ok(withAttachment.attachment);

  const noNameMessage = { ...documentMsg, contactName: null };
  const fallback = buildWhatsAppIntakeInput(noNameMessage, null);
  assert.equal(
    fallback.candidate.fullName,
    "WhatsApp Applicant (+201001234567)",
    "no self-reported profile name -> a clearly-flagged placeholder, not a silent blank",
  );
  assert.equal(fallback.attachment, null, "a failed/skipped media download flows through as null, not a crash");
}
