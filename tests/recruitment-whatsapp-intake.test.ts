import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  buildWhatsAppIntakeInput,
  isWhatsAppImportSender,
  parseWhatsAppImportSenders,
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
  assert.deepEqual(documentMsg.document, { caption: null, filename: "cv.pdf", mediaId: "MEDIA123", mimeType: "application/pdf" });
  assert.equal(documentMsg.text, null, "a document message carries no text body");

  // A document caption is captured (shown as part of the candidate's source context).
  const [captionedMsg] = parseWhatsAppWebhookPayload(
    documentMessagePayload({ document: { caption: "My CV", filename: "cv.pdf", id: "MEDIA123", mime_type: "application/pdf" } }),
  );
  assert.equal(captionedMsg.document?.caption, "My CV");

  // Text message (no document attachment at all) — its body is captured for buffering.
  const [textMsg] = parseWhatsAppWebhookPayload(
    documentMessagePayload({ document: undefined, text: { body: "hi there" }, type: "text" }),
  );
  assert.equal(textMsg.messageType, "text");
  assert.equal(textMsg.document, null, "a non-document message never carries a document field, even if one is present in the raw payload");
  assert.equal(textMsg.text, "hi there", "a text message's body is captured");

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

  assert.equal(withAttachment.identitySource, "sender", "a direct applicant's own number is their real contact detail");

  const noNameMessage = { ...documentMsg, contactName: null };
  const fallback = buildWhatsAppIntakeInput(noNameMessage, null);
  assert.equal(
    fallback.candidate.fullName,
    "WhatsApp Applicant (+201001234567)",
    "no self-reported profile name -> a clearly-flagged placeholder, not a silent blank",
  );
  assert.equal(fallback.attachment, null, "a failed/skipped media download flows through as null, not a crash");

  // --- Receiving (business) number capture ----------------------------------------------------
  // With two intake lines on one webhook, the ONLY signal for which line a CV came in on is Meta's
  // value.metadata — the sender/from is the applicant, not the receiving number.
  assert.equal(documentMsg.deliveredToPhoneNumberId, null, "no metadata in the payload -> null, never a crash");
  assert.equal(documentMsg.deliveredToDisplayNumber, null);

  const withMetadataPayload = documentMessagePayload();
  (withMetadataPayload.entry[0].changes[0].value as { metadata?: unknown }).metadata = {
    display_phone_number: "+20 11 59888247",
    phone_number_id: "2000000000000",
  };
  const [deliveredMsg] = parseWhatsAppWebhookPayload(withMetadataPayload);
  assert.equal(deliveredMsg.deliveredToPhoneNumberId, "2000000000000", "the receiving line's phone_number_id is captured");
  assert.equal(deliveredMsg.deliveredToDisplayNumber, "+20 11 59888247");

  const deliveredInput = buildWhatsAppIntakeInput(deliveredMsg, null);
  assert.equal(
    (deliveredInput.rawMetadata as { deliveredToPhoneNumberId?: string }).deliveredToPhoneNumberId,
    "2000000000000",
    "the receiving line is recorded on the intake event so the two lines are distinguishable in the data",
  );
  assert.equal(
    (deliveredInput.rawMetadata as { deliveredToDisplayNumber?: string }).deliveredToDisplayNumber,
    "+20 11 59888247",
  );
  assert.equal(
    (withAttachment.rawMetadata as { deliveredToPhoneNumberId?: string }).deliveredToPhoneNumberId,
    undefined,
    "when Meta omitted metadata the key is left off entirely, not written as null",
  );

  // --- Forwarded flag -------------------------------------------------------------------------
  assert.equal(documentMsg.forwarded, false, "an ordinary message is not marked forwarded");
  const [forwardedMsg] = parseWhatsAppWebhookPayload(
    documentMessagePayload({ context: { forwarded: true } }),
  );
  assert.equal(forwardedMsg.forwarded, true, "Meta's context.forwarded is captured for the audit trail");

  // --- parseWhatsAppImportSenders -------------------------------------------------------------
  assert.deepEqual(parseWhatsAppImportSenders(null), [], "unset env var -> no import senders");
  assert.deepEqual(parseWhatsAppImportSenders("  "), []);
  assert.deepEqual(parseWhatsAppImportSenders("+201001234567, 201119998888 ,"), ["+201001234567", "201119998888"]);

  // --- isWhatsAppImportSender -----------------------------------------------------------------
  assert.equal(isWhatsAppImportSender("201001234567", ["+20 100 123 4567"]), true, "formatting/spacing is ignored");
  assert.equal(
    isWhatsAppImportSender("201001234567", ["01001234567"]),
    true,
    "a number configured in local Egyptian form still matches the international form Meta reports — a silent miss here would merge an entire import onto one profile",
  );
  assert.equal(isWhatsAppImportSender("201001234567", ["201119998888"]), false, "an unrelated number is not an import sender");
  assert.equal(isWhatsAppImportSender("201001234567", []), false, "no configured senders -> nothing is an import");
  assert.equal(isWhatsAppImportSender("201001234567", undefined), false);
  assert.equal(isWhatsAppImportSender("123", ["123"]), false, "too few digits to identify a number -> never matches");

  // --- Bulk import mode ------------------------------------------------------------------------
  // The whole point: 100 CVs forwarded from ONE old handset must not all inherit that handset's
  // number, which is what would collapse them into a single candidate.
  const importOptions = { importSenders: ["201001234567"] };
  const imported = buildWhatsAppIntakeInput(
    { ...documentMsg, contactName: "Omar (old phone)", document: { caption: null, filename: "Ahmed Mahmoud CV.pdf", mediaId: "M1", mimeType: "application/pdf" } },
    { bytes: Buffer.from("fake"), fileName: "Ahmed Mahmoud CV.pdf", mimeType: "application/pdf" },
    importOptions,
  );
  assert.equal(imported.identitySource, "cv", "an import reads identity from the CV, not the forwarding account");
  assert.equal(imported.candidate.phone, null, "the forwarder's number must never become the candidate's phone");
  assert.equal(imported.candidate.email, null);
  assert.equal(
    imported.candidate.fullName,
    "Ahmed Mahmoud CV",
    "the document filename is the name of last resort when the CV itself cannot be read",
  );
  assert.equal(imported.senderIdentifier, "+201001234567", "the forwarding account is still recorded for the audit trail");
  assert.equal((imported.rawMetadata as { bulkImport?: boolean }).bulkImport, true);

  const genericFilename = buildWhatsAppIntakeInput(
    { ...documentMsg, document: { caption: null, filename: "document.pdf", mediaId: "M2", mimeType: "application/pdf" } },
    null,
    importOptions,
  );
  assert.equal(
    genericFilename.candidate.fullName,
    "WhatsApp Import (d.ABC123)",
    "a filename that describes the file rather than the person falls back to a flagged placeholder",
  );

  const datestampFilename = buildWhatsAppIntakeInput(
    { ...documentMsg, document: { caption: null, filename: "20260115.pdf", mediaId: "M3", mimeType: "application/pdf" } },
    null,
    importOptions,
  );
  assert.match(datestampFilename.candidate.fullName, /^WhatsApp Import \(/, "a date-stamped filename is not a person's name");

  // A real applicant messaging in directly is completely unaffected by import mode being on.
  const directDuringImport = buildWhatsAppIntakeInput(
    { ...documentMsg, from: "201119998888" },
    null,
    importOptions,
  );
  assert.equal(directDuringImport.identitySource, "sender");
  assert.equal(directDuringImport.candidate.phone, "+201119998888");
  assert.equal((directDuringImport.rawMetadata as { bulkImport?: boolean }).bulkImport, undefined);
}
