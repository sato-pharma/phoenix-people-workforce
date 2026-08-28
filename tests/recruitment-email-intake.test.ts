import assert from "node:assert/strict";

import { scoreCvExtraction } from "../src/lib/recruitment/cv-extraction-quality.ts";
import { parseRecruitmentEmailInboxesConfig } from "../src/lib/recruitment/inbound/email-mailboxes-config.ts";
import {
  heldBackReason,
  parseInboxCvGate,
  resolveInboxCvGate,
  strictGateHoldsBack,
} from "../src/lib/recruitment/inbound/inbox-cv-gate.ts";
import {
  isEmailImportSender,
  parseEmailImportSenders,
  parseInboundEmailMessage,
  parseInboundEmailMessages,
} from "../src/lib/recruitment/inbound/email-message-parser.ts";
import {
  junkCursorLabel,
  pickJunkFolder,
  planFolderPoll,
  summarizePollFailures,
  type MailboxPollSummary,
} from "../src/lib/recruitment/inbound/email-poll-planner.ts";

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
    cvGate: "permissive",
    host: "imap.example.com",
    label: "careers",
    password: "p1",
    port: 993,
    secure: true,
    user: "careers@satopharma.com",
  });
  assert.equal(parsed[1].port, 993, "port defaults to 993 when omitted");
  assert.equal(parsed[1].secure, true, "secure defaults to true when omitted");

  // The gate each mailbox runs under is derived from its label with no config change required —
  // which is the only reason it takes effect at all, since the live env var names no gate.
  assert.equal(parsed[0].cvGate, "permissive", "careers@ is the published applications address");
  assert.equal(parsed[1].cvGate, "strict", "hr@ is a general mailbox and gets the stricter check");

  const overridden = parseRecruitmentEmailInboxesConfig(
    JSON.stringify([
      { label: "hr", host: "imap.example.com", user: "hr@satopharma.com", password: "p", cvGate: "permissive" },
      { label: "careers", host: "imap.example.com", user: "c@satopharma.com", password: "p", cvGate: "strict" },
      { label: "jobs", host: "imap.example.com", user: "j@satopharma.com", password: "p", cvGate: "nonsense" },
    ]),
  );
  assert.equal(overridden[0].cvGate, "permissive", "an explicit cvGate overrides the label default");
  assert.equal(overridden[1].cvGate, "strict", "the override works in both directions");
  assert.equal(overridden[2].cvGate, "strict", "an unusable cvGate value falls back to the label default");

  // --- the per-inbox CV gate -------------------------------------------------------------------
  //
  // Measured over every candidate the two live inboxes have ever produced (production,
  // 2026-08-15): on careers@ all 6 thin reads are real applicants whose CV failed to read; on hr@
  // all 20 are not CVs at all — an insurance circular, the same internal attendance certificate
  // seven times, a maternity-leave request, our own job offers, and a training vendor's pitch.
  assert.equal(resolveInboxCvGate("careers"), "permissive");
  assert.equal(resolveInboxCvGate("CAREERS"), "permissive", "the label match is case-insensitive");
  assert.equal(resolveInboxCvGate("hr"), "strict");
  assert.equal(resolveInboxCvGate(null), "permissive", "WhatsApp has no mailbox and is an application channel");
  assert.equal(resolveInboxCvGate("info"), "strict", "a mailbox added later is strict by default, not permissive");
  assert.equal(resolveInboxCvGate("hr", "permissive"), "permissive", "an explicit setting always wins");
  assert.equal(parseInboxCvGate("strict"), "strict");
  assert.equal(parseInboxCvGate("Strict"), null, "only the exact values count — no silent coercion");
  assert.equal(parseInboxCvGate(true), null);

  const field = (value: string) => ({ confidence: "high" as const, value });
  const realCvScore = scoreCvExtraction({
    degree: field("Pharmacy"),
    fullName: field("Mona Adel"),
    phone: field("+201000000000"),
    university: field("Cairo University"),
  });
  // The shape of the insurance circular and the attendance certificate: something that reads as a
  // name on the letterhead, and nothing else a CV would carry.
  const notACvScore = scoreCvExtraction({ fullName: field("Mostafa Hisham Zaki") });
  const namelessScore = scoreCvExtraction({ professionalSummary: field("Benefits summary 2025/2026") });

  assert.equal(strictGateHoldsBack("strict", notACvScore), true, "hr@ holds back a file that does not read like a CV");
  assert.equal(strictGateHoldsBack("strict", namelessScore), true, "no name at all is held back too");
  assert.equal(strictGateHoldsBack("strict", realCvScore), false, "a real CV still gets through on hr@");
  assert.equal(
    strictGateHoldsBack("permissive", notACvScore),
    false,
    "careers@ keeps today's behaviour — a thin read there means WE failed to read a real CV",
  );

  const reason = heldBackReason("hr", notACvScore, (key) => (key === "workHistory" ? "Work history" : key));
  assert.match(reason, /hr inbox/, "the reason names the inbox that held it back");
  assert.match(reason, /1 of 9 core details/, "the reason says how much of a CV was actually found");
  assert.match(reason, /work history/, "missing fields are named by their human label, never the raw key");

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
  assert.equal(result1.identitySource, "sender", "a direct applicant's own email is their real contact detail");

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

  // An inline/embedded image (mailparser's related: true — e.g. an email signature logo
  // referenced via cid: in the HTML body) is excluded even though images are now a supported
  // CV kind — it's structurally an embedded asset, not a standalone attachment.
  const onlyInlineImage = fakeMail({
    attachments: [fakeAttachment({ contentType: "image/png", filename: "logo.png", related: true })],
  });
  const result5 = parseInboundEmailMessage(onlyInlineImage as never, { mailboxLabel: "careers", uid: 10 });
  assert.equal(result5.attachment, null);

  // A genuine (non-inline) photographed/scanned CV image IS now picked up as a usable
  // attachment — read via OpenAI vision downstream, not local text extraction.
  const photographedCv = fakeMail({
    attachments: [fakeAttachment({ contentType: "image/jpeg", filename: "cv-photo.jpg", related: false })],
  });
  const result5b = parseInboundEmailMessage(photographedCv as never, { mailboxLabel: "careers", uid: 10 });
  assert.equal(result5b.attachment?.fileName, "cv-photo.jpg");

  // Multiple attachments -> first pdf/docx/image wins, an inline logo never counts, others
  // counted in rawMetadata, not fanned out.
  const multi = fakeMail({
    attachments: [
      fakeAttachment({ contentType: "image/png", filename: "logo.png", related: true }),
      fakeAttachment({ contentType: "application/pdf", filename: "cv-1.pdf" }),
      fakeAttachment({
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "cv-2.docx",
      }),
    ],
  });
  const result6 = parseInboundEmailMessage(multi as never, { mailboxLabel: "careers", uid: 11 });
  assert.equal(result6.attachment?.fileName, "cv-1.pdf", "the first pdf/docx/image attachment wins, an inline logo never counts");
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

  // --- parseEmailImportSenders / isEmailImportSender ------------------------------------------
  assert.deepEqual(parseEmailImportSenders(null), [], "unset env var -> no import senders");
  assert.deepEqual(parseEmailImportSenders("old-careers@example.com, Old-HR@Example.com ,"), [
    "old-careers@example.com",
    "Old-HR@Example.com",
  ]);

  assert.equal(isEmailImportSender("old-careers@example.com", ["old-careers@example.com"]), true);
  assert.equal(
    isEmailImportSender("OLD-CAREERS@EXAMPLE.COM", ["old-careers@example.com"]),
    true,
    "email addresses are matched case-insensitively",
  );
  assert.equal(isEmailImportSender("someone-else@example.com", ["old-careers@example.com"]), false);
  assert.equal(isEmailImportSender(null, ["old-careers@example.com"]), false, "no From address -> never an import sender");
  assert.equal(isEmailImportSender("old-careers@example.com", []), false, "no configured senders -> nothing is an import");
  assert.equal(isEmailImportSender("old-careers@example.com", undefined), false);

  // A "@domain" entry matches every address on that domain. Configured with one plain address, this
  // check matched 0 of 634 production messages while 47 staff addresses forwarded CVs past it, so a
  // per-person roster is the failure mode, not the fix.
  assert.equal(
    isEmailImportSender("someone.new@satopharma.com", ["@satopharma.com"]),
    true,
    "a @domain entry matches a colleague who was never listed by name",
  );
  assert.equal(
    isEmailImportSender("HEAD.OFFICE@SatoPharma.com", ["@satopharma.com"]),
    true,
    "a @domain entry is matched case-insensitively",
  );
  assert.equal(
    isEmailImportSender("applicant@gmail.com", ["@satopharma.com"]),
    false,
    "a real applicant on another domain is still read as the applicant",
  );
  assert.equal(
    isEmailImportSender("someone@notsatopharma.com", ["@satopharma.com"]),
    false,
    "a @domain entry matches the whole domain, never a suffix of a longer one",
  );
  assert.equal(
    isEmailImportSender("@satopharma.com", ["@satopharma.com"]),
    false,
    "a bare domain with no local part is not a sender",
  );
  assert.equal(
    isEmailImportSender("someone@satopharma.com", ["careers@satopharma.com"]),
    false,
    "a plain address entry still matches that address alone",
  );

  // --- Bulk import mode ------------------------------------------------------------------------
  // The point: forwarding 100 emails from ONE old mailbox must not all inherit that mailbox's
  // From address, which is what would collapse them into a single candidate.
  const importOptions = { importSenders: ["old-careers@satopharma.com"] };
  const importedMail = fakeMail({
    attachments: [fakeAttachment({ filename: "Ahmed Mahmoud CV.pdf" })],
    from: { html: "", text: "", value: [{ address: "old-careers@satopharma.com", name: "Omar (old mailbox)" }] },
    messageId: "<fwd123@mail.example.com>",
    text: "---------- Forwarded message ---------",
  });
  const imported = parseInboundEmailMessage(importedMail as never, { mailboxLabel: "careers", uid: 50 }, importOptions);
  assert.equal(imported.identitySource, "cv", "an import reads identity from the CV, not the forwarding mailbox");
  assert.equal(imported.candidate.email, null, "the forwarder's address must never become the candidate's email");
  assert.equal(imported.candidate.phone, null);
  assert.equal(imported.candidate.notes, null, "the forwarder's own quoted-forward body is not the candidate's notes");
  assert.equal(
    imported.candidate.fullName,
    "Ahmed Mahmoud CV",
    "the attachment filename is the name of last resort when the CV itself cannot be read",
  );
  assert.equal(imported.senderIdentifier, "old-careers@satopharma.com", "the forwarding address is still recorded for the audit trail");
  assert.equal((imported.rawMetadata as { bulkImport?: boolean }).bulkImport, true);

  const genericFilenameMail = fakeMail({
    attachments: [fakeAttachment({ filename: "Attachment.pdf" })],
    from: { html: "", text: "", value: [{ address: "old-careers@satopharma.com", name: null }] },
    messageId: "<fwd456789abc@mail.example.com>",
  });
  const genericFilename = parseInboundEmailMessage(genericFilenameMail as never, { mailboxLabel: "careers", uid: 51 }, importOptions);
  assert.match(
    genericFilename.candidate.fullName,
    /^Email Import \(/,
    "a filename that describes the file rather than the person falls back to a flagged placeholder",
  );

  // A real applicant emailing in directly is completely unaffected by import mode being on.
  const directDuringImport = parseInboundEmailMessage(withNameAndCv as never, { mailboxLabel: "careers", uid: 52 }, importOptions);
  assert.equal(directDuringImport.identitySource, "sender");
  assert.equal(directDuringImport.candidate.email, "jane.doe@example.com");
  assert.equal((directDuringImport.rawMetadata as { bulkImport?: boolean }).bulkImport, undefined);

  // --- parseInboundEmailMessages (multi-CV fan-out) -------------------------------------------
  // An agency/referral email with several CVs must become several candidates, not lose all but the
  // first. Each attachment gets its own idempotency key so they dedupe independently.
  const twoCvMail = fakeMail({
    attachments: [
      fakeAttachment({ contentType: "image/png", filename: "logo.png", related: true }), // inline logo — never a CV
      fakeAttachment({ filename: "cv-1.pdf" }),
      fakeAttachment({
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "cv-2.docx",
      }),
    ],
    from: { html: "", text: "", value: [{ address: "agency@example.com", name: "Agency" }] },
    messageId: "<multi@mail.example.com>",
  });
  const fannedOut = parseInboundEmailMessages(twoCvMail as never, { mailboxLabel: "careers", uid: 60 });
  assert.equal(fannedOut.length, 2, "two usable CVs -> two intake inputs; the inline logo is excluded");
  assert.equal(fannedOut[0].providerMessageId, "<multi@mail.example.com>", "the first CV keeps the bare Message-ID");
  assert.equal(fannedOut[1].providerMessageId, "<multi@mail.example.com>#1", "further CVs are suffixed so they dedupe independently");
  assert.equal(fannedOut[0].attachment?.fileName, "cv-1.pdf");
  assert.equal(fannedOut[1].attachment?.fileName, "cv-2.docx");
  assert.equal(fannedOut[0].candidate.email, "agency@example.com", "a direct sender's identity is shared across their attachments");
  assert.equal((fannedOut[1].rawMetadata as { attachmentIndex?: number }).attachmentIndex, 1);

  // A mail with no usable attachment still yields exactly one input (attachment: null) so the
  // ignored event is logged, same as the single path.
  const noCvFanned = parseInboundEmailMessages(fakeMail({ attachments: [] }) as never, { mailboxLabel: "hr", uid: 61 });
  assert.equal(noCvFanned.length, 1);
  assert.equal(noCvFanned[0].attachment, null);

  // A bulk forward-import carrying several CVs reads each one's identity from ITS OWN CV, so the
  // two forwarded CVs become two distinct candidates instead of collapsing onto the forwarder.
  const importedMulti = parseInboundEmailMessages(
    fakeMail({
      attachments: [fakeAttachment({ filename: "Ahmed Mahmoud CV.pdf" }), fakeAttachment({ filename: "Sara Ali CV.pdf" })],
      from: { html: "", text: "", value: [{ address: "old-careers@satopharma.com", name: "Old Mailbox" }] },
      messageId: "<fwd-multi@mail.example.com>",
    }) as never,
    { mailboxLabel: "careers", uid: 62 },
    { importSenders: ["old-careers@satopharma.com"] },
  );
  assert.equal(importedMulti.length, 2);
  assert.equal(importedMulti[0].identitySource, "cv");
  assert.equal(importedMulti[0].candidate.fullName, "Ahmed Mahmoud CV");
  assert.equal(importedMulti[1].candidate.fullName, "Sara Ali CV", "each forwarded CV is named from its own file, not merged");
  assert.equal(importedMulti[0].candidate.email, null, "the forwarder's address never becomes a candidate's email");

  // --- pickJunkFolder --------------------------------------------------------------------------
  // Applicant mail (unknown sender + attachment) is exactly what spam filters act on, so an
  // INBOX-only poll silently loses real candidates. Finding the junk folder is step one.
  assert.equal(
    pickJunkFolder([
      { name: "INBOX", path: "INBOX" },
      { name: "Bulk Mail", path: "Bulk Mail", specialUse: "\\Junk" },
    ]),
    "Bulk Mail",
    "SPECIAL-USE \\Junk is the reliable signal and wins",
  );
  assert.equal(
    pickJunkFolder([
      { name: "INBOX", path: "INBOX" },
      { name: "Bulk Mail", path: "Bulk Mail" },
    ]),
    "Bulk Mail",
    "Yahoo's 'Bulk Mail' is matched by name when SPECIAL-USE is not advertised",
  );
  assert.equal(pickJunkFolder([{ name: "Spam", path: "[Gmail]/Spam" }]), "[Gmail]/Spam", "name matching uses name, path is returned");
  assert.equal(pickJunkFolder([{ name: "Junk Email", path: "Junk Email" }]), "Junk Email");
  assert.equal(
    pickJunkFolder([
      { name: "INBOX", path: "INBOX" },
      { name: "Bulk Offers From Suppliers", path: "Bulk Offers From Suppliers" },
    ]),
    null,
    "a user folder that merely starts with 'Bulk' is not the spam folder",
  );
  assert.equal(pickJunkFolder([{ name: "INBOX", path: "INBOX" }]), null, "no junk folder -> INBOX only, not a crash");

  assert.equal(junkCursorLabel("hr"), "hr:junk", "junk keeps its own cursor row so INBOX's is untouched");

  // --- planFolderPoll --------------------------------------------------------------------------
  // A first-ever poll must NOT walk the whole folder. When the backfill window turns up nothing,
  // the cursor still has to jump to the end, or the next run would look like a first run forever
  // and eventually re-ingest the entire mailbox.
  const firstRunEmpty = planFolderPoll({
    candidateUids: [],
    isFirstRun: true,
    lastProcessedUid: 0,
    maxMessages: 40,
    uidNext: 20910,
  });
  assert.deepEqual(firstRunEmpty.uids, []);
  assert.equal(firstRunEmpty.baselineUid, 20909, "an empty first run writes off everything already in the folder");
  assert.equal(firstRunEmpty.backlogRemaining, false);

  const firstRunWithMail = planFolderPoll({
    candidateUids: [905, 903, 904],
    isFirstRun: true,
    lastProcessedUid: 0,
    maxMessages: 40,
    uidNext: 906,
  });
  assert.deepEqual(firstRunWithMail.uids, [903, 904, 905], "UIDs are processed in ascending order");
  assert.equal(firstRunWithMail.baselineUid, 902, "the cursor never jumps past mail this run is about to read");

  // A normal run only looks past the cursor, even if the server's `uid:N:*` search hands back the
  // highest existing UID when N is beyond the end (a real IMAP range quirk).
  const steadyState = planFolderPoll({
    candidateUids: [20909],
    isFirstRun: false,
    lastProcessedUid: 20909,
    maxMessages: 40,
    uidNext: 20910,
  });
  assert.deepEqual(steadyState.uids, [], "already-processed UIDs are filtered out");
  assert.equal(steadyState.baselineUid, 20909, "an idle run leaves the cursor exactly where it was");

  // The cap bounds one run; the remainder is a backlog for the next one, never a skip.
  const capped = planFolderPoll({
    candidateUids: [1, 2, 3, 4, 5],
    isFirstRun: false,
    lastProcessedUid: 0,
    maxMessages: 2,
    uidNext: 6,
  });
  assert.deepEqual(capped.uids, [1, 2], "the oldest messages are taken first so nothing is stranded");
  assert.equal(capped.backlogRemaining, true);

  // --- summarizePollFailures -------------------------------------------------------------------
  // The bug this guards: a mailbox that cannot be reached used to produce HTTP 200 + a green cron
  // monitor, so inbound CV intake could be dead for days while every dashboard said it was fine.
  assert.deepEqual(summarizePollFailures([]), [], "no mailboxes configured is the inert state, not a failure");

  const healthy: MailboxPollSummary = {
    folders: [{ backlogRemaining: false, cursorLabel: "hr", folderPath: "INBOX", messagesSeen: 1, results: [] }],
    mailboxLabel: "hr",
  };
  assert.deepEqual(summarizePollFailures([healthy]), []);

  const deadMailbox: MailboxPollSummary = {
    connectionError: "Invalid credentials (AUTHENTICATIONFAILED)",
    folders: [],
    mailboxLabel: "careers",
  };
  assert.deepEqual(summarizePollFailures([deadMailbox]), ["careers: Invalid credentials (AUTHENTICATIONFAILED)"]);

  const partialFolderFailure: MailboxPollSummary = {
    folders: [
      { backlogRemaining: false, cursorLabel: "hr", folderPath: "INBOX", messagesSeen: 2, results: [] },
      { backlogRemaining: false, cursorLabel: "hr:junk", error: "Mailbox does not exist", folderPath: "Bulk Mail", messagesSeen: 0, results: [] },
    ],
    mailboxLabel: "hr",
  };
  assert.deepEqual(
    summarizePollFailures([partialFolderFailure]),
    ["hr/Bulk Mail: Mailbox does not exist"],
    "a junk-folder failure is reported even when INBOX succeeded",
  );

  assert.deepEqual(
    summarizePollFailures([{ connectionError: "ETIMEDOUT", folders: [{ backlogRemaining: false, cursorLabel: "hr", error: "x", folderPath: "INBOX", messagesSeen: 0, results: [] }], mailboxLabel: "hr" }]),
    ["hr: ETIMEDOUT"],
    "one outage is reported once, not repeated per folder underneath it",
  );
}
