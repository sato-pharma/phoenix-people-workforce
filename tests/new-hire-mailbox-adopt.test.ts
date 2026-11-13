/**
 * Adopting an existing mailbox — what this file protects.
 *
 * Adoption RESETS the password of a mailbox somebody uses every day. Unlike the joiner flow, which
 * touches only mailboxes it just created, a mistake here locks a working employee out of their mail
 * until a human hands them a new password. So the gates are the feature, and the most important
 * assertion is that nothing outside the explicitly named list is ever touched — there is no queue
 * that could grow into a reset nobody asked for.
 *
 * The second: a mailbox Phoenix can ALREADY read is refused, because adopting it would lock the
 * person out for no gain at all.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ADOPTION_ALLOW_LIST,
  ADOPTION_MAX_PER_REQUEST,
  ADOPTION_STEP_ORDER,
  adoptionHandoverNote,
  evaluateAdoption,
  parseAdoptionRequest,
  type AdoptionCandidate,
} from "../src/lib/new-hire-mailbox/robot/adopt.ts";
import { runMailboxAdoption, type AdoptionDeps } from "../src/lib/new-hire-mailbox/robot/adopt-runner.ts";
import type { JoinerConsoleDriver } from "../src/lib/new-hire-mailbox/robot/driver.ts";

function candidate(overrides: Partial<AdoptionCandidate> = {}): AdoptionCandidate {
  return {
    address: "esraa.awad@satopharma.com",
    displayName: "Esraa Awad",
    employeeFound: true,
    hasAppPassword: false,
    hrId: "B-900",
    isActiveEmployee: true,
    taskOpen: true,
    workEmail: "esraa.awad@satopharma.com",
    ...overrides,
  };
}

const NAMED = ["esraa.awad@satopharma.com", "jonia.wageh@satopharma.com"];

/** A driver that records its calls and can be told to fail at a chosen step. */
function spyDriver(failAt?: "resetAndCapture" | "setMailboxPassword" | "generateAppPassword"): JoinerConsoleDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signIn() { calls.push("signIn"); },
    async createMailbox({ local }) { calls.push("createMailbox"); return { address: `${local}@satopharma.com`, oneTimePassword: "OTP" }; },
    async resetAndCapture({ address }) {
      calls.push(`resetAndCapture:${address}`);
      if (failAt === "resetAndCapture") throw new Error("two rows matched after filtering");
      return { address, oneTimePassword: "OTP-RESET" };
    },
    async setMailboxPassword({ address }) {
      calls.push(`setMailboxPassword:${address}`);
      if (failAt === "setMailboxPassword") throw new Error("no password field was found");
      return "done";
    },
    async generateAppPassword({ address }) {
      calls.push(`generateAppPassword:${address}`);
      if (failAt === "generateAppPassword") throw new Error("no app password could be read");
      return { appPassword: "APP-PW" };
    },
    // The read-only calibration step. Adoption must never reach it — it is triggered by hand from
    // the panel, not by a sweep — and because the call lists below are compared whole, a stray
    // call shows up as a failure rather than as an extra line nobody reads.
    async describeAppPasswords({ address }) {
      calls.push(`describeAppPasswords:${address}`);
      return { controls: [], observed: 0, reached: false, redacted: 0, why: "spy driver: nothing was read" };
    },
    // 🔴 THE MINT-AND-REMOVE REHEARSAL, WHICH NEITHER PATH MAY EVER REACH. It creates a real
    // credential on a real mailbox; a sweep or an adoption run that called it would mint one on
    // somebody's live mailbox. It is here only so this spy satisfies the driver contract, and the
    // whole-sequence call-list assertions below are what prove nothing calls it.
    async rehearseAppPasswordRemoval({ address }) {
      calls.push(`rehearseAppPasswordRemoval:${address}`);
      const nothing = { controls: [], observed: 0, reached: false, redacted: 0, why: "spy driver: nothing was read" };
      return {
        after: nothing, before: nothing, confirming: nothing, listed: nothing,
        minted: false, outstanding: false, removed: false,
        why: "spy driver: nothing was minted and nothing was removed",
      };
    },
    // The leaver register's read-only Edit-form capture. Neither path may reach it; it is here only
    // so this spy satisfies the driver contract, and the whole call lists below prove nothing calls it.
    async captureMailboxEditForm({ address }) {
      calls.push(`captureMailboxEditForm:${address}`);
      return {
        address, buttons: [], closed: null, controls: [], fields: [], headings: [], leftWith: null,
        namesAddress: null, observed: 0, reached: false, redacted: 0, scope: null, why: "spy driver: nothing was read",
      };
    },
    async close() { calls.push("close"); },
  };
}

const PATTERN = "Testco@9931";

function adoptDeps(candidates: AdoptionCandidate[], overrides: Partial<AdoptionDeps> = {}): AdoptionDeps & { recorded: string[] } {
  const recorded: string[] = [];
  return {
    companyPassword: () => PATTERN,
    loadCandidates: async () => candidates,
    record: async (input) => { recorded.push(input.address); },
    recorded,
    ...overrides,
  };
}

async function runAdoptionCases(): Promise<void> {
  const two = [
    candidate(),
    candidate({ address: "jonia.wageh@satopharma.com", displayName: "Jonia Wageh", hrId: "B-901", workEmail: "jonia.wageh@satopharma.com" }),
  ];

  // Nothing named adopts nobody, and says so rather than running an empty pass.
  const nothing = await runMailboxAdoption({ deps: adoptDeps(two), dryRun: false, driver: spyDriver(), named: [] });
  assert.equal(nothing.adopted, 0);
  assert.match(nothing.blocked ?? "", /never acts on a queue/);

  // No usable company password → nothing is reset, and no console call happens at all.
  const noPw = spyDriver();
  const blocked = await runMailboxAdoption({
    deps: adoptDeps(two, { companyPassword: () => null }), dryRun: false, driver: noPw, named: NAMED,
  });
  assert.equal(blocked.considered, 0);
  assert.deepEqual(noPw.calls, [], "no mailbox may be reset without a company password");

  // The happy path: reset, set, mint, record — in that order.
  const okDeps = adoptDeps([two[0]]);
  const okDriver = spyDriver();
  const adopted = await runMailboxAdoption({ deps: okDeps, dryRun: false, driver: okDriver, named: NAMED });
  assert.equal(adopted.adopted, 1);
  assert.equal(adopted.lockedOut, 0);
  assert.equal(
    okDriver.calls.join(" > "),
    "signIn > resetAndCapture:esraa.awad@satopharma.com > setMailboxPassword:esraa.awad@satopharma.com "
    + "> generateAppPassword:esraa.awad@satopharma.com > close",
  );
  assert.deepEqual(okDeps.recorded, ["esraa.awad@satopharma.com"]);
  assert.match(adopted.outcomes[0].handover ?? "", /change it straight away/);

  // 🔴 THE HEADLINE ASSERTION. A failure AFTER the reset leaves that person unable to read their
  // mail, so the pass STOPS instead of locking out everybody else for the same reason.
  const lockDeps = adoptDeps(two);
  const lock = await runMailboxAdoption({
    deps: lockDeps, dryRun: false, driver: spyDriver("generateAppPassword"), named: NAMED,
  });
  assert.equal(lock.lockedOut, 1, "a reset-but-unfinished mailbox is reported as locked out");
  assert.equal(lock.adopted, 0, "locked out is never counted as adopted");
  assert.equal(lock.stoppedEarly, true, "the pass must stop rather than lock out the rest");
  assert.equal(lock.outcomes.filter((o) => o.status === "locked_out").length, 1);
  assert.equal(
    lock.outcomes.some((o) => o.address === "jonia.wageh@satopharma.com"), false,
    "the second person must not be touched after the first was left locked out",
  );
  assert.deepEqual(lockDeps.recorded, [], "a locked-out run records nothing");
  assert.match(lock.outcomes[0].detail ?? "", /cannot read their mail until you give them the password/);

  // Failing BEFORE the reset is an ordinary failure — nobody is locked out, so the pass carries on.
  const safeFail = await runMailboxAdoption({
    deps: adoptDeps(two), dryRun: false, driver: spyDriver("resetAndCapture"), named: NAMED,
  });
  assert.equal(safeFail.lockedOut, 0, "nothing was reset, so nobody is locked out");
  assert.equal(safeFail.failed, 2, "both are attempted, because no one was left locked out");
  assert.equal(safeFail.stoppedEarly, false);

  // A dry run walks the steps and records nothing, and ignores a live driver if handed one.
  const dryDeps = adoptDeps([two[0]]);
  const ignored = spyDriver();
  const dry = await runMailboxAdoption({ deps: dryDeps, dryRun: true, driver: ignored, named: NAMED });
  assert.equal(dry.adopted, 1);
  assert.deepEqual(dryDeps.recorded, [], "a dry run must record nothing");
  assert.deepEqual(ignored.calls, [], "a dry run must not use a live driver even if given one");

  // A refused candidate never reaches the console.
  const refusedDriver = spyDriver();
  const refused = await runMailboxAdoption({
    deps: adoptDeps([candidate({ hasAppPassword: true })]), dryRun: false, driver: refusedDriver, named: NAMED,
  });
  assert.equal(refused.refused, 1);
  assert.deepEqual(refusedDriver.calls, [], "a refused mailbox is never reset");
}

/**
 * What the Super-Admin route accepts.
 *
 * 🔴 The headline here is the DEFAULT. A live adoption resets real mailboxes, so the one value that
 * arms it has to be sent deliberately: anything that is not the exact boolean `false` plans instead.
 * A truthy-string check would have armed a live run on `dryRun: "false"` from a hand-written request.
 */
function runRequestParsingCases(): void {
  const ok = parseAdoptionRequest({ addresses: ["  Esraa.Awad@SatoPharma.com "] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok === true ? ok.named : [], ["esraa.awad@satopharma.com"]);
  assert.equal(ok.ok === true ? ok.dryRun : null, true, "a request that says nothing about dryRun is a DRY RUN");

  // 🔴 Only the real boolean false arms a live reset.
  const live = parseAdoptionRequest({ addresses: ["a@satopharma.com"], dryRun: false });
  assert.equal(live.ok, true);
  assert.equal(live.ok === true ? live.dryRun : null, false);
  for (const sneaky of ["false", 0, null, undefined, "", "no"]) {
    const parsed = parseAdoptionRequest({ addresses: ["a@satopharma.com"], dryRun: sneaky });
    assert.equal(parsed.ok === true ? parsed.dryRun : null, true, `dryRun: ${JSON.stringify(sneaky)} must NOT arm a live run`);
  }

  // Nothing named is refused, never treated as "adopt the queue".
  assert.equal(parseAdoptionRequest({ addresses: [] }).ok, false);
  assert.equal(parseAdoptionRequest({}).ok, false);
  assert.equal(parseAdoptionRequest({ addresses: "a@satopharma.com" }).ok, false, "a bare string is not a list");
  assert.equal(parseAdoptionRequest(null).ok, false);

  // A non-string entry is refused rather than filtered out: silently dropping one from a list of
  // mailboxes to reset means the caller is told about work that never happened.
  const mixed = parseAdoptionRequest({ addresses: ["a@satopharma.com", 7] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok === false ? mixed.message : "", /non-empty string/);
  assert.equal(parseAdoptionRequest({ addresses: ["a@satopharma.com", "   "] }).ok, false);

  // The same mailbox twice would reset it twice; the second reset would find a password it did not
  // issue, so it is refused up front rather than half-working.
  assert.equal(parseAdoptionRequest({ addresses: ["a@satopharma.com", "A@satopharma.com"] }).ok, false);

  // The cap is refused, never truncated.
  const many = Array.from({ length: ADOPTION_MAX_PER_REQUEST + 1 }, (_, i) => `p${i}@satopharma.com`);
  const capped = parseAdoptionRequest({ addresses: many });
  assert.equal(capped.ok, false);
  assert.match(capped.ok === false ? capped.message : "", /At most 5/);
  assert.equal(parseAdoptionRequest({ addresses: many.slice(0, ADOPTION_MAX_PER_REQUEST) }).ok, true);
}

/**
 * How adoption is wired, read from the source rather than taken on trust.
 *
 * 🔴 THE PROPERTY THIS PINS IS "NOTHING ON A SCHEDULE CAN REACH ADOPTION". Everything else here is
 * a gate that refuses a bad candidate; this is the one that stops the whole mechanism from being
 * pointed at a queue. A future session wiring the adoption runner into the daily sweep — which is
 * the obvious-looking way to "finish the job" for the remaining four mailboxes — would reset working
 * employees' passwords unattended, overnight, with nobody told. The comments say not to. This fails.
 *
 * It reads the files because that is the only way to assert a NEGATIVE about wiring: a unit test can
 * prove what a function does, never that nothing else calls it.
 */
function runRouteWiringCases(): void {
  const root = new URL("../", import.meta.url);
  const read = (relative: string): string => readFileSync(new URL(relative, root), "utf8");

  // The route gates on the System Administrator check, not on the HR grant that the sibling
  // new-hire-mailbox route uses. Swapping it for `mailbox_offboarding` would hand the reset to HR
  // Advisory and HR Operations, who cannot read the hand-over password afterwards.
  const route = read("app/api/new-hire-mailboxes/adopt/route.ts");
  assert.match(route, /canReadInitialPassword\(access\.role\)/, "the adopt route must gate on the System Administrator check");
  assert.equal(
    /assertPermission\(/.test(route), false,
    "the adopt route must NOT fall back to a permission-matrix grant — Super Admin alone",
  );
  // The live run is armed through the parser, never from a field read straight off the body.
  assert.match(route, /parseAdoptionRequest\(/);
  assert.equal(/body\.dryRun|\.dryRun === false/.test(route), false, "dryRun must only be decided in parseAdoptionRequest");

  // The page hides the card on the same check the route enforces. If it used `mailbox_offboarding`
  // the card would appear for HR, who would then get a 403 — or worse, somebody would "fix" the
  // mismatch by widening the route.
  const page = read("app/(admin)/new-hire-mailboxes/page.tsx");
  assert.match(page, /canAdopt = canReadInitialPassword\(access\.role\)/);
  assert.match(page, /canAdopt=\{canAdopt\}/);

  // The card arms a live run ONLY in the branch that says so. `dryRun: false` must appear exactly
  // once in it: a second occurrence means some other button can reset a mailbox.
  const card = read("src/components/new-hire-mailbox/adopt-mailbox-card.tsx");
  assert.equal(
    (card.match(/dryRun: false/g) ?? []).length, 1,
    "exactly one place in the card may arm a live reset",
  );
  // And the password never reaches the browser: the card renders the hand-over sentence, not a value.
  assert.equal(
    /initialPassword|sealed_initial_password|revealInitialPassword/.test(card), false,
    "the adopt card must never handle a mailbox password",
  );

  // 🔴 THE HEADLINE. No cron route, and no sweep hook, may import the adoption runner or its ports.
  const scheduled = [
    "app/api/cron/mailbox-offboarding-sweep/route.ts",
    "app/api/cron/mailbox-robots/route.ts",
    "src/lib/new-hire-mailbox/robot/sweep-hook.ts",
    "src/lib/new-hire-mailbox/robot/sweep-deps.ts",
    "src/lib/new-hire-mailbox/robot/runner.ts",
  ];
  for (const file of scheduled) {
    const source = read(file);
    assert.equal(
      /adopt-runner|adopt-deps|runMailboxAdoption/.test(source), false,
      `${file} runs on a schedule and must never reach adoption — a reset locks a working employee out`,
    );
  }
}

export async function runNewHireMailboxAdoptTests(): Promise<void> {
  runGateCases();
  runRequestParsingCases();
  runRouteWiringCases();
  await runAdoptionCases();
}

function runGateCases(): void {
  // The happy path, so every refusal below is attributable to the one thing it changed.
  const ok = evaluateAdoption(candidate(), NAMED);
  assert.equal(ok.allowed, true);
  assert.equal(ok.allowed === true ? ok.address : "", "esraa.awad@satopharma.com");

  // 🔴 THE HEADLINE ASSERTION. Nothing outside the named list is ever touched. This is what stops a
  // reset reaching a mailbox nobody asked about — and a reset locks a working employee out.
  for (const address of ["taha.sheeba@satopharma.com", "ahmed.abdallah@satopharma.com", ""]) {
    const v = evaluateAdoption(candidate({ address, workEmail: address }), NAMED);
    assert.equal(v.allowed, false, `${address || "(blank)"} must not be adopted — it was not named`);
    assert.equal(v.allowed === false ? v.refusal : "", "not_in_named_list");
  }
  // An empty named list adopts NOBODY, whatever the candidate looks like.
  assert.equal(evaluateAdoption(candidate(), []).allowed, false, "an empty list must adopt nobody");
  // And the shipped constant IS empty, so no caller inherits a list by accident.
  assert.deepEqual([...ADOPTION_ALLOW_LIST], [], "the shipped allow-list must be empty");

  // 🔴 A mailbox Phoenix can already read is refused: resetting it would lock the person out for
  // nothing, which is pure harm with no gain.
  const already = evaluateAdoption(candidate({ hasAppPassword: true }), NAMED);
  assert.equal(already.allowed, false);
  assert.equal(already.allowed === false ? already.refusal : "", "already_has_app_password");
  assert.match(already.allowed === false ? already.detail : "", /lock Esraa Awad out for nothing/);

  // The address must be THAT employee's recorded work email — resetting somebody else's mailbox
  // because their address happened to be named is the worst outcome available here.
  const notTheirs = evaluateAdoption(
    candidate({ workEmail: "someone.else@satopharma.com" }),
    NAMED,
  );
  assert.equal(notTheirs.allowed, false);
  assert.equal(notTheirs.allowed === false ? notTheirs.refusal : "", "address_not_theirs");
  const noEmail = evaluateAdoption(candidate({ workEmail: null }), NAMED);
  assert.equal(noEmail.allowed === false ? noEmail.refusal : "", "address_not_theirs");

  // 🔴 A TYPO'D ADDRESS IS REFUSED FOR THE REASON IT ACTUALLY FAILED, and the sentence does not
  // assert anything about a person who does not exist. This is the distinction `employeeFound`
  // exists for: without it the gate below would report a typo as "is not an active employee".
  const typo = evaluateAdoption(
    candidate({
      address: "esra.award@satopharma.com",
      displayName: "esra.award@satopharma.com",
      employeeFound: false,
      isActiveEmployee: false,
      taskOpen: false,
      workEmail: null,
    }),
    ["esra.award@satopharma.com"],
  );
  assert.equal(typo.allowed, false);
  assert.equal(typo.allowed === false ? typo.refusal : "", "no_such_mailbox");
  assert.match(typo.allowed === false ? typo.detail : "", /No employee on the master has esra\.award@/);

  // A leaver is the revocation robot's business, not this one's.
  const gone = evaluateAdoption(candidate({ isActiveEmployee: false }), NAMED);
  assert.equal(gone.allowed === false ? gone.refusal : "", "not_an_active_employee");

  // Nothing is asking for it.
  const noTask = evaluateAdoption(candidate({ taskOpen: false }), NAMED);
  assert.equal(noTask.allowed === false ? noTask.refusal : "", "no_open_task");

  // A non-company address is refused even when named.
  const outside = evaluateAdoption(
    candidate({ address: "esraa.awad@gmail.com", workEmail: "esraa.awad@gmail.com" }),
    ["esraa.awad@gmail.com"],
  );
  assert.equal(outside.allowed === false ? outside.refusal : "", "not_a_company_address");

  // Case and surrounding space in the named list do not let one through or keep one out.
  assert.equal(evaluateAdoption(candidate(), ["  ESRAA.AWAD@SATOPHARMA.COM  "]).allowed, true);

  // The order is pinned: the reset comes first, because it is what reopens the window, and the app
  // password is minted last, because it is the only step that cannot be retried later.
  assert.deepEqual([...ADOPTION_STEP_ORDER], ["resetPassword", "setMailboxPassword", "generateAppPassword"]);

  // The hand-over note says the two things the employee must be told, including that changing their
  // password afterwards does NOT break Phoenix — the fact that makes this safe to do at all.
  const note = adoptionHandoverNote("Esraa Awad", "esraa.awad@satopharma.com");
  assert.match(note, /cannot sign in/);
  assert.match(note, /change it straight away/);
  assert.match(note, /app password survives a password change/);
}
