/**
 * Adopting the invite inbox.
 *
 * 🔴 THE PROPERTY THESE CASES EXIST FOR: this flow runs a password RESET, and the same chain pointed
 * at an employee's address locks that person out of their mail with nobody told. So the address is
 * compared against the configured invite inbox and refused otherwise — it is never a choice the
 * caller makes. Most of what follows is that one rule, from every angle an argument can arrive at it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  evaluateInviteInboxAdoption,
  INVITE_INBOX_ADDRESS,
  INVITE_INBOX_LABEL,
  inviteInboxHandoverNote,
  refusedInviteInbox,
} from "@/lib/new-hire-mailbox/robot/invite-inbox";
import { runInviteInboxAdoption } from "@/lib/new-hire-mailbox/robot/invite-inbox-runner";

const COMPANY = "Company-Pass-1!";

/** The invite inbox is the mailbox Phoenix owns, and the flow is bound to it. */
function runVerdictCases(): void {
  assert.equal(INVITE_INBOX_ADDRESS, "hr.mailbox@satopharma.com");

  const allowed = evaluateInviteInboxAdoption(INVITE_INBOX_ADDRESS, COMPANY);
  assert.deepEqual(allowed, { address: "hr.mailbox@satopharma.com", allowed: true });

  // Case and padding are not identity differences.
  assert.equal(evaluateInviteInboxAdoption("  HR.Mailbox@SatoPharma.com ", COMPANY).allowed, true);

  // 🔴 EVERY OTHER ADDRESS IS REFUSED, and an employee's most of all — this chain would reset a
  // working mailbox. The near-miss pair is included because it is a real one on this domain.
  for (const other of [
    "adel.srour@satopharma.com",
    "esraa.awad@satopharma.com",
    "hr.mailbox@satopharma.com.evil.example",
    "hr.mailbox@gmail.com",
    "hr.mailboxx@satopharma.com",
    "x" + INVITE_INBOX_ADDRESS,
    "",
    null,
    undefined,
  ]) {
    const verdict = evaluateInviteInboxAdoption(other as string, COMPANY);
    assert.equal(verdict.allowed, false, `${String(other)} must be refused`);
    if (!verdict.allowed) {
      assert.equal(verdict.refusal, "not_the_invite_inbox");
      assert.match(verdict.detail, /adopts the invite inbox only/);
      assert.match(verdict.detail, /Nothing was reset/);
    }
  }

  // 🔴 A MISSING COMPANY PASSWORD IS REFUSED BEFORE THE RESET, not discovered after it — a reset
  // with no password set afterwards leaves the mailbox unreachable.
  for (const missing of ["", null, undefined]) {
    const verdict = evaluateInviteInboxAdoption(INVITE_INBOX_ADDRESS, missing as string);
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) {
      assert.equal(verdict.refusal, "no_company_password");
      assert.match(verdict.detail, /Nothing was reset/);
    }
  }

  // The handover sentence carries no credential and says the mailbox belongs to nobody.
  const note = inviteInboxHandoverNote(INVITE_INBOX_ADDRESS);
  assert.match(note, /now monitored/);
  assert.equal(note.includes(COMPANY), false, "the handover note must never carry a password");

  // refusedInviteInbox is for refusals only; handing it an allowed verdict is a programming error.
  assert.throws(() => refusedInviteInbox(allowed, false));

  assert.equal(INVITE_INBOX_LABEL.length > 0, true);
}

type Call = { kind: string; address?: string };

function fakeDriver(calls: Call[], failAt?: string) {
  return {
    createMailbox: async () => {
      throw new Error("createMailbox must not be called by the invite-inbox flow");
    },
    generateAppPassword: async ({ address }: { address: string }) => {
      calls.push({ address, kind: "generateAppPassword" });
      if (failAt === "generateAppPassword") throw new Error("app password page did not open");
      return { appPassword: "app-pass-16-chars" };
    },
    resetAndCapture: async ({ address }: { address: string }) => {
      calls.push({ address, kind: "resetAndCapture" });
      if (failAt === "resetAndCapture") throw new Error("two rows matched after filtering");
      return { address, oneTimePassword: "one-time" };
    },
    setMailboxPassword: async ({ address }: { address: string }) => {
      calls.push({ address, kind: "setMailboxPassword" });
      if (failAt === "setMailboxPassword") throw new Error("change password screen never appeared");
      return { ok: true };
    },
    signIn: async () => {
      calls.push({ kind: "signIn" });
    },
  } as unknown as Parameters<typeof runInviteInboxAdoption>[0]["driver"];
}

async function runRunnerCases(): Promise<void> {
  // ── the happy path, and the ORDER, which is itself the safety property ─────────────────────────
  const calls: Call[] = [];
  const monitored: Array<{ appPassword: string; displayLabel: string; emailAddress: string }> = [];
  const ok = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: {
      companyPassword: () => COMPANY,
      monitor: async (input) => {
        monitored.push(input);
        return { id: "monitor-1" };
      },
    },
    driver: fakeDriver(calls),
    dryRun: false,
  });
  assert.equal(ok.adopted, true);
  assert.equal(ok.address, INVITE_INBOX_ADDRESS);
  assert.match(ok.handover ?? "", /now monitored/);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["signIn", "resetAndCapture", "setMailboxPassword", "generateAppPassword"],
    "the app password can only be minted after the reset and the password set — that order is the window",
  );
  // Every console call was against the invite inbox and nothing else.
  for (const call of calls) {
    if (call.address !== undefined) assert.equal(call.address, INVITE_INBOX_ADDRESS);
  }
  // The credential went to the monitor, which is what proves it over IMAP.
  assert.deepEqual(monitored, [{
    appPassword: "app-pass-16-chars",
    displayLabel: INVITE_INBOX_LABEL,
    emailAddress: INVITE_INBOX_ADDRESS,
  }]);

  // ── 🔴 A WRONG ADDRESS NEVER REACHES THE DRIVER AT ALL ────────────────────────────────────────
  const refusedCalls: Call[] = [];
  const refused = await runInviteInboxAdoption({
    address: "esraa.awad@satopharma.com",
    deps: { companyPassword: () => COMPANY, monitor: async () => ({}) },
    driver: fakeDriver(refusedCalls),
    dryRun: false,
  });
  assert.equal(refused.adopted, false);
  assert.equal(refused.refusal, "not_the_invite_inbox");
  assert.deepEqual(refusedCalls, [], "an employee's mailbox must not even be signed in for");

  // ── a missing company password stops before the driver too ────────────────────────────────────
  const noPassCalls: Call[] = [];
  const noPass = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => "", monitor: async () => ({}) },
    driver: fakeDriver(noPassCalls),
    dryRun: false,
  });
  assert.equal(noPass.refusal, "no_company_password");
  assert.deepEqual(noPassCalls, [], "nothing may be reset without a password to set afterwards");

  // A company password the robot could not READ is treated exactly as absent, never as empty-but-fine.
  const threwCalls: Call[] = [];
  const threw = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: {
      companyPassword: () => { throw new Error("secret store unreachable"); },
      monitor: async () => ({}),
    },
    driver: fakeDriver(threwCalls),
    dryRun: false,
  });
  assert.equal(threw.refusal, "no_company_password");
  assert.deepEqual(threwCalls, []);

  // ── the dry run touches nothing ───────────────────────────────────────────────────────────────
  const dryCalls: Call[] = [];
  const dry = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => COMPANY, monitor: async () => ({}) },
    driver: fakeDriver(dryCalls),
    dryRun: true,
  });
  assert.equal(dry.adopted, false);
  assert.equal(dry.dryRun, true);
  assert.match(dry.detail ?? "", /Nothing was touched/);
  assert.deepEqual(dryCalls, [], "a dry run must not sign in");

  // ── a live run with no driver reports it rather than pretending ────────────────────────────────
  const noDriver = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => COMPANY, monitor: async () => ({}) },
    driver: null,
    dryRun: false,
  });
  assert.equal(noDriver.adopted, false);
  assert.match(noDriver.detail ?? "", /without a console driver/);

  // ── 🔴 THE MONITOR IS THE PROOF. If it refuses the credential, this is NOT adopted ─────────────
  const rejected = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: {
      companyPassword: () => COMPANY,
      monitor: async () => { throw new Error("Could not connect to that mailbox: invalid credentials"); },
    },
    driver: fakeDriver([]),
    dryRun: false,
  });
  assert.equal(rejected.adopted, false, "a credential the monitor could not connect with is not an adoption");
  assert.match(rejected.detail ?? "", /was reset and now holds the company password/);
  assert.match(rejected.detail ?? "", /still cannot read it/);

  // ── a failure BEFORE the reset says so, which is a different state to recover from ─────────────
  const earlyFail = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => COMPANY, monitor: async () => ({}) },
    driver: fakeDriver([], "resetAndCapture"),
    dryRun: false,
  });
  assert.equal(earlyFail.adopted, false);
  assert.match(earlyFail.detail ?? "", /was not reset/);

  // ── no outcome may carry a credential ─────────────────────────────────────────────────────────
  for (const result of [ok, refused, noPass, dry, rejected, earlyFail]) {
    const text = JSON.stringify(result);
    assert.equal(text.includes(COMPANY), false, "no result may carry the company password");
    assert.equal(text.includes("app-pass-16-chars"), false, "no result may carry the app password");
  }
}

/**
 * 🔴 NOTHING SCHEDULED MAY CALL THIS. The invite inbox needs adopting once; a sweep that re-ran it
 * would reset the inbox the robot is mid-way through reading and rotate a credential the monitor had
 * just proved. Same rule, same shape of assertion, as adoption's own wiring pin.
 */
function runWiringCases(): void {
  const root = new URL("../", import.meta.url);
  const scheduled = [
    "app/api/cron/mailbox-offboarding-sweep/route.ts",
    "src/lib/new-hire-mailbox/robot/sweep-hook.ts",
    "src/lib/new-hire-mailbox/robot/sweep-deps.ts",
    "src/lib/new-hire-mailbox/robot/runner.ts",
  ];
  for (const path of scheduled) {
    const source = readFileSync(new URL(path, root), "utf8");
    for (const forbidden of ["runInviteInboxAdoption", "invite-inbox-runner"]) {
      assert.equal(
        source.includes(forbidden), false,
        `${path} must not reach the invite-inbox adoption — it resets a mailbox and is a Super Admin's own action`,
      );
    }
  }

  // And the flow's address really is bound to the constant rather than re-typed as a literal.
  const flow = readFileSync(
    new URL("src/lib/new-hire-mailbox/robot/invite-inbox.ts", root),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(
    flow, /INVITE_INBOX_ADDRESS = TURBIFY_INVITE_RECIPIENT/,
    "the one mailbox this may touch must come from the invite recipient, not a second copy of the address",
  );
  // No escape hatch: a `force`/`override` parameter is how a flow that resets ONE mailbox becomes a
  // flow that resets ANY mailbox.
  //
  // 🔴 ASSERTED ON CODE, NOT PROSE, AND STRIPPED WITH THE SHARED HELPER. Two mistakes in a row here,
  // both worth the comment. First this searched the whole file for the word, and the module's own
  // comment explaining that there is no `force` or `override` made it fail. Then it filtered comments
  // line by line — which `tests/no-unsafe-comment-stripping.test.ts` refuses, because a line judged
  // by how it STARTS cannot know a comment block is already open, so the body of a multi-line
  // comment is scanned as code and real code sharing the opening line is never scanned at all.
  const code = stripComments(
    readFileSync(new URL("src/lib/new-hire-mailbox/robot/invite-inbox.ts", root), "utf8"),
  ).replace(/\s+/g, " ");
  for (const hatch of ["force", "override", "allowAnyAddress"]) {
    assert.equal(
      new RegExp(hatch + "\\s*[?:=]").test(code), false,
      `no ${hatch} parameter — that is how this becomes a reset-anything flow`,
    );
  }
}

export async function runNewHireMailboxInviteInboxTests(): Promise<void> {
  runVerdictCases();
  await runRunnerCases();
  runWiringCases();
}
