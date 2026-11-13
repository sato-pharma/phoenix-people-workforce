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
  assert.match(rejected.detail ?? "", /MAY ALREADY HAVE BEEN RESET/);
  // 🔴 THIS ASSERTION USED TO DEMAND THE OPPOSITE — `/Phoenix cannot read the mailbox/` — and that
  // claim was measured FALSE on 2026-10-04: `hr.mailbox@satopharma.com` passed a real IMAP login at
  // 00:19:54 Cairo, minutes after a failed run printed it to the owner. A reset rotates the
  // MAILBOX's own password; an app password already stored with the monitor survives it. So the
  // refusal must now state the narrower truth, and this suite pins that rather than the old one.
  assert.equal(
    /cannot read the mailbox/.test(rejected.detail ?? ""), false,
    "this refusal must not say Phoenix cannot read the mailbox — a monitor already holding an app "
    + "password keeps working through a reset, and saying otherwise sent the owner to rescue access "
    + "that had never been lost",
  );
  assert.match(
    rejected.detail ?? "", /an app password survives a password change/,
    "it must say an app password survives a password change, which is what makes reading the mailbox "
    + "a separate question from the mailbox's own password",
  );
  assert.match(
    rejected.detail ?? "", /read the Mailbox Monitor page before assuming access was lost/,
    "and it must point at the page that answers whether access was actually lost",
  );

  // ── 🔴 A FAILURE INSIDE `resetAndCapture` MUST NOT CLAIM THE MAILBOX WAS UNTOUCHED ─────────────
  // The reset is CLICKED inside that step, before the dialog is read, so anything it throws leaves
  // the mailbox possibly reset. The first version of this reported "was not reset" — and that is
  // exactly what the owner was told on 2026-10-03 about a mailbox Turbify had in fact just reset,
  // which sent him looking for the wrong problem. The flag may only ever OVERSTATE the damage.
  const earlyFail = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => COMPANY, monitor: async () => ({}) },
    driver: fakeDriver([], "resetAndCapture"),
    dryRun: false,
  });
  assert.equal(earlyFail.adopted, false);
  assert.match(earlyFail.detail ?? "", /MAY ALREADY HAVE BEEN RESET/);
  assert.equal(
    (earlyFail.detail ?? "").includes("was not reset"), false,
    "a reset-step failure may never report the mailbox as untouched",
  );

  // Only a refusal reached BEFORE the driver was ever called may say nothing was reset — and those
  // return a refusal rather than a detail, which the cases above already pin.

  // ── 🔴 THE APP PASSWORD MAY NOT FAIL THIS ADOPTION ────────────────────────────────────────────
  // It sat on the critical path while being the one step nothing had ever reached, so its failure
  // reported "MAY ALREADY HAVE BEEN RESET" over work that had actually SUCCEEDED — reset done,
  // company password set — and sent the owner back to click again. Five times.
  //
  // Phoenix owns this inbox and nobody rotates its password, so the app password's one advantage
  // (surviving a password change) buys nothing HERE. The monitor still has to log in, so this
  // cannot become a false success.
  const appFailCalls: Call[] = [];
  const appFailMonitored: Array<{ appPassword: string; displayLabel: string; emailAddress: string }> = [];
  const appFail = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: {
      companyPassword: () => COMPANY,
      monitor: async (input) => {
        appFailMonitored.push(input);
        return { id: "monitor-2" };
      },
    },
    driver: fakeDriver(appFailCalls, "generateAppPassword"),
    dryRun: false,
  });
  assert.equal(
    appFail.adopted, true,
    "the app-password step must not fail an adoption whose reset and password-set both succeeded",
  );
  assert.deepEqual(
    appFailCalls.map((c) => c.kind),
    ["signIn", "resetAndCapture", "setMailboxPassword", "generateAppPassword"],
    "it is still attempted — the fallback is what happens after it fails, not instead of trying",
  );
  assert.deepEqual(
    appFailMonitored,
    [{ appPassword: COMPANY, displayLabel: INVITE_INBOX_LABEL, emailAddress: INVITE_INBOX_ADDRESS }],
    "the credential proven over IMAP is the company password the robot just set",
  );
  assert.match(appFail.detail ?? "", /No app password could be minted/);
  assert.match(appFail.detail ?? "", /app password page did not open/, "it reports WHY, not just that");
  assert.equal(
    (appFail.detail ?? "").includes("MAY ALREADY HAVE BEEN RESET"), false,
    "a completed adoption may never carry the not-finished warning",
  );

  // 🔴 AND THE MONITOR IS STILL THE GATE ON THAT PATH. App password failed AND the company password
  // refused over IMAP → not adopted. Without this, the fallback would be a way to claim success.
  const bothFail = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: {
      companyPassword: () => COMPANY,
      monitor: async () => { throw new Error("Could not connect to that mailbox: invalid credentials"); },
    },
    driver: fakeDriver([], "generateAppPassword"),
    dryRun: false,
  });
  assert.equal(
    bothFail.adopted, false,
    "falling back to the company password must still prove it over IMAP, or it is not an adoption",
  );
  assert.match(bothFail.detail ?? "", /MAY ALREADY HAVE BEEN RESET/);

  // 🔴 THE FALLBACK IS SCOPED TO THIS MAILBOX. An EMPLOYEE changes their password at handover, so
  // for them the app password is the only credential that survives — those runners must still treat
  // a failure as fatal, and must never grow this fallback.
  const root = new URL("../", import.meta.url);
  assert.ok(
    readFileSync(new URL("src/lib/new-hire-mailbox/robot/invite-inbox-runner.ts", root), "utf8")
      .includes("appPassword ?? companyPassword"),
    "this runner falls back to the company password",
  );
  for (const path of [
    "src/lib/new-hire-mailbox/robot/runner.ts",
    "src/lib/new-hire-mailbox/robot/adopt-runner.ts",
  ]) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.ok(
      source.includes("const { appPassword } = await"),
      `${path} must keep requiring the app password — an employee's own password change kills the other one`,
    );
    assert.equal(
      source.includes("?? companyPassword"), false,
      `${path} must not fall back to the company password — the employee will change it`,
    );
  }

  // ── 🔴 A PASSWORD TURBIFY WILL REJECT IS REFUSED **BEFORE** THE RESET ──────────────────────────
  // Their help states the rule five times over (SLN29262): 8–20 characters with an uppercase, a
  // lowercase, a number and a special character. Set one their form rejects and the mailbox is left
  // reachable only through a one-time password nothing captured — the same disaster as resetting
  // with no password at all, which this flow has always refused up front.
  for (const [bad, rule] of [
    ["Ab1!", "between 8 and 20 characters"],
    ["Abcdefgh1!Abcdefgh1!Abc", "between 8 and 20 characters"],
    ["company-pass-1!", "an uppercase letter"],
    ["COMPANY-PASS-1!", "a lowercase letter"],
    ["Company-Pass!", "a number"],
    ["CompanyPass1", "a special character"],
  ] as const) {
    const badCalls: Call[] = [];
    const result = await runInviteInboxAdoption({
      address: INVITE_INBOX_ADDRESS,
      deps: { companyPassword: () => bad, monitor: async () => ({}) },
      driver: fakeDriver(badCalls),
      dryRun: false,
    });
    assert.equal(result.refusal, "company_password_rejected_by_turbify", `${rule} must be refused`);
    assert.match(result.detail ?? "", new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(badCalls, [], "a password Turbify rejects must be caught BEFORE anything is reset");
    assert.equal(
      (result.detail ?? "").includes(bad), false,
      "a refusal about the password may never quote the password",
    );
  }

  // 🔴 AND IT MUST **NOT** REFUSE ON THE AMBIGUOUS RULE. Turbify also says "no repeated characters"
  // without saying whether that means consecutively or anywhere. Both readings reject ordinary
  // passwords — `Company-Pass-1!` fails either one — so enforcing a guess here would block an
  // adoption Turbify would have accepted. The form's own error answers that instead.
  //
  // 🔴 THE REAL PIN IS THE LINE BELOW, not the case after it. Every case in this suite runs on
  // `COMPANY`, which CONTAINS a repeated character — so the moment anything starts enforcing that
  // rule, the happy path at the top of this function goes red before the case below is reached.
  // Asserting it here is what stops someone "tidying" COMPANY into a repeat-free value and silently
  // deleting the protection. Measured 2026-10-03: breaking the rule back in fails this suite at the
  // happy path's call-order check, which is exactly the intended alarm.
  assert.ok(
    new Set(COMPANY).size !== COMPANY.length,
    "the suite's company password must keep a repeated character — it is what pins the ambiguous "
    + "rule as deliberately unenforced",
  );
  const repeated: Call[] = [];
  const withRepeats = await runInviteInboxAdoption({
    address: INVITE_INBOX_ADDRESS,
    deps: { companyPassword: () => "Company-Pass-1!", monitor: async () => ({}) },
    driver: fakeDriver(repeated),
    dryRun: false,
  });
  assert.equal(
    withRepeats.adopted, true,
    "a repeated character must not refuse the run — the reading is ambiguous and the form decides",
  );
  assert.ok(repeated.length > 0, "it must actually have been attempted");

  // ── no outcome may carry a credential ─────────────────────────────────────────────────────────
  for (const result of [ok, refused, noPass, dry, rejected, earlyFail, appFail, bothFail]) {
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
    "app/api/cron/mailbox-robots/route.ts",
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

/**
 * 🔴 THE REASON A RUN FAILED MUST REACH THE AUDIT ROW, AND THE CREDENTIAL MUST NOT.
 *
 * Measured on 2026-10-03. Two live invite-inbox runs failed that night and both audit rows read
 * `adopted: false`, `refusal: null`, `dryRun: false` — nothing else. `refusal` is the pure gate's
 * enum, so it is null on every run the gate ALLOWED, which is every run that actually reached
 * Turbify. The sentence naming the control that stopped it existed only on the screen of whoever
 * clicked, and had to be copied out of the browser by hand before anyone could read it.
 *
 * `detail` is that sentence, and it is built from redacted page text — addresses, labels, and value
 * LENGTHS. `handover` is not: for a new hire the company password becomes their real password, so
 * the hand-over sentence is the one field here that can carry a credential. Hence both halves below.
 */
function runAuditCases(): void {
  const root = new URL("../", import.meta.url);
  // The audit rows are written by the ONE shared action each route runs, on the website while the robot
  // service is off and on the robot service once it is on (audit REC-075).
  const routes = [
    "src/lib/new-hire-mailbox/robot/actions/invite-inbox-action.ts",
    "src/lib/new-hire-mailbox/robot/actions/adopt-action.ts",
  ];

  for (const path of routes) {
    // 🔴 STRIPPED, AND THAT IS NOT A FORMALITY HERE. The comment this test exists to describe says
    // the words "handover" and "detail" out loud, in the very file being read — so a raw-source
    // negative would fail on the prose, and a raw-source positive would pass on it.
    const code = stripComments(readFileSync(new URL(path, root), "utf8")).replace(/\s+/g, " ");

    const audited = /newValues:\s*\{([\s\S]*?)\}\s*,\s*summary:/.exec(code);
    assert.ok(
      audited !== null,
      `${path}: could not find the audited newValues block, so this test is reading nothing — `
      + "fix the test before trusting it",
    );
    const newValues = audited[1];

    assert.match(
      newValues, /detail/,
      `${path}: the audit row must carry the reason, not only the verdict — a row reading `
      + "adopted:false with refusal:null is unactionable a day later, and that is exactly what the "
      + "two failed live runs of 2026-10-03 stored",
    );
    assert.equal(
      /handover/.test(newValues), false,
      `${path}: the hand-over sentence may NEVER enter an audit row — for a new hire the company `
      + "password becomes their real password, so that field can carry a credential where detail "
      + "cannot",
    );
  }
}

export async function runNewHireMailboxInviteInboxTests(): Promise<void> {
  runVerdictCases();
  await runRunnerCases();
  runWiringCases();
  runAuditCases();
}
