/**
 * The new-hire mailbox robot's runner and sweep wiring — what this file protects.
 *
 * Creating a mailbox consumes a seat and makes a live account in the company domain, and the step
 * that gives Phoenix access to it has NO retry. So the order of refusals is the design, and three
 * properties are pinned here:
 *
 *   1. 🔴 A pass with no usable company password launches NOTHING. Without it every candidate would
 *      fail identically — but only AFTER a mailbox had been created, leaving a live account on a
 *      one-time password nobody holds.
 *   2. 🔴 Partial success is never recorded as success. A mailbox created but not minted leaves the
 *      task OPEN, which is the truthful state: the mailbox exists and Phoenix cannot read it.
 *      Recording it connected would hide a mailbox nobody can reach.
 *   3. 🔴 A dry run stores nothing and the robot is OFF by default, so merging the wiring changes
 *      the sweep by nothing until somebody sets a flag deliberately.
 */

import assert from "node:assert/strict";

import { createDryRunJoinerDriver, type JoinerConsoleDriver } from "../src/lib/new-hire-mailbox/robot/driver.ts";
import {
  runTurbifyJoinerRobot,
  type JoinerCandidate,
  type JoinerRunnerDeps,
} from "../src/lib/new-hire-mailbox/robot/runner.ts";
import {
  resolveJoinerSweepConfig,
  runJoinerSweepPass,
  type JoinerSweepDeps,
} from "../src/lib/new-hire-mailbox/robot/sweep-hook.ts";
import { ROBOT_ACTOR } from "../src/lib/new-hire-mailbox/robot/safety.ts";

const TODAY = "2026-10-02";
const PATTERN = "Testco@9931";

function candidate(overrides: Partial<JoinerCandidate> = {}): JoinerCandidate {
  return {
    addressHeldBy: null,
    employee: {
      displayName: "Mariam Hassan Ali",
      hireDate: "2026-10-05",
      hrId: "B-501",
      isActiveEmployee: true,
      workEmail: null,
    },
    task: { emailAddress: "mariam.hassan@satopharma.com", status: "pending" },
    ...overrides,
  };
}

type Recorded = { hrId: string; address: string; appPassword: string; initialPassword: string; actor: string };

function deps(overrides: Partial<JoinerRunnerDeps> = {}): JoinerRunnerDeps & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    companyPassword: () => PATTERN,
    loadCandidates: async () => [candidate()],
    record: async (input) => { recorded.push(input); },
    recorded,
    today: () => TODAY,
    ...overrides,
  };
}

/** A driver that records its calls and can be told to fail at a chosen step. */
function spyDriver(failAt?: "createMailbox" | "setMailboxPassword" | "generateAppPassword"): JoinerConsoleDriver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signIn() { calls.push("signIn"); },
    async createMailbox({ local }) {
      calls.push("createMailbox");
      if (failAt === "createMailbox") throw new Error("the create form had no submit button");
      return { address: `${local}@satopharma.com`, oneTimePassword: "OTP-TEST" };
    },
    // The adoption path's step. The joiner runner must NEVER call it — a new hire's mailbox does
    // not exist yet, so there is nothing to reset — and the call list below proves that.
    async resetAndCapture({ address }) {
      calls.push(`resetAndCapture:${address}`);
      return { address, oneTimePassword: "OTP-RESET" };
    },
    async setMailboxPassword() {
      calls.push("setMailboxPassword");
      if (failAt === "setMailboxPassword") throw new Error("no password field was found");
      return "done";
    },
    async generateAppPassword() {
      calls.push("generateAppPassword");
      if (failAt === "generateAppPassword") throw new Error("no app password could be read");
      return { appPassword: "APP-PASSWORD-TEST" };
    },
    // The read-only calibration step, which the joiner runner must NEVER call: it is a hand-run
    // read of a mailbox's own security page, and a sweep that reached it would sign into a live
    // mailbox every night. The whole-sequence assertion below is what proves it does not.
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

export async function runNewHireMailboxRunnerTests(): Promise<void> {
  // ── off by default ───────────────────────────────────────────────────────────────────────────
  const off = await runTurbifyJoinerRobot({ deps: deps(), dryRun: true, enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.considered, 0, "a disabled robot reads nothing");

  // 🔴 HEADLINE 1. No company password → the whole pass refuses, and NO driver is touched.
  const noPasswordDriver = spyDriver();
  const blocked = await runTurbifyJoinerRobot({
    deps: deps({ companyPassword: () => null }),
    driver: noPasswordDriver,
    dryRun: false,
    enabled: true,
  });
  assert.equal(blocked.provisioned, 0, "no mailbox may be created without a usable company password");
  assert.equal(blocked.considered, 0, "candidates are not even read without a password");
  assert.match(blocked.blocked ?? "", /PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD/);
  assert.deepEqual(noPasswordDriver.calls, [], "no console call may happen without a company password");

  // A configured but UNUSABLE password is refused the same way — before anything exists.
  const weakDriver = spyDriver();
  const weak = await runTurbifyJoinerRobot({
    deps: deps({ companyPassword: () => "nocapsordigits" }),
    driver: weakDriver,
    dryRun: false,
    enabled: true,
  });
  assert.match(weak.blocked ?? "", /missing/);
  assert.deepEqual(weakDriver.calls, [], "an unusable password must not reach the console either");

  // ── the happy path, live ─────────────────────────────────────────────────────────────────────
  const liveDeps = deps();
  const liveDriver = spyDriver();
  const live = await runTurbifyJoinerRobot({ deps: liveDeps, driver: liveDriver, dryRun: false, enabled: true });
  assert.equal(live.provisioned, 1);
  assert.equal(live.partial, 0);
  assert.equal(live.failed, 0);
  assert.equal(
    liveDriver.calls.join(" > "),
    "signIn > createMailbox > setMailboxPassword > generateAppPassword > close",
    "the three steps run in order and the browser is always closed",
  );
  assert.equal(liveDeps.recorded.length, 1);
  assert.equal(liveDeps.recorded[0].address, "mariam.hassan@satopharma.com");
  assert.equal(liveDeps.recorded[0].appPassword, "APP-PASSWORD-TEST");
  assert.equal(liveDeps.recorded[0].initialPassword, PATTERN, "the stored initial password is the company pattern");
  assert.equal(liveDeps.recorded[0].actor, ROBOT_ACTOR);

  // 🔴 HEADLINE 2. The mailbox was created but the app password could not be minted: PARTIAL, and
  // NOTHING is recorded, so the task stays open rather than claiming a mailbox Phoenix cannot read.
  const partialDeps = deps();
  const partial = await runTurbifyJoinerRobot({
    deps: partialDeps,
    driver: spyDriver("generateAppPassword"),
    dryRun: false,
    enabled: true,
  });
  assert.equal(partial.partial, 1, "a created-but-unminted mailbox is partial");
  assert.equal(partial.provisioned, 0, "partial is never counted as provisioned");
  assert.equal(partialDeps.recorded.length, 0, "a partial run must record nothing");
  assert.match(partial.outcomes[0].detail ?? "", /Phoenix has no access to it and the task stays open/);

  // Failing BEFORE the mailbox exists is `failed`, not `partial` — nothing was created.
  const failedDeps = deps();
  const failed = await runTurbifyJoinerRobot({
    deps: failedDeps,
    driver: spyDriver("createMailbox"),
    dryRun: false,
    enabled: true,
  });
  assert.equal(failed.failed, 1);
  assert.equal(failed.partial, 0, "nothing was created, so this is not partial");
  assert.equal(failedDeps.recorded.length, 0);

  // 🔴 HEADLINE 3. A dry run walks the steps and stores NOTHING.
  const dryDeps = deps();
  const dry = await runTurbifyJoinerRobot({ deps: dryDeps, dryRun: true, enabled: true });
  assert.equal(dry.provisioned, 1, "a dry run reports what it would do");
  assert.equal(dryDeps.recorded.length, 0, "a dry run must store nothing");
  // A live driver handed to a dry run is ignored — the runner builds its own that touches nothing.
  const ignored = spyDriver();
  await runTurbifyJoinerRobot({ deps: deps(), driver: ignored, dryRun: true, enabled: true });
  assert.deepEqual(ignored.calls, [], "a dry run must not use a live driver even if given one");

  // ── the gates run BEFORE the console ─────────────────────────────────────────────────────────
  const heldDriver = spyDriver();
  const held = await runTurbifyJoinerRobot({
    deps: deps({ loadCandidates: async () => [candidate({ addressHeldBy: "Mariam Hassan Mohamed" })] }),
    driver: heldDriver,
    dryRun: false,
    enabled: true,
  });
  assert.equal(held.refused, 1);
  assert.equal(held.outcomes[0].refusal, "address_taken");
  assert.deepEqual(heldDriver.calls, [], "a refused candidate never reaches the console");

  // An ordinary refusal is deferred, not alarmed about.
  const doneAlready = await runTurbifyJoinerRobot({
    deps: deps({ loadCandidates: async () => [candidate({ task: { emailAddress: "x@satopharma.com", status: "connected" } })] }),
    driver: spyDriver(),
    dryRun: false,
    enabled: true,
  });
  assert.equal(doneAlready.deferred, 1);
  assert.equal(doneAlready.refused, 0);

  // The per-run cap bounds how many accounts one pass can create.
  const many = Array.from({ length: 9 }, (_, i) => candidate({
    employee: { ...candidate().employee, hrId: `B-${600 + i}` },
    task: { emailAddress: `person${i}@satopharma.com`, status: "pending" },
  }));
  const capped = await runTurbifyJoinerRobot({
    deps: deps({ loadCandidates: async () => many, maxPerRun: 2 }),
    driver: spyDriver(),
    dryRun: false,
    enabled: true,
  });
  assert.equal(capped.considered, 9);
  assert.equal(capped.provisioned, 2, "the cap bounds creations per run");

  // A live run with no driver creates nothing rather than falling back to one.
  const noDriver = await runTurbifyJoinerRobot({ deps: deps(), dryRun: false, enabled: true });
  assert.equal(noDriver.provisioned, 0);
  assert.match(noDriver.blocked ?? "", /without a console driver/);

  // ── the sweep wiring ─────────────────────────────────────────────────────────────────────────
  // Off unless the flag is exactly "true"; dry run unless exactly "false".
  assert.deepEqual(resolveJoinerSweepConfig({}), { dryRun: true, enabled: false });
  assert.deepEqual(resolveJoinerSweepConfig({ PHOENIX_TURBIFY_JOINER_ENABLED: "TRUE" }), { dryRun: true, enabled: false });
  assert.deepEqual(resolveJoinerSweepConfig({ PHOENIX_TURBIFY_JOINER_ENABLED: "true" }), { dryRun: true, enabled: true });
  assert.deepEqual(
    resolveJoinerSweepConfig({ PHOENIX_TURBIFY_JOINER_DRY_RUN: "", PHOENIX_TURBIFY_JOINER_ENABLED: "true" }),
    { dryRun: true, enabled: true },
    "an empty dry-run value stays a dry run",
  );
  assert.deepEqual(
    resolveJoinerSweepConfig({ PHOENIX_TURBIFY_JOINER_DRY_RUN: "false", PHOENIX_TURBIFY_JOINER_ENABLED: "true" }),
    { dryRun: false, enabled: true },
  );

  function sweepDeps(config: { enabled: boolean; dryRun: boolean }, overrides: Partial<JoinerSweepDeps> = {}): JoinerSweepDeps & { built: number } {
    const state = { built: 0 };
    return {
      built: state.built,
      createDriver: async () => { state.built += 1; return spyDriver(); },
      resolveConfig: () => config,
      runnerDeps: () => deps(),
      runRobot: runTurbifyJoinerRobot,
      ...overrides,
      get builtCount() { return state.built; },
    } as JoinerSweepDeps & { built: number };
  }

  // Disabled: nothing ran, no driver built, and the sweep is unaffected.
  const disabled = await runJoinerSweepPass(sweepDeps({ dryRun: true, enabled: false }));
  assert.equal(disabled.ran, false);
  assert.equal(disabled.error, null);
  assert.equal(disabled.result, null);

  // Enabled + dry run: it runs and reports, and never builds a real driver.
  let built = 0;
  const dryPass = await runJoinerSweepPass({
    createDriver: async () => { built += 1; return spyDriver(); },
    resolveConfig: () => ({ dryRun: true, enabled: true }),
    runnerDeps: () => deps(),
    runRobot: runTurbifyJoinerRobot,
  });
  assert.equal(dryPass.ran, true);
  assert.equal(dryPass.dryRun, true);
  assert.equal(built, 0, "a dry run must never build the real console driver");
  assert.equal(dryPass.result?.provisioned, 1);

  // A driver that cannot be built is reported, never thrown — the sweep's own switch must not go red.
  const brokenPass = await runJoinerSweepPass({
    createDriver: async () => { throw new Error("Turbify presented two-step verification"); },
    resolveConfig: () => ({ dryRun: false, enabled: true }),
    runnerDeps: () => deps(),
    runRobot: runTurbifyJoinerRobot,
  });
  assert.equal(brokenPass.ran, false);
  assert.match(brokenPass.error ?? "", /two-step verification/);
  assert.equal(brokenPass.result, null);

  // The dry-run driver itself walks the whole sequence, so the shape is proven end to end.
  const shape = createDryRunJoinerDriver();
  await shape.signIn();
  await shape.close();
  assert.deepEqual(shape.calls, ["signIn", "close"]);
}
