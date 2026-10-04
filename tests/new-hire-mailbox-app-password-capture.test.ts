/**
 * Capturing the app-passwords page — what this file protects.
 *
 * The capture exists to replace the four `__UNCALIBRATED__` placeholders in
 * `APP_PASSWORD_REVOKE_CONTROLS`, which are the only reason `APP_PASSWORD_CLEAR_CALIBRATED` cannot
 * be flipped and a leaver's phone keeps syncing after a password reset. So its whole value is that
 * it is a READ: the moment it rotates a password, mints an app password, or presses a remove
 * control, it stops being a diagnostic and becomes an unreviewed destructive step inside a live
 * mailbox's security settings.
 *
 * Three things are pinned here, and each one is a way this could go wrong quietly:
 *
 *   1. **It changes nothing.** No reset, no mint, no revoke press — asserted against the step's own
 *      source, comment-stripped, because the comments necessarily NAME every one of those things in
 *      order to say it does not do them.
 *   2. **The address is the constant, never the request body.** The same chain pointed at an
 *      employee signs into their mail. This is the rule adoption already carries.
 *   3. **It is not a provisioning step.** It must never appear in `JOINER_STEP_ORDER` or be reached
 *      from the sweep: a capture wired into the nightly pass signs into a mailbox every night.
 *
 * 🔴 ASSERTIONS READ COMMENT-STRIPPED SOURCE AND JOIN `" + "` SEAMS. A refusal here is assembled
 * from fragments, so a phrase can straddle a seam and collapsing whitespace does not fix it — the
 * `+ "` tokens survive. A negative assertion written without that passes against code that still
 * does the thing. Both halves cost a real red CI round on 2026-10-04.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { JOINER_STEP_ORDER, createDryRunJoinerDriver } from "../src/lib/new-hire-mailbox/robot/driver.ts";
import { INVITE_INBOX_ADDRESS } from "../src/lib/new-hire-mailbox/robot/invite-inbox.ts";
import {
  APP_PASSWORD_REVOKE_CONTROLS,
  uncalibratedRevokeControls,
  APP_PASSWORD_CLEAR_CALIBRATED,
} from "../src/lib/mailbox-offboarding/robot/clear-app-passwords.ts";

/** Comment-stripped, whitespace-collapsed, and with adjacent string fragments joined. */
function readable(path: string): string {
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"))
    .replace(/\s+/g, " ")
    .replace(/["`]\s*\+\s*["`]/g, "");
}

/** Just the body of `describeAppPasswords`, so a mint elsewhere in the driver cannot read as one here. */
function captureStep(): string {
  const driver = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");
  const start = driver.indexOf("async describeAppPasswords(");
  assert.notEqual(start, -1, "describeAppPasswords must exist in the joiner driver");
  const end = driver.indexOf("async close(", start);
  assert.notEqual(end, -1, "the capture step must sit before close(), so its body can be isolated");
  return driver.slice(start, end);
}

function runItChangesNothingCases(): void {
  const step = captureStep();

  // ── 1. No reset. A reset rotates the password and leaves a one-time one outstanding ─────────────
  assert.equal(
    /resetAndCapture/.test(step), false,
    "the capture must not reset the mailbox — a reset rotates its password, leaves a one-time "
    + "password outstanding, and lands on the terms-of-service screen the page sits behind",
  );

  // ── 2. No mint. Minting adds a credential to a live mailbox that nothing will ever use ─────────
  assert.equal(
    /selectAppForPassword/.test(step), false,
    "the capture must not choose an app in the dropdown — that is a step on the way to minting, and "
    + "this step mints nothing",
  );
  assert.equal(
    /APP_PASSWORD_WORDINGS\.generate/.test(step), false,
    "the capture must not press Generate — it would leave an unused app password on a live mailbox, "
    + "and the existing post-mint read is exactly the path this step exists to avoid",
  );

  // ── 3. No revoke press. Reading those controls is the whole point of the capture ────────────────
  assert.equal(
    /APP_PASSWORD_REVOKE_CONTROLS/.test(step), false,
    "the capture must not touch APP_PASSWORD_REVOKE_CONTROLS — those four controls are what it is "
    + "reading the page to IDENTIFY, and clicking a placeholder is the accident it prevents",
  );

  // ── 4. It does read, and it reports what it read ───────────────────────────────────────────────
  assert.match(
    step, /CONTROL_READ_EXPRESSION/,
    "the capture must read the page's controls — that is the deliverable",
  );
  assert.match(
    step, /buildControlReport/,
    "and it must go through buildControlReport, which drops a secret-shaped label whatever it is — "
    + "this page lists credentials by nature",
  );
  assert.match(
    step, /signInAs\( mailbox, MAILBOX_LOGIN_URL, address, password,/,
    "it must sign in with the password it was handed, not a one-time password: that is the whole "
    + "difference between this step and the flow that has to reset the mailbox first",
  );
}

function runSetupScreenIsAnAnswerCases(): void {
  const step = captureStep();
  assert.match(
    step, /onSetupPage\(\)\) \{ return \{ controls: \[\], observed: 0, reached: false,/,
    "landing on the setup screen must return reached:false rather than hunt for a control on a page "
    + "it never reached — that screen means the password Phoenix holds is a one-time one",
  );
  assert.match(
    step, /has never .{0,20}completed a first sign-in/,
    "and the refusal must say so in those terms, because it tells the owner which mailbox needs the "
    + "four manual clicks before anything can be captured",
  );
}

function runAddressIsTheConstantCases(): void {
  const route = readable("../app/api/new-hire-mailboxes/app-password-controls/route.ts");

  assert.match(
    route, /describeAppPasswords\(\{ address: INVITE_INBOX_ADDRESS, password: companyPassword \}\)/,
    "the route must pass INVITE_INBOX_ADDRESS, never an address from the request — the same chain "
    + "pointed at an employee signs into their mail",
  );
  assert.equal(
    /body\?\.address|body\.address/.test(route), false,
    "and it must not read an address out of the body at all, so no future edit can route it to one",
  );
  assert.match(
    route, /body\?\.dryRun !== false/,
    "only an explicit false may open a browser, so a malformed body plans rather than acts",
  );
  assert.match(
    route, /canReadInitialPassword\(access\.role\)/,
    "the gate is the same audience as adoption: this signs in as a mailbox with the company password",
  );
  assert.match(
    route, /driver\.close\(\)/,
    "the browser must be closed whatever happened — a leaked Chromium holds a signed-in mailbox "
    + "session for longer than the request",
  );
  assert.equal(
    /\bappPassword\b/.test(route), false,
    "and no credential may reach the response or the audit row: the route never names one",
  );
}

function runNotAProvisioningStepCases(): void {
  assert.equal(
    (JOINER_STEP_ORDER as readonly string[]).includes("describeAppPasswords"), false,
    "the capture is a calibration read and must never join the provisioning sequence — in it, every "
    + "create would sign into the mailbox again for a diagnostic nobody asked for",
  );

  const sweep = readable("../src/lib/new-hire-mailbox/robot/runner.ts");
  assert.equal(
    /describeAppPasswords/.test(sweep), false,
    "and the scheduled sweep must not name it: a capture on a schedule signs into a live mailbox "
    + "every night, which is the shape of the lock-out rule adoption already carries",
  );
}

async function runDryRunCases(): Promise<void> {
  const driver = createDryRunJoinerDriver();
  const reading = await driver.describeAppPasswords({ address: INVITE_INBOX_ADDRESS, password: "irrelevant" });
  assert.equal(
    reading.reached, false,
    "a dry run reached nothing, so it must say reached:false — handing back a plausible control list "
    + "is the kind of green that means nothing",
  );
  assert.deepEqual(reading.controls, [], "and it must not invent controls");
  assert.ok(
    driver.calls.includes(`describeAppPasswords:${INVITE_INBOX_ADDRESS}`),
    "the dry-run driver must still record the call, so a test can prove which steps a flow reached",
  );
}

function runStillUncalibratedCases(): void {
  // 🔴 THE CAPTURE DOES NOT CALIBRATE ANYTHING BY EXISTING. Until a real run replaces the four
  // placeholders with observed text, the flag stays false — and a session that flipped it on the
  // strength of this route shipping would arm a robot to click `__UNCALIBRATED__` inside a leaver's
  // security settings. That is the whole failure this asserts against.
  assert.equal(
    APP_PASSWORD_CLEAR_CALIBRATED, false,
    "shipping the capture does not calibrate the clear step: the flag may only be flipped once the "
    + "four controls below hold text read off the live page",
  );
  assert.deepEqual(
    uncalibratedRevokeControls().sort(),
    ["emptyState", "existingList", "removeConfirm", "removeOne"],
    "and all four are still placeholders — this list is what a capture run must replace, and it is "
    + "the thing to re-read before touching the flag",
  );
  for (const [name, control] of Object.entries(APP_PASSWORD_REVOKE_CONTROLS)) {
    assert.match(
      control.selector, /__UNCALIBRATED__/,
      `${name} must still be a placeholder until a live reading replaces it; a selector that quietly `
      + "became real without an observation is the guess this gate exists to stop",
    );
  }
}

/**
 * 🔴 THE ROUTE MUST HAVE A CALLER, because this module has already shipped one that did not.
 * `invitation.ts` was written, documented, tested against a real captured email and MERGED while
 * nothing in `src` or `app` called it — so every mailbox the robot created stayed `Pending` with its
 * password unread, and every status report read as if the feature worked. A unit suite is itself a
 * caller, so no test of the route's body can ever catch this; only asking who calls it can.
 *
 * The route also refuses a cross-origin request, so a curl cannot stand in for the card.
 */
function runTheRouteHasACallerCases(): void {
  const card = readable("../src/components/new-hire-mailbox/app-password-controls-card.tsx");
  const panel = readable("../src/components/new-hire-mailbox/new-hire-mailbox-panel.tsx");

  assert.match(
    card, /fetch\("\/api\/new-hire-mailboxes\/app-password-controls"/,
    "the card must call the capture route — a route nothing calls reads as a shipped feature in "
    + "every status report while doing nothing, which this module has already shipped once",
  );
  assert.match(
    panel, /<AppPasswordControlsCard inviteInbox=\{INVITE_INBOX_ADDRESS\}/,
    "and the panel must mount that card, passing the invite-inbox constant — a card nothing renders "
    + "is the same failure one layer up",
  );
  assert.match(
    panel, /canAdopt \? <AppPasswordControlsCard/,
    "mounted behind the same audience gate as adoption, because signing in AS a mailbox is what the "
    + "route does",
  );
  assert.equal(
    /router\.refresh\(\)/.test(card), false,
    "the card must not refresh the route after a run — the controls ARE the deliverable, and a "
    + "refresh remounts the card with the result back at null",
  );
  assert.equal(
    /type="text"|<input/.test(card), false,
    "and it must offer no address field: the mailbox is fixed server-side, because the same chain "
    + "pointed at an employee signs into their mail",
  );
}

export async function runNewHireMailboxAppPasswordCaptureTests(): Promise<void> {
  runItChangesNothingCases();
  runTheRouteHasACallerCases();
  runSetupScreenIsAnAnswerCases();
  runAddressIsTheConstantCases();
  runNotAProvisioningStepCases();
  await runDryRunCases();
  runStillUncalibratedCases();
}
