import assert from "node:assert/strict";

import { parseRecruitmentEmailInboxesConfig } from "../src/lib/recruitment/inbound/email-mailboxes-config.ts";
import { parseInboundEmailMessage } from "../src/lib/recruitment/inbound/email-message-parser.ts";

function fakeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    checksum: "",
    content: Buffer.from("fake-bytes"),
    contentDisposition: "attachment",
    contentType: "application/pdf",
    filename: "cv.pdf",
    headerLines: [],
    headers: new Map(),
    related: false,
    size: 10,
    type: "attachment" as const,
    ...overrides,
  };
}

function fakeMail(overrides: Record<string, unknown> = {}) {
  return {
    attachments: [],
    headerLines: [],
    headers: new Map(),
    html: false as const,
    ...overrides,
  };
}

export function runRecruitmentEmailIntakeTests() {
  // --- parseRecruitmentEmailInboxesConfig ----------------------------------------------------
  assert.deepEqual(parseRecruitmentEmailInboxesConfig(undefined), [], "unset env var -> no mailboxes, not a crash");
  assert.deepEqual(parseRecruitmentEmailInboxesConfig(""), []);
  assert.deepEqual(parseRecruitmentEmailInboxesConfig("not json"), [], "malformed JSON -> empty, never throws");
  assert.deepEqual(parseRecruitmentEmailInboxesConfig("{}"), [], "a JSON object (not array) -> empty");

  const valid = JSON.stringify([
    { label: "careers", host: "imap.example.com", port: 993, secure: true, user: "careers@satopharma.com", password: "p1" },
    { label: "hr", host: "imap.example.com", user: "hr@satopharma.com", password: "p2" }, // port/secure omitted -> defaults
    { label: "", host: "imap.example.com", user: "x@satopharma.com", password: "p3" }, // missing label -> dropped
    { label: "no-password", host: "imap.example.com", user: "y@satopharma.com" }, // missing password -> dropped
  ]);
  const parsed = parseRecruitmentEmailInboxesConfig(valid);
  assert.equal(parsed.length, 2, "invalid entries are dropped individually, not the whole array");
  assert.deepEqual(parsed[0], {
    host: "imap.example.com",
    label: "careers",
    password: "p1",
    port: 993,
    secure: true,
    user: "careers@satopharma.com",
  });
  assert.equal(parsed[1].port, 993, "port defaults to 993 when omitted");
  assert.equal(parsed[1].secure, true, "secure defaults to true when omitted");

  // --- parseInboundEmailMessage ---------------------------------------------------------------
  const withNameAndCv = fakeMail({
    attachments: [fakeAttachment()],
    from: { html: "", text: "", value: [{ address: "Jane.Doe@example.com", name: "Jane Doe" }] },
    messageId: "<abc123@mail.example.com>",
    subject: "My application",
    text: "Hello, please find my CV attached.",
  });
  const result1 = parseInboundEmailMessage(withNameAndCv as never, { mailboxLabel: "careers", uid: 42 });
  assert.equal(result1.candidate.fullName, "Jane Doe");
  assert.equal(result1.candidate.email, "jane.doe@example.com", "email is lowercased");
  assert.equal(result1.senderIdentifier, "jane.doe@example.com");
  assert.equal(result1.subject, "My application");
  assert.equal(result1.providerMessageId, "<abc123@mail.example.com>");
  assert.equal(result1.providerUid, "42");
  assert.ok(result1.attachment);
  assert.equal(result1.attachment?.fileName, "cv.pdf");
  assert.equal(result1.candidate.notes, "Hello, please find my CV attached.");

  // No display name -> title-cased local-part fallback.
  const noDisplayName = fakeMail({
    attachments: [fakeAttachment()],
    from: { html: "", text: "", value: [{ address: "john_smith-doe@example.com", name: "" }] },
  });
  const result2 = parseInboundEmailMessage(noDisplayName as never, { mailboxLabel: "hr", uid: 7 });
  assert.equal(result2.candidate.fullName, "John Smith Doe");

  // No From header at all -> defensive "Unknown Applicant", no crash.
  const noFrom = fakeMail({ attachments: [fakeAttachment()] });
  const result3 = parseInboundEmailMessage(noFrom as never, { mailboxLabel: "hr", uid: 8 });
  assert.equal(result3.candidate.fullName, "Unknown Applicant");
  assert.equal(result3.candidate.email, null);
  assert.equal(result3.senderIdentifier, "Unknown Applicant", "falls back to fullName when there is no email at all");

  // No usable attachment -> attachment: null (a plain-text-only message).
  const noAttachment = fakeMail({ attachments: [] });
  const result4 = parseInboundEmailMessage(noAttachment as never, { mailboxLabel: "careers", uid: 9 });
  assert.equal(result4.attachment, null);

  // Unsupported-only attachment (e.g. a signature image) -> still null, not "unsupported".
  const onlyImage = fakeMail({ attachments: [fakeAttachment({ contentType: "image/png", filename: "logo.png" })] });
  const result5 = parseInboundEmailMessage(onlyImage as never, { mailboxLabel: "careers", uid: 10 });
  assert.equal(result5.attachment, null);

  // Multiple attachments -> first pdf/docx wins, others counted in rawMetadata, not fanned out.
  const multi = fakeMail({
    attachments: [
      fakeAttachment({ contentType: "image/png", filename: "logo.png" }),
      fakeAttachment({ contentType: "application/pdf", filename: "cv-1.pdf" }),
      fakeAttachment({
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "cv-2.docx",
      }),
    ],
  });
  const result6 = parseInboundEmailMessage(multi as never, { mailboxLabel: "careers", uid: 11 });
  assert.equal(result6.attachment?.fileName, "cv-1.pdf", "the first pdf/docx attachment wins, images don't count");
  assert.equal(result6.rawMetadata?.ignoredAttachmentCount, 1, "the second qualifying attachment is logged, not processed");

  // Missing Message-ID -> a stable fallback id derived from mailbox + uid (never a crash, and
  // still usable as the (channel, provider_message_id) idempotency key).
  const noMessageId = fakeMail({ attachments: [fakeAttachment()] });
  const result7 = parseInboundEmailMessage(noMessageId as never, { mailboxLabel: "hr", uid: 99 });
  assert.equal(result7.providerMessageId, "email:hr:uid:99");

  // Body text over 500 chars is truncated (context for TA, never a full unbounded body dump).
  const longBody = fakeMail({ attachments: [fakeAttachment()], text: "x".repeat(1000) });
  const result8 = parseInboundEmailMessage(longBody as never, { mailboxLabel: "careers", uid: 12 });
  assert.equal(result8.candidate.notes?.length, 500);
}
