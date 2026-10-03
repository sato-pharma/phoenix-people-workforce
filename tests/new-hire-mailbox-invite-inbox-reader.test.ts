/**
 * Wiring the invitation reader into the create path.
 *
 * `invitation.ts` could always read a Turbify invitation; nothing called it, so a created mailbox
 * stayed PENDING with its credential sitting unread in an inbox Phoenix owns. These cases cover the
 * two halves that close that gap: the inbox reader (pure, driven with fakes — no IMAP, no browser),
 * and the one seam in the console driver that consumes it.
 *
 * 🔴 EVERY POSITIVE SOURCE ASSERTION HERE READS COMMENT-STRIPPED TEXT. In this module the comment
 * explaining a call quotes the call, so a raw-source `includes` is passed by the documentation while
 * the behaviour is deleted — measured twice in this very flow (`form.checkValidity()` stayed green
 * after being replaced with `return null`; a `result.handover` guard satisfied a render assertion
 * while nothing was drawn).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INVITATION_POLL,
  INVITE_INBOX_FOLDER,
  looksLikeInvitationFor,
  pollForInvitation,
  readInviteInbox,
  readInvitationFromInbox,
  type InviteInboxReaderDeps,
  type ListedMessage,
  type OpenedMessage,
} from "@/lib/new-hire-mailbox/robot/invite-inbox-reader";

import { stripComments } from "./support/comment-strip.ts";

const INBOX = "hr.mailbox@satopharma.com";
const WANTED = "new.hire@satopharma.com";
const MONITOR = "monitor-1";

/** An invitation body in Turbify's own shape, for whichever mailbox is asked for. */
function invitationBody(address: string, tempPassword = "AAAAAAAAAAAAAAA"): string {
  return [
    "Activate Email Account",
    `   = Welcome! You've been invited to activate *${address}!* =`,
    "",
    `  Username: ${address}`,
    "",
    ` Temp Password: ${tempPassword}`,
    "",
    "   Activate your account <https://mail.turbify.com/login?>",
  ].join("\n");
}

type Fixture = {
  listed: ListedMessage[];
  bodies: Record<number, OpenedMessage>;
};

/**
 * Deps over a fixture, recording what was asked of the world.
 *
 * `opened` is the assertion surface for "only plausible invitations are opened": every body fetch is
 * an audited IMAP read of a mailbox, so the count is a privacy property and not a performance one.
 */
function fakeDeps(fixture: Fixture, overrides: Partial<InviteInboxReaderDeps> = {}) {
  const calls = { listed: 0, lookups: [] as string[], opened: [] as number[] };
  const deps: InviteInboxReaderDeps = {
    findMonitorId: async (address) => {
      calls.lookups.push(address);
      return address.toLowerCase() === INBOX ? MONITOR : null;
    },
    listMessages: async () => {
      calls.listed += 1;
      return fixture.listed;
    },
    openMessage: async (_monitorId, _folder, uid) => {
      calls.opened.push(uid);
      return fixture.bodies[uid] ?? null;
    },
    ...overrides,
  };
  return { calls, deps };
}

function listed(uid: number, date: string | null, extra: Partial<ListedMessage> = {}): ListedMessage {
  return {
    date,
    fromAddress: "no-reply@turbify.com",
    subject: `An administrator for [satopharma.com] has invited you to activate [${WANTED}]`,
    toAddresses: [INBOX],
    uid,
    ...extra,
  };
}

function body(address: string, tempPassword?: string): OpenedMessage {
  return { html: null, subject: null, text: invitationBody(address, tempPassword) };
}

/** The reading, or a failure naming what came back instead. */
function credentialsOf(reading: Awaited<ReturnType<typeof readInvitationFromInbox>>, message: string) {
  assert.ok("credentials" in reading, `${message} — got refusal: ${"refusal" in reading ? reading.refusal : "?"}`);
  return reading.credentials;
}

async function runHappyPathCases(): Promise<void> {
  const fixture: Fixture = {
    bodies: { 11: body(WANTED, "TEMPPASSWORD123") },
    listed: [listed(11, "2026-10-03T08:56:00.000Z")],
  };
  const { calls, deps } = fakeDeps(fixture);
  const reading = await readInvitationFromInbox({ address: WANTED, deps });
  const credentials = credentialsOf(reading, "the invitation in the inbox must be read");
  assert.equal(credentials.tempPassword, "TEMPPASSWORD123", "the temp password must come back intact");
  assert.equal(credentials.address, WANTED, "and it must be bound to the mailbox it activates");
  assert.deepEqual(calls.lookups, [INBOX], "the monitor must be resolved for the INVITE inbox");
  assert.deepEqual(calls.opened, [11], "exactly the one plausible message may be opened");
}

/**
 * 🔴 THE ORDER IS THIS MODULE'S JOB. `pickInvitation` returns the FIRST match and documents that it
 * is handed messages newest-first, so that a mailbox re-invited after a failed activation gets its
 * latest temp password — Turbify's are one-use. IMAP returns whatever order it likes, so nothing
 * satisfies that contract unless the reader sorts.
 */
async function runOrderCases(): Promise<void> {
  const oldest = listed(1, "2026-10-01T06:00:00.000Z");
  const newest = listed(2, "2026-10-03T08:56:00.000Z");
  const fixture: Fixture = {
    bodies: { 1: body(WANTED, "SPENTPASSWORD01"), 2: body(WANTED, "LIVEPASSWORD002") },
    // Oldest first, which is what an IMAP listing usually gives.
    listed: [oldest, newest],
  };
  const { calls, deps } = fakeDeps(fixture);
  const reading = await readInvitationFromInbox({ address: WANTED, deps });
  assert.equal(
    credentialsOf(reading, "a re-invited mailbox must still read").tempPassword, "LIVEPASSWORD002",
    "the NEWEST invitation must win — an oldest-first listing must be re-sorted, not trusted",
  );
  assert.deepEqual(
    calls.opened, [2],
    "and the spent invitation must not even be opened once the newest one answers",
  );

  // 🔴 AN UNDATED MESSAGE SORTS LAST, AND THE HAZARD IS `NaN` RATHER THAN 1970. `Date.parse` of a
  // missing header returns NaN, every comparison with NaN is false, so an unguarded comparator is
  // inconsistent and the sort may leave the listing exactly as IMAP gave it — with the undated
  // message first, and taken as the newest invitation. Proven by break-and-watch: substituting `0`
  // for `-Infinity` changes nothing for a real date, so this case pins the NaN guard specifically.
  const undated = fakeDeps({
    bodies: { 2: body(WANTED, "LIVEPASSWORD002"), 9: body(WANTED, "UNDATEDPASSWRD") },
    listed: [listed(9, null), newest],
  });
  const withUndated = await readInvitationFromInbox({ address: WANTED, deps: undated.deps });
  assert.equal(
    credentialsOf(withUndated, "an undated message must not break the read").tempPassword,
    "LIVEPASSWORD002",
    "an undated message must sort LAST — dated invitations are the only ones with a known age",
  );
}

/**
 * 🔴 ONLY PLAUSIBLE INVITATIONS MAY BE OPENED. Each body fetch is an audited read of a mailbox, so
 * this is a privacy rule before it is a cost one: Phoenix does not open mail it has no business
 * opening, even in a mailbox it owns.
 */
async function runNarrowingCases(): Promise<void> {
  const unrelated: ListedMessage = {
    date: "2026-10-03T09:30:00.000Z",
    fromAddress: "newsletter@example.com",
    subject: "Your weekly digest",
    toAddresses: [INBOX],
    uid: 50,
  };
  const fixture: Fixture = {
    bodies: { 11: body(WANTED), 50: { html: null, subject: null, text: "nothing to see" } },
    listed: [unrelated, listed(11, "2026-10-03T08:56:00.000Z")],
  };
  const { calls, deps } = fakeDeps(fixture);
  await readInvitationFromInbox({ address: WANTED, deps });
  assert.equal(
    calls.opened.includes(50), false,
    "an unrelated message must never be opened — every body fetch is an audited mailbox read",
  );

  assert.equal(
    looksLikeInvitationFor(unrelated, WANTED), false,
    "a message that is neither from Turbify nor about this mailbox is not a candidate",
  );
  assert.equal(
    looksLikeInvitationFor({ ...unrelated, fromAddress: "Turbify <no-reply@turbify.com>" }, WANTED), true,
    "a real From header is `Turbify <no-reply@turbify.com>`, so the sender test must allow the name",
  );
  assert.equal(
    looksLikeInvitationFor({ ...unrelated, toAddresses: [WANTED] }, WANTED), true,
    "a message addressed to the mailbox itself is a candidate",
  );
  assert.equal(
    looksLikeInvitationFor({ ...unrelated, toAddresses: ["adel.sayed@satopharma.com"] }, "el.sayed@satopharma.com"),
    false,
    "the recipient test must be IDENTITY — adel.sayed@ contains el.sayed@ and is a different person",
  );
  assert.equal(
    looksLikeInvitationFor(listed(1, null), ""), false,
    "no wanted address means no candidate, never every candidate",
  );
}

/**
 * 🔴 THE NEAR-MISS PAIR IS REAL AND HAS ALREADY COST A WRONGLY-REFUSED NEW HIRE. Narrowing may
 * promote a near miss to being opened; `readInvitation` is what must then refuse it, so the reader
 * must hand back that refusal rather than the credentials of somebody else's mailbox.
 */
async function runWrongMailboxCases(): Promise<void> {
  const fixture: Fixture = {
    bodies: { 11: body("adel.sayed@satopharma.com") },
    listed: [listed(11, "2026-10-03T08:56:00.000Z", {
      subject: "An administrator for [satopharma.com] has invited you to activate [adel.sayed@satopharma.com]",
    })],
  };
  const { deps } = fakeDeps(fixture);
  const reading = await readInvitationFromInbox({ address: "el.sayed@satopharma.com", deps });
  assert.ok("refusal" in reading, "an invitation for a different mailbox must never hand back credentials");
  assert.equal(
    reading.refusal.includes("AAAAAAAAAAAAAAA"), false,
    "and no refusal may quote the credential it found",
  );
}

/**
 * 🔴 AN UNREADABLE INBOX IS NOT AN EMPTY ONE, AND THE DIFFERENCE IS WHAT THE POLL IS FOR. Only "it
 * has not arrived yet" improves by waiting; every other refusal says the same thing on the sixth
 * pass, so retrying it just delays an honest report while a browser session ages.
 */
async function runRetryableCases(): Promise<void> {
  const empty = fakeDeps({ bodies: {}, listed: [] });
  const nothingYet = await readInviteInbox({ address: WANTED, deps: empty.deps });
  assert.ok("refusal" in nothingYet.reading, "an empty inbox is a refusal");
  assert.match(nothingYet.reading.refusal, /has arrived/, "and it must say the invitation has not arrived");
  assert.equal(
    nothingYet.retryable, true,
    "an inbox that was READ and held nothing yet is the ONE refusal that waiting can change",
  );

  const notConnected = fakeDeps({ bodies: {}, listed: [] }, { findMonitorId: async () => null });
  const unconnected = await readInviteInbox({ address: WANTED, deps: notConnected.deps });
  assert.ok("refusal" in unconnected.reading, "an unconnected invite inbox must refuse");
  assert.match(
    unconnected.reading.refusal, /Mailbox Monitor/,
    "and it must name the page where the inbox is connected — this one is a job, not a wait",
  );
  assert.equal(
    unconnected.retryable, false,
    "an unconnected inbox must NOT be retried — six passes report the same thing a minute later",
  );

  const lookupThrew = fakeDeps({ bodies: {}, listed: [] }, {
    findMonitorId: async () => { throw new Error("monitor table unreachable"); },
  });
  const lookupFailed = await readInviteInbox({ address: WANTED, deps: lookupThrew.deps });
  assert.ok("refusal" in lookupFailed.reading, "a failed lookup must refuse");
  assert.match(
    lookupFailed.reading.refusal, /rather than treat an unreadable inbox as an empty one/,
    "a failed lookup must never be reported as an empty inbox",
  );
  assert.equal(lookupFailed.retryable, false, "a failed lookup is settled, not a wait");

  const listThrew = fakeDeps({ bodies: {}, listed: [] }, {
    listMessages: async () => { throw new Error("IMAP connection refused"); },
  });
  const listFailed = await readInviteInbox({ address: WANTED, deps: listThrew.deps });
  assert.ok("refusal" in listFailed.reading, "a failed listing must refuse");
  assert.match(
    listFailed.reading.refusal, /rather than treat an unreadable inbox as an empty one/,
    "a failed listing must never be reported as an empty inbox",
  );
  assert.equal(listFailed.retryable, false, "a failed listing is settled, not a wait");

  const notAnArray = fakeDeps({ bodies: {}, listed: [] }, {
    listMessages: async () => null as unknown as ListedMessage[],
  });
  const garbage = await readInviteInbox({ address: WANTED, deps: notAnArray.deps });
  assert.ok("refusal" in garbage.reading, "a listing that is not a list must refuse");
  assert.equal(garbage.retryable, false, "and it is settled — the same non-list comes back next pass");

  // One message that cannot be opened is not an unreadable inbox: the next candidate may be it.
  const oneBad = fakeDeps({
    bodies: { 11: body(WANTED, "LIVEPASSWORD002") },
    listed: [listed(12, "2026-10-03T09:00:00.000Z"), listed(11, "2026-10-03T08:56:00.000Z")],
  }, {
    openMessage: async (_m, _f, uid) => {
      if (uid === 12) throw new Error("message gone");
      return body(WANTED, "LIVEPASSWORD002");
    },
  });
  const survived = await readInvitationFromInbox({ address: WANTED, deps: oneBad.deps });
  assert.equal(
    credentialsOf(survived, "one unreadable message must not fail the whole read").tempPassword,
    "LIVEPASSWORD002",
    "a message that vanished between the listing and the fetch must be skipped, not fatal",
  );

  const noAddress = await readInviteInbox({ address: "  ", deps: empty.deps });
  assert.ok("refusal" in noAddress.reading, "no address means no read");
  assert.equal(noAddress.retryable, false, "and no amount of waiting supplies one");

  const noInbox = await readInviteInbox({ address: WANTED, deps: empty.deps, inbox: "" });
  assert.ok("refusal" in noInbox.reading, "an unconfigured invite inbox must refuse");
  assert.match(noInbox.reading.refusal, /TURBIFY_INVITE_RECIPIENT/, "and it must name what is unset");
}

/** The poll: it must wait for a delivery, stop dead on a settled refusal, and never trail a sleep. */
async function runPollCases(): Promise<void> {
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); };

  // Arrives on the third pass.
  let pass = 0;
  const arriving: InviteInboxReaderDeps = {
    findMonitorId: async () => MONITOR,
    listMessages: async () => {
      pass += 1;
      return pass < 3 ? [] : [listed(11, "2026-10-03T08:56:00.000Z")];
    },
    openMessage: async () => body(WANTED, "LIVEPASSWORD002"),
  };
  const arrived = await pollForInvitation({ address: WANTED, attempts: 6, deps: arriving, wait, waitMs: 10 });
  assert.equal(
    credentialsOf(arrived, "a late delivery must still be read").tempPassword, "LIVEPASSWORD002",
    "the poll must keep reading while the only refusal is that nothing has arrived yet",
  );
  assert.deepEqual(waits, [10, 10], "it must wait BETWEEN passes — twice before the third succeeds");

  // Settled on the first pass: no waiting at all.
  waits.length = 0;
  let listings = 0;
  const unconnected: InviteInboxReaderDeps = {
    findMonitorId: async () => null,
    listMessages: async () => { listings += 1; return []; },
    openMessage: async () => null,
  };
  const stopped = await pollForInvitation({ address: WANTED, attempts: 6, deps: unconnected, wait, waitMs: 10 });
  assert.ok("refusal" in stopped, "an unconnected inbox must still refuse through the poll");
  assert.deepEqual(waits, [], "a settled refusal must stop the poll DEAD — not sleep out its attempts");
  assert.equal(listings, 0, "and it must not even reach the listing");

  // Never arrives: the attempts are spent, with no trailing sleep.
  waits.length = 0;
  const never: InviteInboxReaderDeps = {
    findMonitorId: async () => MONITOR,
    listMessages: async () => [],
    openMessage: async () => null,
  };
  const gaveUp = await pollForInvitation({ address: WANTED, attempts: 3, deps: never, wait, waitMs: 10 });
  assert.ok("refusal" in gaveUp, "an invitation that never arrives must refuse");
  assert.equal(
    waits.length, 2,
    "there must be no wait AFTER the last attempt — a trailing sleep only delays the report",
  );

  assert.equal(INVITATION_POLL.attempts >= 3, true, "the default poll must give a delivery real time");
  assert.equal(INVITE_INBOX_FOLDER, "INBOX", "Turbify files the invitation nowhere else");
}

/**
 * The seam in the console driver, pinned on comment-stripped source.
 *
 * 🔴 WHAT MAKES THESE WORTH WRITING: the create path is the one step nothing can rehearse. It
 * consumes a mailbox seat on a live domain, so a test is the only thing standing between a wrong
 * edit here and a real PENDING mailbox nobody can finish.
 */
function runDriverSeamCases(): void {
  const path = new URL("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts", import.meta.url);
  const raw = readFileSync(path, "utf8");
  const code = stripComments(raw);

  const start = code.indexOf("async createMailbox(");
  const end = code.indexOf("async resetAndCapture(", start);
  assert.ok(start > 0 && end > start, "could not locate the createMailbox method in the driver");
  const create = code.slice(start, end);

  // Baseline: the branch this all hangs off is still the ABSENCE of the reset dialog.
  assert.match(
    create, /if \(!\(await hasHeading\(page, ONE_TIME_PASSWORD_DIALOG\.heading\)\)\)/,
    "the invitation path must hang off the absence of the one-time-password dialog",
  );
  assert.match(
    create, /await ports\.readInvitation\(address\)/,
    "the create step must READ THE INVITATION when Turbify shows no dialog — otherwise every mailbox "
    + "it creates is stranded PENDING with its credential unread",
  );
  assert.match(
    create, /oneTimePassword: invitation\.credentials\.tempPassword/,
    "and it must hand the invitation's temp password back as the one-time password — both are "
    + "one-use and both are spent by setting the company password in step 2",
  );

  // 🔴 THE DIALOG MUST STILL WIN. Reading an inbox is slower and touches a mailbox; where Turbify
  // does show the dialog, that password must be used and nothing read.
  const dialogBranch = create.indexOf("if (!(await hasHeading(page, ONE_TIME_PASSWORD_DIALOG.heading)))");
  const invitationCall = create.indexOf("ports.readInvitation(address)");
  const dialogRead = create.indexOf("await readOneTimePassword(page, address)");
  assert.ok(
    invitationCall > dialogBranch && dialogRead > invitationCall,
    "the invitation must be the FALLBACK inside the no-dialog branch, never read ahead of the dialog",
  );

  // The refusal must still state what was left behind on the live domain, WITH the inbox's reason.
  assert.match(
    create, /describeCreateWithoutPassword\(page, address, consoleUrl, invitation\.refusal\)/,
    "a failed invitation read must still report what the create left behind, carrying the reason",
  );

  // 🔴 AND THE "NOT CALIBRATED YET" WORDING MUST NOT SURVIVE A REFUSAL THAT HAS A REASON. It was
  // true while nothing read the invitation and is a lie once something does — and the owner acts on
  // this sentence, so the two cases may not share it.
  const describeStart = code.indexOf("async function describeCreateWithoutPassword(");
  const describeEnd = code.indexOf("const settle =", describeStart);
  assert.ok(describeStart > 0 && describeEnd > describeStart, "could not locate describeCreateWithoutPassword");
  const describe = code.slice(describeStart, describeEnd);
  assert.match(
    describe, /invitationRefusal/,
    "describeCreateWithoutPassword must take the invitation's refusal so the two cases read differently",
  );
  assert.match(
    describe, /The mailbox \$\{landed\}/,
    "whether the mailbox WAS CREATED must stay the first fact in the message — it decides what "
    + "anybody does next, and burying it is how `was created` got read as `failed`",
  );

  assert.match(
    code, /ports: JoinerDriverPorts = \{\}/,
    "the driver must take its invitation reader as an injected port, not import a mailbox itself",
  );
}

/** The production wiring: the real reader is attached once, and its reads are attributed. */
function runProductionWiringCases(): void {
  const path = new URL("../src/lib/new-hire-mailbox/robot/sweep-deps.ts", import.meta.url);
  const code = stripComments(readFileSync(path, "utf8"));

  assert.match(
    code, /createTurbifyJoinerDriver\(\s*\{ password, username \},\s*\{ readInvitation:/,
    "createJoinerDriverFromEnv must attach the real invitation reader — it is the one factory every "
    + "live caller goes through, so a driver built anywhere else cannot finish a create",
  );
  assert.match(
    code, /pollForInvitation\(\{ address, deps: defaultInviteInboxReaderDeps\(\) \}\)/,
    "and it must POLL, because Turbify delivers the invitation as part of the save",
  );

  const depsStart = code.indexOf("export function defaultInviteInboxReaderDeps(");
  const depsEnd = code.indexOf("export async function createJoinerDriverFromEnv(", depsStart);
  assert.ok(depsStart > 0 && depsEnd > depsStart, "could not locate defaultInviteInboxReaderDeps");
  const deps = code.slice(depsStart, depsEnd);

  // 🔴 EVERY MAILBOX READ MUST BE ATTRIBUTED. `withMonitorRead` writes one audit row per call with
  // the actor it is handed, so a null actor records Phoenix opening a mailbox as nobody's read.
  assert.match(
    deps, /listMonitorMessages\(monitorId, folder, ROBOT_ACTOR, limit\)/,
    "listing the invite inbox must be attributed to the robot, never to a null actor",
  );
  assert.match(
    deps, /openMonitorMessage\(monitorId, folder, uid, ROBOT_ACTOR\)/,
    "and opening a message must be attributed to the robot too — that row is the only account of it",
  );
  assert.match(
    deps, /lower\(monitor\.emailAddress\) === wanted/,
    "the monitor must be resolved by IDENTITY — this chooses which mailbox Phoenix is about to read",
  );
}

/** No path may put a credential in a log, a refusal or an error. */
async function runNoLeakCases(): Promise<void> {
  const secret = "SUPERSECRETTEMP";
  const fixture: Fixture = {
    bodies: { 11: body("someone.else@satopharma.com", secret) },
    listed: [listed(11, "2026-10-03T08:56:00.000Z", {
      subject: "invited you to activate [someone.else@satopharma.com]",
    })],
  };
  const { deps } = fakeDeps(fixture);
  const reading = await readInviteInbox({ address: WANTED, deps });
  assert.ok("refusal" in reading.reading, "an invitation for another mailbox must refuse");
  assert.equal(
    reading.reading.refusal.includes(secret), false,
    "a refusal must never carry the temp password it read",
  );

  const readerSource = readFileSync(
    new URL("../src/lib/new-hire-mailbox/robot/invite-inbox-reader.ts", import.meta.url), "utf8",
  );
  const readerCode = stripComments(readerSource);
  for (const banned of ["logInfo", "logError", "console.log"]) {
    assert.equal(
      readerCode.includes(banned), false,
      `the reader must not log at all (${banned}) — it holds message bodies and a credential`,
    );
  }
  assert.equal(
    /\$\{[^}]*tempPassword/.test(readerCode), false,
    "no message may interpolate the temp password",
  );
  assert.equal(
    /\$\{[^}]*\.body\b/.test(readerCode), false,
    "and no message may interpolate a message body — that is where the credential lives",
  );
}

export async function runNewHireMailboxInviteInboxReaderTests(): Promise<void> {
  await runHappyPathCases();
  await runOrderCases();
  await runNarrowingCases();
  await runWrongMailboxCases();
  await runRetryableCases();
  await runPollCases();
  runDriverSeamCases();
  runProductionWiringCases();
  await runNoLeakCases();
}
