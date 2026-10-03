/**
 * Reading Turbify's activation invitation.
 *
 * The fixture below is the REAL message, read from the owner's inbox on 2026-10-03 at 10:56 Cairo
 * after the robot created `hr.mailbox@satopharma.com` — wording, bracketing, asterisks and wrapping
 * as Turbify's HTML-to-text conversion produced them. The temp password is replaced with a
 * placeholder of the same shape; nothing else is edited. Writing these cases against an imagined
 * email is precisely how this robot has already shipped three flows that did nothing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INVITATION_ACTIVATION_URL,
  INVITATION_SENDER,
  invitationAddresses,
  pickInvitation,
  readInvitation,
  readTempPassword,
} from "@/lib/new-hire-mailbox/robot/invitation";

/** The real body, with the credential swapped for a same-shaped placeholder. */
const REAL_BODY = [
  "Activate Email Account",
  "   = Welcome! You've been invited to activate",
  "*hr.mailbox@satopharma.com!* =",
  "",
  "   An email administrator for satopharma.com has invited you to use the",
  "business email address hr.mailbox@satopharma.com.",
  " *Turbify email is powered by Yahoo.* To activate",
  "hr.mailbox@satopharma.com, use the following credentials.",
  "",
  "  Username: hr.mailbox@satopharma.com",
  "",
  " Temp Password: AAAAAAAAAAAAAAA",
  "",
  "",
  "   Activate your account <https://mail.turbify.com/login?>",
  " If you have trouble accessing the Activation page, you may also copy and",
  "paste the following URL into your browser: https://mail.turbify.com/login?",
  "",
  "  == How to access your business email once it's activated: ==",
  "   WEB BROWSER  Go to http://mail.satopharma.com or http://mail.yahoo.com.",
  "  *Username:* hr.mailbox@satopharma.com",
  " *Password:* {The password you create during the activation of email",
  "address.}",
  "",
  " *Questions?* Browse our Help Pages",
  "<https://help.turbify.com/s/article/SLN17558> or contact your administrator",
  "for satopharma.com.",
].join("\n");

const REAL_SUBJECT =
  "An administrator for [satopharma.com] has invited you to activate [hr.mailbox@satopharma.com]";

const realMessage = (overrides: Record<string, unknown> = {}) => ({
  body: REAL_BODY,
  from: "Turbify <no-reply@turbify.com>",
  subject: REAL_SUBJECT,
  ...overrides,
});

/** The invitation Turbify really sent, read for the mailbox it really activates. */
function runRealMessageCases(): void {
  const reading = readInvitation(realMessage(), "hr.mailbox@satopharma.com");
  assert.ok("credentials" in reading, "the real invitation must be readable");
  if (!("credentials" in reading)) return;
  assert.equal(reading.credentials.address, "hr.mailbox@satopharma.com");
  assert.equal(reading.credentials.tempPassword, "AAAAAAAAAAAAAAA");

  // The subject carries satopharma.com in its own brackets; that is a DOMAIN, not a mailbox, and
  // must not be mistaken for the address this invitation activates.
  assert.deepEqual(invitationAddresses(realMessage()), ["hr.mailbox@satopharma.com"]);

  // Case and padding in the caller's target are not identity differences.
  assert.ok("credentials" in readInvitation(realMessage(), "  HR.Mailbox@SatoPharma.com  "));

  assert.equal(INVITATION_SENDER, "no-reply@turbify.com");
  assert.equal(INVITATION_ACTIVATION_URL, "https://mail.turbify.com/login");
}

/**
 * 🔴 THE NEAR-MISS PAIR. One invite inbox receives every new hire's invitation, and
 * `adel.sayed@satopharma.com` CONTAINS `el.sayed@satopharma.com`. That pair has already cost this
 * robot a wrongly-refused new hire and came within one click of resetting a working employee's
 * mailbox (#5223). Here it would hand back a temp password that opens the wrong mailbox.
 */
function runWrongMailboxCases(): void {
  const otherPerson = realMessage({
    body: REAL_BODY.replace(/hr\.mailbox@satopharma\.com/g, "adel.sayed@satopharma.com"),
    subject: REAL_SUBJECT.replace("hr.mailbox@satopharma.com", "adel.sayed@satopharma.com"),
  });

  const reading = readInvitation(otherPerson, "el.sayed@satopharma.com");
  assert.ok("refusal" in reading, "an invitation for adel.sayed must NOT satisfy a read for el.sayed");
  assert.match("refusal" in reading ? reading.refusal : "", /belongs to a different mailbox/);

  // And the exact one still works when its near-miss neighbour is the one in hand.
  const sameShape = realMessage({
    body: REAL_BODY.replace(/hr\.mailbox@satopharma\.com/g, "el.sayed@satopharma.com"),
    subject: REAL_SUBJECT.replace("hr.mailbox@satopharma.com", "el.sayed@satopharma.com"),
  });
  assert.ok("credentials" in readInvitation(sameShape, "el.sayed@satopharma.com"));

  // A message from anyone but Turbify is not an invitation, whatever it says.
  const spoofed = realMessage({ from: "Turbify <no-reply@turbify-mail.example>" });
  const spoofedReading = readInvitation(spoofed, "hr.mailbox@satopharma.com");
  assert.ok("refusal" in spoofedReading);
  assert.match("refusal" in spoofedReading ? spoofedReading.refusal : "", /not sent by/);

  // No target, no read — there is deliberately no "whichever mailbox this is for" path.
  assert.ok("refusal" in readInvitation(realMessage(), ""));
}

/** The temp password line, read strictly — a stray asterisk fails a login with no clue why. */
function runTempPasswordCases(): void {
  assert.equal(readTempPassword(" Temp Password: AAAAAAAAAAAAAAA"), "AAAAAAAAAAAAAAA");
  assert.equal(readTempPassword("*Temp Password:* BBBBBBBBBBB"), "BBBBBBBBBBB");
  assert.equal(readTempPassword("  temp password   CCCCCCCCCC  "), "CCCCCCCCCC");
  assert.equal(readTempPassword("Temp Password: DDDD *"), null, "two tokens is not a password");
  assert.equal(readTempPassword("Password: EEEEEEEE"), null, "the plain Password label is the HELP text");
  assert.equal(readTempPassword(null), null);

  // 🔴 The body's help section says `*Password:* {The password you create during...}`. A looser
  // reader that accepted the `Password:` label would return "{The" as the credential.
  const reading = readInvitation(realMessage(), "hr.mailbox@satopharma.com");
  assert.ok("credentials" in reading);
  if ("credentials" in reading) assert.notEqual(reading.credentials.tempPassword, "{The");

  // Wording drift must REFUSE and say so, not guess at another label.
  const relabelled = realMessage({ body: REAL_BODY.replace("Temp Password:", "Temporary passcode:") });
  const drift = readInvitation(relabelled, "hr.mailbox@satopharma.com");
  assert.ok("refusal" in drift);
  assert.match("refusal" in drift ? drift.refusal : "", /re-calibrate/);
}

/** Choosing among the messages an inbox returned, newest first. */
function runPickCases(): void {
  const forOther = realMessage({
    body: REAL_BODY.replace(/hr\.mailbox@satopharma\.com/g, "norhan.samir@satopharma.com"),
    subject: REAL_SUBJECT.replace("hr.mailbox@satopharma.com", "norhan.samir@satopharma.com"),
  });

  // The newest message is somebody else's invitation; the right one is further down the list.
  const picked = pickInvitation([forOther, realMessage()], "hr.mailbox@satopharma.com");
  assert.ok("credentials" in picked, "it must look past a newer invitation for another mailbox");
  if ("credentials" in picked) assert.equal(picked.credentials.address, "hr.mailbox@satopharma.com");

  // Newest-first order decides between two invitations for the SAME mailbox: Turbify's temp
  // passwords are one-use, so a re-invited mailbox must get the latest, never a spent one.
  const newer = realMessage({ body: REAL_BODY.replace("AAAAAAAAAAAAAAA", "ZZZZZZZZZZZZZZZ") });
  const latest = pickInvitation([newer, realMessage()], "hr.mailbox@satopharma.com");
  assert.ok("credentials" in latest);
  if ("credentials" in latest) assert.equal(latest.credentials.tempPassword, "ZZZZZZZZZZZZZZZ");

  // 🔴 FAILS CLOSED. An unreadable inbox is not an empty one.
  for (const unreadable of [null, undefined]) {
    const reading = pickInvitation(unreadable, "hr.mailbox@satopharma.com");
    assert.ok("refusal" in reading);
    assert.match("refusal" in reading ? reading.refusal : "", /unreadable inbox/);
  }

  // An empty inbox is a timing matter and says so, rather than reading as a defect.
  const empty = pickInvitation([], "hr.mailbox@satopharma.com");
  assert.ok("refusal" in empty);
  assert.match("refusal" in empty ? empty.refusal : "", /has arrived in the invite inbox yet/);

  // Only other mailboxes' invitations: the refusal names how many were looked at.
  const none = pickInvitation([forOther], "hr.mailbox@satopharma.com");
  assert.ok("refusal" in none);
  assert.match("refusal" in none ? none.refusal : "", /None of the 1 message/);
}

/**
 * 🔴 NO REFUSAL MAY CARRY THE CREDENTIAL. These messages reach the production log and the sweep's
 * own report, so a temp password inside one is an exposure that outlives the mailbox.
 */
function runNoLeakCases(): void {
  const secret = "AAAAAAAAAAAAAAA";
  const cases = [
    readInvitation(realMessage({ from: "someone@else.example" }), "hr.mailbox@satopharma.com"),
    readInvitation(realMessage(), "norhan.samir@satopharma.com"),
    pickInvitation([realMessage()], "norhan.samir@satopharma.com"),
    readInvitation(realMessage({ body: REAL_BODY.replace("Temp Password:", "Nope:") }), "hr.mailbox@satopharma.com"),
  ];
  for (const reading of cases) {
    assert.ok("refusal" in reading, "each of these must refuse");
    if ("refusal" in reading) {
      assert.equal(reading.refusal.includes(secret), false, "a refusal must never quote the temp password");
    }
  }
}

/** The invite recipient must be a mailbox Phoenix owns — never empty, never a person. */
function runRecipientCases(): void {
  const source = readFileSync(
    new URL("src/lib/new-hire-mailbox/robot/initial-password.ts", new URL("../", import.meta.url)),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.match(
    source, /TURBIFY_INVITE_RECIPIENT = "hr\.mailbox@satopharma\.com" as const/,
    "the invitation must go to the mailbox Phoenix reads",
  );
  // 🔴 EMPTY IS THE OLD BUG, NOT A SAFE DEFAULT. With no recipient Turbify emails the credential
  // nowhere, and every mailbox the robot creates is stranded Pending with no route to a password.
  assert.equal(
    source.includes('TURBIFY_INVITE_RECIPIENT = "" as const'), false,
    "an empty invite recipient strands every mailbox the robot creates",
  );
}

export async function runNewHireMailboxInvitationTests(): Promise<void> {
  runRealMessageCases();
  runWrongMailboxCases();
  runTempPasswordCases();
  runPickCases();
  runNoLeakCases();
  runRecipientCases();
}
