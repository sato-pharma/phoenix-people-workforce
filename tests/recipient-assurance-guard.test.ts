import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decideRecipientAssurance } from "../src/lib/email/recipient-assurance.ts";

/**
 * The Recipient Assurance Guard: no email leaves this system unless every address is accounted
 * for and the person it is FOR is actually addressed.
 *
 * Owner requirement, 2026-08-08, after 67 notifications shipped with the intended person in
 * neither To, CC nor BCC — addressed to the shared phoenix@satopharma.com inbox and every one
 * recorded `sent`. Failure policy is the owner's: AUTO-CORRECT where the right answer is
 * derivable, BLOCK only where it is not. Holding was rejected on evidence (8 password resets and
 * 4 account-setup links sat held and undelivered for a week).
 *
 * decideRecipientAssurance is pure, so unlike the source-pinned resolveNotificationDelivery guards
 * this is real behavioural coverage — the function is executed against real inputs.
 */
const DIRECTORY = [
  { email: "omar.anwar@satopharma.com", hrId: "B-10" },
  { email: "taha.mohamed@satopharma.com", hrId: "B-94" },
  { email: "ali.mohamed@satopharma.com", hrId: "A-12" },
];
const INBOXES = ["phoenix@satopharma.com", "hr@satopharma.com"];

export function runRecipientAssuranceGuardTests() {
  // ── The incident itself ────────────────────────────────────────────────────────────────────
  // To held only the shared inbox while the email was for B-94. The inbox was standing in for a
  // person, so it is REPLACED, not appended — leaving it would keep mailing the wrong mailbox.
  const incident = decideRecipientAssurance(
    { intendedHrId: "B-94", systemInboxes: INBOXES, to: ["phoenix@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(incident.outcome, "corrected", "an email for B-94 addressed only to the shared inbox must be corrected");
  assert.deepEqual(
    incident.outcome === "corrected" ? incident.to : null,
    ["taha.mohamed@satopharma.com"],
    "the shared inbox standing in for a person is replaced by that person's real address",
  );

  // ── A real recipient already addressed is never displaced ──────────────────────────────────
  // A workflow envelope legitimately addresses a primary recipient; the intended person is ADDED.
  // Replacing here would drop a real recipient — trading one delivery bug for another.
  const envelope = decideRecipientAssurance(
    { intendedHrId: "B-94", systemInboxes: INBOXES, to: ["ali.mohamed@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(envelope.outcome, "corrected", "a missing intended recipient is still corrected");
  assert.deepEqual(
    envelope.outcome === "corrected" ? envelope.to.slice().sort() : null,
    ["ali.mohamed@satopharma.com", "taha.mohamed@satopharma.com"],
    "an already-addressed real person is kept and the intended recipient added alongside",
  );

  // ── Correctly addressed mail passes untouched ──────────────────────────────────────────────
  const healthy = decideRecipientAssurance(
    { intendedHrId: "B-10", systemInboxes: INBOXES, to: ["omar.anwar@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(healthy.outcome, "pass", "a correctly addressed email is not touched");

  // ── Blocks: the two cases where the right answer is not derivable ──────────────────────────
  const noAddress = decideRecipientAssurance(
    { intendedHrId: "PHX-1", systemInboxes: INBOXES, to: ["phoenix@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(noAddress.outcome, "block", "an email for someone with no address on file must not fall back to the inbox");
  assert.equal(
    noAddress.outcome === "block" ? noAddress.code : null,
    "intended_recipient_has_no_address",
    "the block names the missing address so the operator knows what to fix",
  );

  const stranger = decideRecipientAssurance(
    { systemInboxes: INBOXES, to: ["typo@gmial.com"] },
    DIRECTORY,
  );
  assert.equal(stranger.outcome, "block", "an address belonging to nobody must never reach a provider");
  assert.equal(
    stranger.outcome === "block" ? stranger.code : null,
    "unknown_recipient_address",
    "an undeclared unknown address blocks as unknown, not as something else",
  );

  // ── Declared external mail still flows (candidates, inbound replies) ───────────────────────
  // The owner scoped the guard to ALL mail, so recruitment would break without this path.
  const candidate = decideRecipientAssurance(
    { declaredExternal: ["someone@gmail.com"], systemInboxes: INBOXES, to: ["someone@gmail.com"] },
    DIRECTORY,
  );
  assert.equal(candidate.outcome, "pass", "an address the caller declared external is allowed through");

  // ── A mailbox a person pressed for (New Hire Accounts, 3 Nov 2026) ─────────────────────────
  // Hagar Abu zeid has no Sato mailbox, so her private email was refused at every try.
  const noSatoMailbox = decideRecipientAssurance(
    { chosenMailbox: "new.hire@gmail.com", declaredExternal: ["new.hire@gmail.com"], intendedHrId: "PD-1", systemInboxes: INBOXES, to: ["New.Hire@gmail.com"] },
    DIRECTORY,
  );
  assert.deepEqual(noSatoMailbox, { outcome: "pass", to: ["new.hire@gmail.com"] }, "🔴 the chosen private mailbox reaches a person with no Sato mailbox");
  const hasSatoMailbox = decideRecipientAssurance(
    { chosenMailbox: "taha@gmail.com", declaredExternal: ["taha@gmail.com"], intendedHrId: "B-94", systemInboxes: INBOXES, to: ["taha@gmail.com"] },
    DIRECTORY,
  );
  assert.deepEqual(hasSatoMailbox, { outcome: "pass", to: ["taha@gmail.com"] }, "🔴 a Sato mailbox nobody chose is not added beside the chosen one");

  const undeclared = decideRecipientAssurance(
    { chosenMailbox: "new.hire@gmail.com", intendedHrId: "PD-1", systemInboxes: INBOXES, to: ["new.hire@gmail.com"] },
    DIRECTORY,
  );
  assert.equal(undeclared.outcome === "block" ? undeclared.code : null, "intended_recipient_has_no_address", "🔴 an undeclared address gets no way through by being named");
  const notInTo = decideRecipientAssurance(
    { chosenMailbox: "new.hire@gmail.com", declaredExternal: ["new.hire@gmail.com"], intendedHrId: "PD-1", systemInboxes: INBOXES, to: ["phoenix@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(notInTo.outcome === "block" ? notInTo.code : null, "intended_recipient_has_no_address", "🔴 a shared inbox still cannot stand in for the person");
  const beside = decideRecipientAssurance(
    { chosenMailbox: "new.hire@gmail.com", declaredExternal: ["new.hire@gmail.com"], intendedHrId: "PD-1", systemInboxes: INBOXES, to: ["new.hire@gmail.com", "ali.mohamed@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(beside.outcome === "block" ? beside.code : null, "intended_recipient_has_no_address", "🔴 it answers only when it is the whole of To");
  const leakyChosen = decideRecipientAssurance(
    { bcc: ["stranger@elsewhere.com"], chosenMailbox: "new.hire@gmail.com", declaredExternal: ["new.hire@gmail.com"], intendedHrId: "PD-1", systemInboxes: INBOXES, to: ["new.hire@gmail.com"] },
    DIRECTORY,
  );
  assert.equal(leakyChosen.outcome === "block" ? leakyChosen.code : null, "unknown_recipient_address", "🔴 CC and BCC are still checked");

  // ── CC and BCC are policed too ─────────────────────────────────────────────────────────────
  // A wrong CC leaks a payslip just as effectively as a wrong To.
  const leakyCc = decideRecipientAssurance(
    { cc: ["stranger@elsewhere.com"], systemInboxes: INBOXES, to: ["omar.anwar@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(leakyCc.outcome, "block", "an unknown CC address must block — a wrong CC leaks as badly as a wrong To");

  const leakyBcc = decideRecipientAssurance(
    { bcc: ["stranger@elsewhere.com"], systemInboxes: INBOXES, to: ["omar.anwar@satopharma.com"] },
    DIRECTORY,
  );
  assert.equal(leakyBcc.outcome, "block", "an unknown BCC address must block");

  // ── Normalisation: case and whitespace must not defeat the directory match ─────────────────
  const messy = decideRecipientAssurance(
    { intendedHrId: " b-10 ", systemInboxes: INBOXES, to: ["  Omar.Anwar@SatoPharma.com  "] },
    DIRECTORY,
  );
  assert.equal(messy.outcome, "pass", "HR_ID and address matching is case- and whitespace-insensitive");

  const empty = decideRecipientAssurance({ systemInboxes: INBOXES, to: [] }, DIRECTORY);
  assert.equal(empty.outcome, "block", "an email with no To recipient must never be dispatched");

  // ── The guard must actually be wired into the single choke point ───────────────────────────
  // The logic above is worthless if nothing calls it. sendPhoenixEmail is the one function every
  // send path reaches (email-providers.ts is the only file that calls a provider, pinned by
  // tests/email-notifications.test.ts), so the guard belongs there and nowhere else.
  const sendSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
  assert.match(sendSource, /decideRecipientAssurance\(/, "the guard must run inside sendPhoenixEmail");
  const guardAt = sendSource.indexOf("decideRecipientAssurance(");
  const fanoutAt = sendSource.indexOf("if (input.fanoutToBcc");
  assert.notEqual(fanoutAt, -1, "the fan-out privacy transform must still exist");
  assert.ok(
    guardAt < fanoutAt,
    "the guard must run BEFORE fanoutToBcc — after it, To is the neutral reply-to and the guard would 'correct' it, undoing the fan-out and exposing every recipient",
  );
  assert.match(
    sendSource,
    /recipient_assurance_blocked/,
    "a blocked send must be logged as an error, not dropped quietly",
  );
}
