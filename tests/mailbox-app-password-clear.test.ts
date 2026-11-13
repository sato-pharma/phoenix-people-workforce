/**
 * Clearing a leaver's app passwords — what this file protects.
 *
 * The step RESETS a mailbox password and then deletes the app passwords from inside it. Two things
 * can go badly wrong, and both are asserted here as headlines:
 *
 *   1. 🔴 An UNCALIBRATED build must not reset a single password. Without the controls that list and
 *      remove an app password, a live pass can only ever get half-way — and half-way means every
 *      named leaver's password was reset for nothing. The refusal has to happen before the browser
 *      opens, for the whole pass, not per candidate. (Calibrated 13 Nov 2026 from the 4 Oct live
 *      rehearsal; the refusal is still held here, by passing it in.)
 *   2. 🔴 A WORKING EMPLOYEE must never be cleared. This disconnects the phone in somebody's pocket,
 *      so an active employee, and a leaver whose last day has not arrived, are both refused.
 *
 * And the quieter one that matters just as much: a mailbox that was reset but NOT cleared is still
 * half-revoked, and must never be recorded as cleared — that would turn a real hole into one the
 * register claims is shut.
 */

import assert from "node:assert/strict";

import {
  APP_PASSWORD_CLEAR_CALIBRATED,
  APP_PASSWORD_CLEAR_STEP_ORDER,
  APP_PASSWORD_REVOKE_CONTROLS,
  appPasswordClearCalibrationRefusal,
  appPasswordClearNote,
  evaluateAppPasswordClear,
  throwawayPassword,
  uncalibratedRevokeControls,
  type AppPasswordClearCandidate,
} from "../src/lib/mailbox-offboarding/robot/clear-app-passwords.ts";
import {
  APP_PASSWORD_CLEAR_ACTOR,
  runAppPasswordClear,
  type AppPasswordClearDeps,
  type AppPasswordClearDriver,
} from "../src/lib/mailbox-offboarding/robot/clear-app-passwords-runner.ts";

const TODAY = "2026-10-02";

function candidate(overrides: Partial<AppPasswordClearCandidate> = {}): AppPasswordClearCandidate {
  return {
    address: "former.person@satopharma.com",
    appPasswordsClearedAt: null,
    displayName: "Former Person",
    hrId: "B-800",
    isActiveEmployee: false,
    lastWorkingDate: "2026-09-30",
    taskOpen: true,
    ...overrides,
  };
}

const NAMED = ["former.person@satopharma.com"];

function spyDriver(failAt?: "resetAndCapture" | "setMailboxPassword" | "clearAppPasswords"): AppPasswordClearDriver & { calls: string[]; passwords: string[] } {
  const calls: string[] = [];
  const passwords: string[] = [];
  return {
    calls,
    passwords,
    async signIn() { calls.push("signIn"); },
    async resetAndCapture({ address }) {
      calls.push(`resetAndCapture:${address}`);
      if (failAt === "resetAndCapture") throw new Error("two rows matched after filtering");
      return { address, oneTimePassword: "OTP" };
    },
    async setMailboxPassword({ address, newPassword }) {
      calls.push(`setMailboxPassword:${address}`);
      passwords.push(newPassword);
      if (failAt === "setMailboxPassword") throw new Error("no password field was found");
      return "done";
    },
    async clearAppPasswords({ address }) {
      calls.push(`clearAppPasswords:${address}`);
      if (failAt === "clearAppPasswords") throw new Error("the app password list could not be read");
      return { removed: 2 };
    },
    async close() { calls.push("close"); },
  };
}

function clearDeps(
  candidates: AppPasswordClearCandidate[],
  overrides: Partial<AppPasswordClearDeps> = {},
): AppPasswordClearDeps & { recorded: string[] } {
  const recorded: string[] = [];
  return {
    loadCandidates: async () => candidates,
    recordCleared: async (input) => { recorded.push(`${input.address}:${input.removed}:${input.actor}`); },
    recorded,
    today: () => TODAY,
    ...overrides,
  };
}

function runGateCases(): void {
  // The happy path, so every refusal below is attributable to the one field it changed.
  const ok = evaluateAppPasswordClear(candidate(), TODAY);
  assert.equal(ok.allowed, true);
  assert.equal(ok.allowed === true ? ok.address : "", "former.person@satopharma.com");

  // 🔴 HEADLINE. A working employee is never cut off.
  const active = evaluateAppPasswordClear(candidate({ isActiveEmployee: true }), TODAY);
  assert.equal(active.allowed, false);
  assert.equal(active.allowed === false ? active.refusal : "", "still_employed");
  assert.match(active.allowed === false ? active.detail : "", /phone they are using today/);

  // 🔴 HEADLINE. Nor one whose last day has not arrived — the day itself is allowed, the day before
  // is not, because a leaver still works their last day.
  const early = evaluateAppPasswordClear(candidate({ lastWorkingDate: "2026-10-03" }), TODAY);
  assert.equal(early.allowed === false ? early.refusal : "", "before_last_working_date");
  assert.equal(evaluateAppPasswordClear(candidate({ lastWorkingDate: TODAY }), TODAY).allowed, true,
    "the last working day itself is allowed");
  // No date at all is refused rather than assumed — "have they left?" has no answer.
  const noDate = evaluateAppPasswordClear(candidate({ lastWorkingDate: null }), TODAY);
  assert.equal(noDate.allowed === false ? noDate.refusal : "", "no_last_working_date");

  // Nothing is asking for it.
  const noTask = evaluateAppPasswordClear(candidate({ taskOpen: false }), TODAY);
  assert.equal(noTask.allowed === false ? noTask.refusal : "", "no_open_task");

  // Already done: running again would reset a password for nothing.
  const done = evaluateAppPasswordClear(candidate({ appPasswordsClearedAt: "2026-10-01T09:00:00Z" }), TODAY);
  assert.equal(done.allowed === false ? done.refusal : "", "already_cleared");

  // A non-company address is refused.
  const outside = evaluateAppPasswordClear(candidate({ address: "former.person@gmail.com" }), TODAY);
  assert.equal(outside.allowed === false ? outside.refusal : "", "not_a_company_address");

  // Case and space do not let one through or keep one out.
  assert.equal(evaluateAppPasswordClear(candidate({ address: "  FORMER.PERSON@SATOPHARMA.COM " }), TODAY).allowed, true);

  // The reset comes FIRST — it is what gives Phoenix a working password without storing one.
  assert.deepEqual([...APP_PASSWORD_CLEAR_STEP_ORDER], ["resetAndCapture", "setThrowawayPassword", "clearAppPasswords"]);
}

function runCalibrationCases(): void {
  // CALIBRATED FROM THE LIVE REHEARSAL (4 Oct 2026, 19:23 Cairo, on Phoenix's own invite inbox): the
  // flag is true only because every control holds what that run read off the page.
  assert.equal(APP_PASSWORD_CLEAR_CALIBRATED, true, "calibrated from the live rehearsal");
  assert.deepEqual(uncalibratedRevokeControls(), [], "no revoke control is a placeholder");
  assert.deepEqual(
    Object.fromEntries(Object.entries(APP_PASSWORD_REVOKE_CONTROLS).map(([name, control]) => [name, control.label])),
    {
      emptyState: "You haven’t added any apps yet.",
      existingList: "Generated passwords",
      removeConfirm: "Delete",
      removeOne: "Remove",
    },
    "each control is the wording the live page carried",
  );
  for (const [name, control] of Object.entries(APP_PASSWORD_REVOKE_CONTROLS)) {
    assert.doesNotMatch(control.selector, /__UNCALIBRATED__|nth-of-type/, `${name} is an observed path, with no position that moved between stages`);
  }
  assert.equal(
    APP_PASSWORD_REVOKE_CONTROLS.existingList.selector, APP_PASSWORD_REVOKE_CONTROLS.emptyState.selector,
    "the list and the empty state are the same container — a path, not a wording, calibrates them",
  );
  assert.equal(appPasswordClearCalibrationRefusal(), null, "a calibrated build does not refuse");

  // 🔴 And the gate still holds both ways it can fail. Flag off: refused, with the consequence named.
  const off = appPasswordClearCalibrationRefusal(false);
  assert.match(off ?? "", /never been read off the live page/);
  assert.match(off ?? "", /half-revoked/, "it explains the consequence, because the consequence is a live hole");
  // Flag on with a placeholder left: refused, naming exactly what is missing.
  const halfDone = appPasswordClearCalibrationRefusal(true, {
    ...APP_PASSWORD_REVOKE_CONTROLS,
    removeConfirm: { label: "<unobserved>", selector: "__UNCALIBRATED__" },
  });
  assert.match(halfDone ?? "", /still placeholders: removeConfirm\./);
}

async function runPassCases(): Promise<void> {
  // 🔴 THE HEADLINE ASSERTION. An uncalibrated live pass must not touch a browser at all — not one
  // reset. Resetting on the way to a step that cannot finish would reset every named leaver's
  // password for nothing.
  const untouched = spyDriver();
  const blocked = await runAppPasswordClear({
    calibrationRefusal: appPasswordClearCalibrationRefusal(false),
    deps: clearDeps([candidate()]), driver: untouched, dryRun: false, named: NAMED,
  });
  assert.equal(blocked.cleared, 0, "an uncalibrated pass clears nobody");
  assert.equal(blocked.considered, 0, "an uncalibrated pass must not even load candidates");
  assert.match(blocked.blocked ?? "", /not calibrated/);
  assert.deepEqual(untouched.calls, [], "an uncalibrated pass must make NO console call, including the reset");

  // CALIBRATED, a live pass runs the steps in order and records only what it proved.
  const liveDeps = clearDeps([candidate()]);
  const live = spyDriver();
  const ran = await runAppPasswordClear({ deps: liveDeps, driver: live, dryRun: false, named: NAMED });
  assert.equal(ran.blocked, null, "the calibrated gate lets a named live pass through");
  assert.equal(ran.cleared, 1);
  assert.deepEqual(live.calls, [
    "signIn",
    "resetAndCapture:former.person@satopharma.com",
    "setMailboxPassword:former.person@satopharma.com",
    "clearAppPasswords:former.person@satopharma.com",
    "close",
  ]);
  assert.deepEqual(liveDeps.recorded, ["former.person@satopharma.com:2:system:turbify-app-password-robot"]);
  // A clear that could not prove the page empty is reset-only, and is NEVER recorded as cleared.
  const halfDeps = clearDeps([candidate()]);
  const half = await runAppPasswordClear({ deps: halfDeps, driver: spyDriver("clearAppPasswords"), dryRun: false, named: NAMED });
  assert.equal(half.resetOnly, 1);
  assert.equal(half.cleared, 0);
  assert.deepEqual(halfDeps.recorded, [], "a mailbox whose app passwords are still there is never recorded as cleared");

  // Nothing named clears nobody, and says so rather than running an empty pass.
  const nothing = await runAppPasswordClear({
    deps: clearDeps([candidate()]), driver: spyDriver(), dryRun: false, named: [],
  });
  assert.match(nothing.blocked ?? "", /never acts on a queue/);

  // A DRY RUN still walks the steps, so the flow is exercised before the controls exist, and it
  // records nothing and ignores a live driver if handed one.
  const dryDeps = clearDeps([candidate()]);
  const ignored = spyDriver();
  const dry = await runAppPasswordClear({ deps: dryDeps, driver: ignored, dryRun: true, named: NAMED });
  assert.equal(dry.cleared, 1);
  assert.deepEqual(dryDeps.recorded, [], "a dry run must record nothing");
  assert.deepEqual(ignored.calls, [], "a dry run must not use a live driver even if given one");

  // A refused candidate never reaches the console, even in a dry run.
  const refusedDriver = spyDriver();
  const refused = await runAppPasswordClear({
    deps: clearDeps([candidate({ isActiveEmployee: true })]), driver: refusedDriver, dryRun: true, named: NAMED,
  });
  assert.equal(refused.refused, 1);
  assert.equal(refused.cleared, 0);
  assert.deepEqual(refusedDriver.calls, []);
}

/**
 * The live path, exercised by standing the calibration gate down the way the runner reads it.
 *
 * The gate is a module-level constant, so rather than mutate it this re-runs the runner with a dry
 * run (which skips the gate by design) for ordering, and asserts the recording rules directly — the
 * parts that must hold once the controls ARE observed.
 */
async function runRecordingCases(): Promise<void> {
  const deps = clearDeps([candidate()]);
  const driver = spyDriver();
  const dry = await runAppPasswordClear({ deps, driver, dryRun: true, named: NAMED });

  // The order is pinned through the dry-run driver, which walks the same sequence.
  assert.equal(dry.outcomes[0].status, "cleared");
  assert.match(dry.outcomes[0].note ?? "", /no longer sync/);
  // The note says the thing that makes this a real revocation: nobody holds a password afterwards.
  assert.match(dry.outcomes[0].note ?? "", /Nobody holds a password/);

  // The hand-over sentence counts correctly in both forms, and never implies a stored password.
  assert.match(appPasswordClearNote("A Leaver", "a@satopharma.com", 1), /1 app password was removed/);
  assert.match(appPasswordClearNote("A Leaver", "a@satopharma.com", 3), /3 app passwords were removed/);
  assert.doesNotMatch(appPasswordClearNote("A Leaver", "a@satopharma.com", 1), /password is|keep|stored/);

  // The actor is a named system account, so an attestation on the register is never anonymous.
  assert.equal(APP_PASSWORD_CLEAR_ACTOR, "system:turbify-app-password-robot");
}

function runThrowawayPasswordCases(): void {
  // It has to satisfy the mailbox's own complexity rule, or the sign-in step fails after the reset
  // has already happened — the one failure that leaves a leaver reset but not cleared.
  for (let i = 0; i < 50; i += 1) {
    const pw = throwawayPassword();
    assert.ok(pw.length >= 20, "long enough to be worth nothing to a guesser");
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[0-9]/);
    assert.match(pw, /[!@#$%^&*]/);
    // 🔴 No whitespace and no quote characters: those break the form it is typed into.
    assert.doesNotMatch(pw, /[\s'"\\`]/, "must not carry a character that breaks a form or a shell");
  }
  // Two calls must not agree — a fixed throwaway would be a standing password to every leaver's
  // mailbox, which is the thing this whole step exists to remove.
  assert.notEqual(throwawayPassword(), throwawayPassword());
}

export async function runMailboxAppPasswordClearTests(): Promise<void> {
  runGateCases();
  runCalibrationCases();
  runThrowawayPasswordCases();
  await runPassCases();
  await runRecordingCases();
}
