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
import { APP_PASSWORD_WORDINGS } from "../src/lib/turbify/locators.ts";
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

/**
 * Just the body of `describeAppPasswords`, so a mint elsewhere in the driver cannot read as one here.
 *
 * 🔴 THE END ANCHOR IS "THE NEXT METHOD", NOT `close(`. It was `close(`, which quietly assumed the
 * capture was the LAST method in the driver — and on 2026-10-04 `rehearseAppPasswordRemoval` was
 * added between the two. The slice then swallowed the whole rehearsal, which mints on purpose, and
 * these "mints nothing" assertions went red against a capture that had not changed by a character.
 * A boundary that holds only while nothing is added after it breaks on the next addition, and it
 * fails in the most confusing direction: the red test names an innocent function.
 */
function captureStep(): string {
  const driver = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");
  const start = driver.indexOf("async describeAppPasswords(");
  assert.notEqual(start, -1, "describeAppPasswords must exist in the joiner driver");
  // `readable` collapses whitespace, so every following method reads as `}, async name(`.
  const next = driver.indexOf("}, async ", start);
  assert.notEqual(next, -1, "the capture step must be followed by another method, so it can be isolated");
  return driver.slice(start, next);
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
  // The live body lives in ONE shared action since the robot service (audit REC-075): the website runs
  // it while the service is off, and /api/internal/mailbox-robot/app-password-controls runs it once on.
  const action = readable("../src/lib/new-hire-mailbox/robot/actions/app-password-controls-action.ts");

  assert.match(
    action, /describeAppPasswords\(\{ address: INVITE_INBOX_ADDRESS, password: companyPassword \}\)/,
    "the route must pass INVITE_INBOX_ADDRESS, never an address from the request — the same chain "
    + "pointed at an employee signs into their mail",
  );
  assert.equal(
    /body\?\.address|body\.address/.test(route + action), false,
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
    action, /driver\.close\(\)/,
    "the browser must be closed whatever happened — a leaked Chromium holds a signed-in mailbox "
    + "session for longer than the request",
  );
  assert.equal(
    /\bappPassword\b/.test(route), false,
    "and no credential may reach the response or the audit row: the route never names one",
  );
  assert.equal(
    /\bappPassword\b/.test(action), false,
    "nor does the shared action that does the live run, on the website or on the robot service",
  );
}

/**
 * 🔴 A RUN THAT THREW MUST LEAVE A ROW, because the first live run did not.
 *
 * On 2026-10-04 at 07:16 Cairo the capture refused inside `signInAs` — the sign-in never left
 * Turbify's login page — and the throw went straight past the audit write, so the only account of
 * it was the text rendered on the card. `audit_logs` held nothing at all. One reload would have
 * destroyed the finding, which is the same loss a `router.refresh()` caused on 2026-10-03.
 *
 * What makes the row worth having is the MESSAGE: it carries the measured page — url, title,
 * headings, buttons, controls — with every `filled` already reduced to a length. That is the whole
 * diagnostic; without it a failure is just "it did not work".
 */
function runAFailedRunIsRecordedCases(): void {
  // The run, its audits and its rethrow live in the one shared action (audit REC-075).
  const route = readable("../src/lib/new-hire-mailbox/robot/actions/app-password-controls-action.ts");

  const start = route.indexOf("const driver = await createJoinerDriverFromEnv()");
  assert.notEqual(start, -1, "the route must still create the driver, or this slice means nothing");

  // 🔴 THE SLICE ENDS AT THE RETHROW, AND THAT IS LOAD-BEARING. The SUCCESS path's own
  // `writeAuditLog` sits just after it, so a region that ran to the response was satisfied by the
  // wrong call site and the first assertion below could not fail — caught by breaking it on
  // 2026-10-04. The rethrow is also the end marker, so its absence fires here rather than silently
  // widening the slice to the rest of the handler.
  const rethrowAt = route.indexOf("throw error;", start);
  assert.notEqual(
    rethrowAt, -1,
    "it must rethrow after recording — recording a failure must never convert it into a success, "
    + "and the status still comes from the handler's own catch",
  );
  const runRegion = route.slice(start, rethrowAt);

  const catchAt = runRegion.indexOf("} catch (error) {");
  assert.notEqual(
    catchAt, -1,
    "the run must have its OWN catch, separate from the handler's — that is what lets a failed "
    + "capture be recorded without also recording the refusals that never opened a browser",
  );
  const failureRegion = runRegion.slice(catchAt);

  assert.match(
    failureRegion, /writeAuditLog\(/,
    "a run that threw must write an audit row before it rethrows — without it a failed capture's "
    + "only account is the text on the card, which one reload destroys",
  );
  assert.match(
    failureRegion, /why: clientSafeErrorMessage\(error,/,
    "and the row must carry the ERROR MESSAGE as `why` — that string holds the measured page (url, "
    + "title, headings, buttons, controls), which is the entire diagnostic value of a failure",
  );
  assert.match(
    failureRegion, /failed: true/,
    "the failure row must mark itself `failed: true`: a run that reached the page and found nothing "
    + "and a run that never got there are different diagnoses and must not read alike",
  );
  assert.match(
    route, /failed: false/,
    "and the SUCCESS row must carry the same key, or the field's absence would mean both 'an older "
    + "row' and 'a run that did not throw', and a query for failures would answer with a mix",
  );

  // The browser close must sit inside the run and BEFORE the audit: a slow or failing insert must
  // never hold a signed-in mailbox session open behind it.
  const closeAt = runRegion.indexOf("driver.close()");
  const auditAt = runRegion.indexOf("writeAuditLog");
  assert.notEqual(closeAt, -1, "the browser must still be closed inside the run region");
  assert.notEqual(auditAt, -1, "the failure audit must sit inside the run region");
  assert.ok(
    closeAt < auditAt,
    "the browser must close BEFORE the failure is recorded — the audit has its own timeout, and a "
    + "slow insert must not hold a signed-in mailbox session open behind it",
  );

  // An access refusal is not a capture attempt. Both are raised before a driver exists, so neither
  // may appear inside the region that records a run.
  assert.equal(
    /isForbiddenError|isApiRateLimitError/.test(runRegion), false,
    "a forbidden or rate-limited request must NOT be recorded as a failed capture: nothing was "
    + "opened, and logging it as a run would make the audit overstate how often the robot ran",
  );
}

/**
 * 🔴 THE MEASURED WORDING, AND WHY IT CANNOT BE TIDIED AWAY.
 *
 * The live run of 2026-10-04 07:44 Cairo signed in, reached `mail.turbify.com/accountinfo` ("Update
 * User Profile") and refused at the section lookup, printing the page: the button's own text reads
 * `APP Password Manage App Passwords`. The section HEADING sits inside the button, run straight into
 * its label — the same `textContent` glue that made a console row parse as
 * `Abd-Elnaimahmed.mohamed@satopharma.com`, met a third time.
 *
 * `matchesLocator` compares text EXACTLY and never as a substring, deliberately, so `Manage App
 * Passwords` alone can never match that button. The composite reads like a typo and is the one entry
 * that actually works; it is first in the list so it is tried before four guesses that cannot.
 */
function runTheMeasuredWordingCases(): void {
  assert.ok(
    APP_PASSWORD_WORDINGS.appPasswords.includes("APP Password Manage App Passwords"),
    "the MEASURED button text must stay in the list — the heading is glued inside the button, and "
    + "the exact matcher means the composite is the only entry that can ever match it",
  );
  assert.equal(
    APP_PASSWORD_WORDINGS.appPasswords[0], "APP Password Manage App Passwords",
    "and it must be tried FIRST, ahead of the four guesses that cannot match the live page",
  );
  assert.ok(
    APP_PASSWORD_WORDINGS.appPasswords.includes("Manage App Passwords"),
    "the older guesses stay BELOW it rather than being deleted: they cost one failed match each and "
    + "are what still works if Turbify ever drops the heading back out of the button",
  );

  // The matcher this depends on. If it ever became a substring match, the composite would stop
  // being necessary — and a substring on "App Passwords" would also catch the heading, so the
  // exactness is the thing protecting this page from a wrong click.
  const resolve = readable("../src/lib/turbify/resolve.ts");
  assert.match(
    resolve, /case "text": return \(candidate\.text \?\? ""\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\) === value;/,
    "a text locator must stay an EXACT comparison — a substring match would make 'App Passwords' "
    + "also match the section heading, which is a wrong click inside a live mailbox's security page",
  );
}

/**
 * The refusal is the step's whole deliverable, so it has to READ.
 *
 * Every wording list fails closed and prints the page, which is why one click bought the measured
 * button text instead of a press on something unknown. That makes the sentence the owner reads the
 * product — and it said **"No the App Passwords section was found"**, because `purpose` carries its
 * article for `describeLocator`'s parentheses, and claimed it "looked for a button" on a step that
 * accepts a link, which sends the next reader to check the wrong thing.
 *
 * Read against comment-stripped source on purpose: the comment above the fix NAMES the broken
 * sentence, so an unstripped negative assertion can never fail.
 */
function runTheRefusalReadsCases(): void {
  const joiner = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");

  // 🔴 SCOPED TO `clickOneOf`, BECAUSE THE BARE PATTERN IS LEGITIMATE NEXT DOOR. `submitOpenForm`
  // raises the same sentence and is CORRECT: its purposes are written without an article ("submit
  // button for the new-mailbox form"). A repo-wide ban on `No ${purpose} was found` would have
  // demanded a change there that makes its message worse. The slice ends at the next function, which
  // the body must be followed by.
  const start = joiner.indexOf("async function clickOneOf(");
  assert.notEqual(start, -1, "clickOneOf must exist — it is what presses every wording list");
  const end = joiner.indexOf("async function hasHeading(", start);
  assert.notEqual(end, -1, "and hasHeading must still follow it, so clickOneOf's body can be isolated");
  const body = joiner.slice(start, end);

  assert.ok(
    body.includes('const subject = purpose.replace(/^(?:the|a|an) /i, "")'),
    "the refusal must drop the article off `purpose`, or it reads \"No the App Passwords section "
    + 'was found" — the one sentence a failed capture hands back',
  );
  assert.ok(
    body.includes("`No ${subject} was found on the Turbify page."),
    "and it must interpolate that stripped subject, not `purpose` itself",
  );
  assert.equal(
    body.includes("`No ${purpose} was found"), false,
    "the article-bearing form must be gone, not merely shadowed by a second message",
  );
  assert.ok(
    body.includes('It looked for a ${tags.join(" or ")} reading one of:'),
    "and the refusal must name the TAGS it searched — the app-password steps accept a link, and "
    + "`a button` sent a reader to check the wrong element type",
  );
  assert.equal(
    body.includes("It looked for a button reading one of:"), false,
    "so the hard-coded `a button` must be gone",
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
  // 🔴 THE CAPTURE DOES NOT CALIBRATE ANYTHING BY EXISTING. The flag was flipped (13 Nov 2026) only
  // because the live rehearsal of 4 Oct 2026 read all four controls off the page — including the
  // confirm, which no capture of an untouched page can ever see. So the flag and the four controls
  // move together: true means every one of them is an observed path, never a placeholder.
  assert.equal(APP_PASSWORD_CLEAR_CALIBRATED, true, "calibrated from the live rehearsal, not from this route shipping");
  assert.deepEqual(
    uncalibratedRevokeControls(), [],
    "the flag may only be true while no control is a placeholder — re-read this list before touching the flag",
  );
  for (const [name, control] of Object.entries(APP_PASSWORD_REVOKE_CONTROLS)) {
    assert.doesNotMatch(
      control.selector, /__UNCALIBRATED__/,
      `${name} holds the path the live rehearsal read; a placeholder with the flag on is the guess this gate exists to stop`,
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
  runAFailedRunIsRecordedCases();
  runTheMeasuredWordingCases();
  runTheRefusalReadsCases();
  runNotAProvisioningStepCases();
  await runDryRunCases();
  runStillUncalibratedCases();
}
