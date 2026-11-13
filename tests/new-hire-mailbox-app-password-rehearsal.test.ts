/**
 * The app-password rehearsal — what this file protects.
 *
 * 🔴 THE HEADLINE: THIS IS THE ONE STEP THAT CREATES A LIVE CREDENTIAL ON A REAL MAILBOX. It exists
 * because `removeConfirm` cannot be read any other way — that control does not exist on the page
 * until Remove has been pressed, which is why the read-only capture of 2026-10-04 filled three of
 * the four placeholders and could never have filled the fourth however often it ran.
 *
 * Three properties, each of which has a way of going quietly wrong:
 *
 *   1. It runs on the invite inbox and on NOTHING else, refused before a browser exists. Phoenix's
 *      own inbox holds nobody's mail; every other mailbox belongs to a person whose phone would
 *      stop syncing.
 *   2. `outstanding` means a working app password is loose. A rehearsal that mints and cannot press
 *      an unknown confirm has left one behind, and `removed: false` alone reads as "nothing
 *      happened" — the opposite of the truth.
 *   3. It is never wired into the sweep or the provisioning sequence. A mint-and-remove on a
 *      schedule is a credential created nightly for a diagnostic nobody asked for.
 */

import assert from "node:assert/strict";

import { APP_PASSWORD_WORDINGS } from "../src/lib/turbify/locators.ts";
import { JOINER_STEP_ORDER, createDryRunJoinerDriver } from "../src/lib/new-hire-mailbox/robot/driver.ts";
import { INVITE_INBOX_ADDRESS } from "../src/lib/new-hire-mailbox/robot/invite-inbox.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Source with comments stripped.
 *
 * 🔴 NOT OPTIONAL IN THIS MODULE. Its prose explains every call it makes, so a test asserting that
 * source "contains" a call is satisfied by the COMMENT explaining the call — the more carefully the
 * code is documented, the less its own tests prove. Gutting a function and keeping its comment left
 * a sibling suite green in exactly this way.
 */
function readable(path: string): string {
  const full = fileURLToPath(new URL(path, import.meta.url));
  return readFileSync(full, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/["`]\s*\+\s*["`]/g, "");
}

function runAddressScopeCases(): void {
  const driver = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");
  const start = driver.indexOf("async rehearseAppPasswordRemoval(");
  assert.notEqual(start, -1, "the rehearsal must exist in the joiner driver");
  const body = driver.slice(start, start + 2_000);

  // 🔴 THE GUARD IS THE FIRST THING THE FUNCTION DOES, before a browser is opened. A guard placed
  // after the sign-in would still be correct and still be wrong: by then the run has committed to a
  // mailbox, and the refusal has already cost a live session on it.
  const guard = body.indexOf("TURBIFY_INVITE_RECIPIENT.toLowerCase()");
  const opens = body.indexOf("openMailboxPage()");
  assert.notEqual(guard, -1, "the rehearsal must compare the address against the invite inbox");
  assert.ok(guard < opens, "the address guard must run BEFORE a browser is opened");

  // And it must be a comparison against the constant, never a parameter the caller chose.
  assert.doesNotMatch(
    body.slice(0, guard + 120), /allowedAddress|address === input|skipScope/,
    "the scope must not be something a caller can pass in",
  );
}

function runOutstandingCases(): void {
  const driver = readable("../src/lib/new-hire-mailbox/robot/turbify-joiner.ts");
  const start = driver.indexOf("async rehearseAppPasswordRemoval(");
  const body = driver.slice(start, driver.indexOf("async close()", start));

  // 🔴 THE TWO FAILURE SHAPES MUST NOT REPORT THE SAME WAY. Failing to press Generate leaves
  // nothing behind; failing to answer the confirm leaves a WORKING credential on the mailbox.
  const mintFailed = body.indexOf("No app password was minted");
  const removeFailed = body.indexOf("A WORKING APP");
  assert.notEqual(mintFailed, -1, "a failed mint must say that nothing was minted");
  assert.notEqual(removeFailed, -1, "a failed removal must say a working app password is live");

  // 🔴 AND THE FLAG MUST AGREE WITH THE SENTENCE. Prose and flag drifting apart is the worse bug:
  // the sentence is read once by a person, the flag is read for ever by everything else. The mint
  // failure is the ONLY early return allowed to claim nothing is outstanding.
  const branches = body.split("return {").slice(1);
  const mintBranch = branches.find((b) => b.includes("No app password was minted"));
  const removeBranches = branches.filter((b) => b.includes("A WORKING APP"));
  assert.ok(mintBranch, "the failed-mint branch must exist");
  assert.match(mintBranch ?? "", /outstanding: false/,
    "nothing was created, so nothing is outstanding");
  assert.equal(removeBranches.length, 2,
    "both removal failures — Remove unmatched, and the confirm unmatched — must be handled");
  for (const branch of removeBranches) {
    assert.match(branch, /outstanding: true/,
      "a minted password that was not removed MUST set outstanding, or the one field that means "
      + "'a live credential is adrift' is wrong exactly when it matters");
    assert.match(branch, /minted: true/, "and it must admit that it minted");
  }

  // The minted value is fed to the redactor and never returned.
  assert.match(body, /secrets\.push\(mintedValue\)/,
    "the minted password must join the secrets list so every later reading is redacted against it");

  // 🔴 AND IT IS READ FROM RAW PAGE TEXT, NEVER FROM `describePage`. This looks like a tidy-up
  // waiting to happen — the function has a `describePage` helper right there — and it is the one
  // substitution that cannot work: `describePage` REDACTS, and what it drops includes anything
  // secret-shaped, which is the minted password itself. The first draft read it from there, so the
  // value could never be found; the redactor working correctly would have surfaced as "no app
  // password could be read" while a live credential sat on the mailbox. Asserted on what
  // `pickAppPassword` is actually HANDED, because that is the thing that has to be unredacted.
  const pick = body.match(/pickAppPassword\(\s*([A-Za-z_$][\w$]*)\s*,/);
  assert.ok(pick, "the rehearsal must hand a named page reading to pickAppPassword");
  const handed = body.match(new RegExp(`const ${pick?.[1] ?? "x"} = ([^;]{0,120})`));
  assert.ok(handed, "and that reading must be a const declared in the rehearsal");
  assert.doesNotMatch(handed?.[1] ?? "", /describePage/,
    "the minted value must NOT be read from describePage, which redacts the very thing being read");
  assert.match(handed?.[1] ?? "", /evaluate</,
    "it must be a raw read of the page's own text");
  assert.doesNotMatch(body, /appPassword: minted|return \{[^}]*mintedValue/,
    "the minted password must never be returned from the rehearsal");
}

function runWordingCases(): void {
  // The remove control is measured; the confirm is honestly marked as a guess by being a list that
  // fails closed. Both must exist, and the confirm must offer more than one candidate.
  assert.ok(APP_PASSWORD_WORDINGS.removeAppPassword.includes("Remove"),
    "the measured remove wording must be present");
  assert.ok(APP_PASSWORD_WORDINGS.removeConfirm.length > 1,
    "nothing has ever seen the confirm, so it must offer several candidates and fail closed");

  // 🔴 RAW SOURCE, NOT `readable`, AND DELIBERATELY SO. Every other assertion in this file uses the
  // comment-stripped reader, because this module's prose otherwise satisfies assertions about its
  // code. This one is the exact inverse: it is an assertion ABOUT the prose — that the unmeasured
  // list is labelled unmeasured — so stripping the comments removes the only thing it can see.
  // Using the "safe" reader here failed the test against a file that was correct.
  const locatorsRaw = readFileSync(fileURLToPath(new URL("../src/lib/turbify/locators.ts", import.meta.url)), "utf8");
  assert.match(locatorsRaw, /EVERY ONE OF THESE IS A GUESS/,
    "the confirm list must say in the source that it is unmeasured — a guess that reads as measured "
    + "is how this module lost four clicks already");
}

function runNotInTheSweepCases(): void {
  assert.equal(
    (JOINER_STEP_ORDER as readonly string[]).includes("rehearseAppPasswordRemoval"), false,
    "a mint-and-remove must never join the provisioning sequence",
  );
  const sweep = readable("../src/lib/new-hire-mailbox/robot/runner.ts");
  assert.equal(
    /rehearseAppPasswordRemoval/.test(sweep), false,
    "and the scheduled sweep must never name it: a rehearsal on a schedule mints a real credential "
    + "every night for a diagnostic nobody asked for",
  );
}

async function runDryRunCases(): Promise<void> {
  const driver = createDryRunJoinerDriver();
  const result = await driver.rehearseAppPasswordRemoval({
    address: INVITE_INBOX_ADDRESS,
    password: "irrelevant",
  });
  // 🔴 `minted` AND `outstanding` BOTH FALSE is the honest dry-run pair: nothing was created, so
  // nothing is loose. A dry run reporting `minted: true` would make the one field that means "a
  // live credential is adrift" untrustworthy everywhere else.
  assert.equal(result.minted, false);
  assert.equal(result.outstanding, false);
  assert.equal(result.removed, false);
  for (const stage of [result.before, result.listed, result.confirming, result.after]) {
    assert.equal(stage.reached, false, "a dry run reached nothing");
    assert.deepEqual(stage.controls, [], "and must not invent controls");
  }
  assert.ok(driver.calls.includes(`rehearseAppPasswordRemoval:${INVITE_INBOX_ADDRESS}`));
}

function runRouteCases(): void {
  const route = readable("../app/api/new-hire-mailboxes/app-password-rehearsal/route.ts");
  // The live run, its audits and its summary live in ONE shared action since the robot service (audit
  // REC-075): the website runs it while the service is off, the robot service once it is on.
  const action = readable("../src/lib/new-hire-mailbox/robot/actions/app-password-rehearsal-action.ts");
  assert.equal(/body/.test(action), false, "the shared action never sees the request body at all");

  // 🔴 THE ADDRESS ARGUMENT ITSELF, NOT A BAN ON TWO SPELLINGS OF READING IT. Banning
  // `body.address` and `body?.address` left `(body as { address?: string }).address` sailing
  // through — a break that passed, found by running it. What matters is what the call is HANDED,
  // so the assertion reads the call: the argument must be the constant and nothing else, and the
  // request body must not appear anywhere inside it.
  const callAt = action.indexOf("rehearseAppPasswordRemoval({");
  assert.notEqual(callAt, -1, "the shared action must call the rehearsal");
  const call = action.slice(callAt, callAt + 200);
  assert.match(call, /address: INVITE_INBOX_ADDRESS\s*,/,
    "the mailbox must be the constant, never an expression a caller can steer");
  assert.doesNotMatch(call, /body/,
    "the request body must not reach the rehearsal's arguments in any spelling");

  // Dry run is the default: only an explicit `false` opens a browser.
  assert.match(route, /body\?\.dryRun !== false/);

  // Same-origin and the initial-password audience, before anything else.
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /canReadInitialPassword\(access\.role\)/);

  // 🔴 A THROW MUST NOT RECORD `outstanding: false`. If the run threw after minting, claiming
  // nothing is outstanding is a claim the route cannot support — it records null and says so.
  const threw = action.indexOf("failed: true");
  assert.notEqual(threw, -1, "a throw must still write an audit row");
  assert.match(action.slice(threw, threw + 200), /outstanding: null/,
    "a throw must record outstanding as unknown, never as false");

  // And the loud summary exists for the case that matters.
  assert.match(action, /LEFT A LIVE APP PASSWORD/);
}

export async function runNewHireMailboxAppPasswordRehearsalTests(): Promise<void> {
  runAddressScopeCases();
  runOutstandingCases();
  runWordingCases();
  runNotInTheSweepCases();
  await runDryRunCases();
  runRouteCases();
}
