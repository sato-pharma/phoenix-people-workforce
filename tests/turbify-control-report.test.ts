/**
 * The Turbify control report — what this file protects.
 *
 * 🔴 THE HEADLINE: A LIVE MAILBOX CREDENTIAL MUST NOT REACH THE LOGS. The report reads the App
 * Passwords page at the exact moment that page is DISPLAYING the app password the robot has just
 * minted. A naive dump of its text would write a working credential into Railway's logs and into
 * Sentry, where it would sit for anyone with log access. Every assertion below exists to prove that
 * cannot happen — by exact match for the secrets in hand, and by shape for anything else.
 *
 * The second property: it is OFF unless the flag is exactly "true". It writes page structure into a
 * production log, so it is a diagnostic that gets switched on for one run and off again — not
 * something that quietly stays on.
 */

import assert from "node:assert/strict";

import {
  buildControlReport,
  CONTROL_READ_EXPRESSION,
  CONTROL_REPORT_ENV,
  controlReportEnabled,
  looksLikePathWord,
  looksLikeSecret,
  MAX_LABEL_LENGTH,
  MAX_SELECTOR_LENGTH,
  redactLabel,
  redactSelector,
  SECRET_LIKE_MIN_LENGTH,
  type ObservedControl,
} from "../src/lib/turbify/control-report.ts";

/** A realistic app password: a long run of letters with no spaces, which is what Turbify shows. */
const MINTED = "xqhdlpzwmrkfabcd";
const MAILBOX_PASSWORD = "Sato@2014x";

function runRedactionCases(): void {
  // 🔴 THE HEADLINE. The minted password is removed wherever it appears, in any case, and whether it
  // stands alone or sits inside a sentence.
  for (const raw of [
    MINTED,
    MINTED.toUpperCase(),
    `Your app password is ${MINTED}`,
    `${MINTED} — copy it now`,
    `prefix${MINTED}suffix`,
  ]) {
    const out = redactLabel(raw, [MINTED, MAILBOX_PASSWORD]) ?? "";
    assert.equal(out.toLowerCase().includes(MINTED.toLowerCase()), false,
      `the minted password must not survive redaction of: ${raw}`);
  }

  // The mailbox password too, even though it is short enough that the SHAPE rule would miss it —
  // which is exactly why the caller must pass every secret it holds.
  assert.equal(looksLikeSecret(MAILBOX_PASSWORD), false, "short enough to slip the shape rule");
  const withPw = redactLabel(`sign in with ${MAILBOX_PASSWORD} now`, [MINTED, MAILBOX_PASSWORD]) ?? "";
  assert.equal(withPw.includes(MAILBOX_PASSWORD), false, "an exact-match secret must still be removed");

  // 🔴 AND A SECRET NOBODY PASSED IS STILL DROPPED, on shape alone. This is the case that matters
  // when the page shows something we are not holding — a session token, a second password, an id.
  const unknown = "ZmFrZS1zZWNyZXQtdmFsdWU";
  assert.equal(looksLikeSecret(unknown), true);
  const out = redactLabel(`token ${unknown}`, []) ?? "";
  assert.equal(out.includes(unknown), false, "an unknown secret-shaped token must be dropped too");
  assert.match(out, /\[redacted\]/);

  // Real labels survive untouched — the report is useless if it redacts the thing it exists to find.
  for (const label of ["Generate", "Manage App Passwords", "Remove", "Revoke access", "Phoenix email", "Delete"]) {
    assert.equal(redactLabel(label, [MINTED, MAILBOX_PASSWORD]), label, `${label} must survive`);
  }

  // The shape rule's boundary, stated once so a later tweak is visible.
  assert.equal(SECRET_LIKE_MIN_LENGTH, 12);
  assert.equal(looksLikeSecret("a".repeat(SECRET_LIKE_MIN_LENGTH - 1)), false);
  assert.equal(looksLikeSecret("a".repeat(SECRET_LIKE_MIN_LENGTH)), true);
  // Anything with whitespace is prose, not a credential.
  assert.equal(looksLikeSecret("Manage App Passwords"), false);

  // Nothing printable left → null, so the caller drops the row rather than emitting a blank name.
  assert.equal(redactLabel(MINTED, [MINTED]), null);
  assert.equal(redactLabel("   ", []), null);
  assert.equal(redactLabel(null, []), null);

  // Long prose is capped rather than emitted whole.
  const long = redactLabel("word ".repeat(40), []) ?? "";
  assert.ok(long.length <= MAX_LABEL_LENGTH, "a long label is capped");
}

function runReportCases(): void {
  const observed: ObservedControl[] = [
    { name: "", role: "button", text: "Generate" },
    { name: "Manage App Passwords", role: "a", text: "Manage App Passwords" },
    // The row that is displaying the freshly minted password.
    { name: "", role: "div", text: MINTED },
    { name: "App password", role: "input", text: "" },
    { name: "", role: "button", text: "Remove" },
    // A duplicate, which must collapse so the report stays readable.
    { name: "", role: "button", text: "Remove" },
  ];

  const report = buildControlReport("app-passwords", observed, [MINTED, MAILBOX_PASSWORD]);
  const joined = report.controls.join(" || ");

  // 🔴 THE HEADLINE, at the level the caller actually logs.
  assert.equal(joined.toLowerCase().includes(MINTED.toLowerCase()), false,
    "the minted password must not appear anywhere in the report");

  // The controls a locator needs did survive.
  assert.match(joined, /button: Generate/);
  assert.match(joined, /Manage App Passwords/);
  assert.match(joined, /button: Remove/);
  assert.match(joined, /input: App password/);

  // Counts are reported, so a silent drop is visible rather than looking like an empty page.
  assert.equal(report.observed, 6);
  assert.equal(report.redacted, 1, "the password-bearing row is dropped and counted");
  assert.equal(report.page, "app-passwords");
  // The duplicate collapsed.
  assert.equal(report.controls.filter((l) => l === "button: Remove").length, 1);

  // An empty page reports emptily rather than throwing.
  const none = buildControlReport("app-passwords", [], []);
  assert.deepEqual(none.controls, []);
  assert.equal(none.observed, 0);
}

function runFlagCases(): void {
  assert.equal(CONTROL_REPORT_ENV, "PHOENIX_TURBIFY_REPORT_CONTROLS");
  assert.equal(controlReportEnabled("true"), true);
  // 🔴 Anything else is OFF — this writes page structure into a production log.
  for (const value of [undefined, "", "TRUE", "1", "yes", "false", " true ", "on"]) {
    assert.equal(controlReportEnabled(value), value === " true " ? true : false,
      `${JSON.stringify(value)} must not switch the report on`);
  }
}

function runReadExpressionCases(): void {
  // 🔴 The page-reading expression must never reach for the places the password actually is. This is
  // the first line of defence; the redaction is the second.
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /\.value\b/, "must never read an input's value");
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /innerText/, "must never read innerText of a container");
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /document\.body/, "must never dump the whole body");
  // It reads textContent, capped.
  assert.match(CONTROL_READ_EXPRESSION, /textContent/);
  assert.match(CONTROL_READ_EXPRESSION, /slice\(0, 64\)/);
  // And it clicks nothing.
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /\.click\(|submit\(/, "the reader must never act on the page");
}

/**
 * The structural path — added 2026-10-04 so `existingList` and `emptyState` can be calibrated.
 *
 * Those two controls are plain TEXT on a page whose text is a credential, so the reader is
 * forbidden to read them and the first live run filled one placeholder of four. A path names them
 * from attributes alone. These cases hold that bargain: the path must carry no secret, and it must
 * not have quietly become a second way to read the page.
 */
function runSelectorCases(): void {
  // 🔴 FIRST, THE RULE `redactLabel` COULD NOT HAVE ENFORCED — and the reason these are two
  // functions. A path has no whitespace inside a segment, so `redactLabel` would judge even an
  // innocent one as a single long token and drop the WHOLE path, taking the locator with it.
  // Asserted before anything else so that collapsing the split is caught HERE, by the case that
  // explains it, rather than further down by a match that only looks like a different fault.
  assert.equal(looksLikeSecret("div.app-password-row"), true,
    "a perfectly innocent path segment is long and space-free, i.e. secret-SHAPED");
  assert.equal(redactSelector("div.list > div.app-password-row > button.x", []),
    "div.list > div.app-password-row > button.x",
    "the path must survive the shape rule that would have eaten it whole as one label");

  // 🔴 AND A LONG ENGLISH WORD INSIDE A CLASS SURVIVES TOO. `notifications` is 13 characters with
  // no space, so the bare shape rule drops it and the path loses the only class worth having.
  // This is the case that made `looksLikePathWord` necessary rather than nice.
  assert.equal(looksLikeSecret("notifications"), true, "13 characters, no space — secret-SHAPED");
  assert.equal(looksLikePathWord("notifications"), true, "...but spelled like English");
  assert.equal(redactSelector("div.notifications-panel > button", []), "div.notifications-panel > button",
    "an ordinary long word in a class must not be mistaken for a credential");

  // The discriminator in both directions, so it cannot be widened into uselessness.
  assert.equal(looksLikePathWord(MINTED), false, "vowel-starved: not a word");
  assert.equal(looksLikePathWord("ZmFrZS1zZWNyZXQ"), false, "mixed case and a digit: not a word");
  assert.equal(looksLikePathWord("app"), true);

  // 🔴 A DROPPED PART IS REMOVED, NOT MARKED. A marker would name a class that does not exist, so
  // the path would stop being a selector at the exact moment it is pinned as one.
  const withSecretId = redactSelector(`div#pw-${MINTED} > button.rm`, [MINTED]) ?? "";
  assert.doesNotMatch(withSecretId, /redacted/, "no marker is left inside a path");
  assert.equal(withSecretId, "div > button.rm", "the path stays a usable selector after the drop");

  // 🔴 THE EXACT-MATCH BRANCH, ON ITS OWN. This secret is 10 characters, so the shape rule does
  // NOT reach it — only the secrets the caller passed do. Without a case this short the exact match
  // could be deleted outright and every other assertion here would still pass, because the minted
  // password is long enough to be caught twice over.
  assert.equal(looksLikeSecret(MAILBOX_PASSWORD), false, "too short for the shape rule to see");
  const shortInPath = redactSelector(`div#${MAILBOX_PASSWORD} > button.rm`, [MAILBOX_PASSWORD]) ?? "";
  assert.equal(shortInPath.includes(MAILBOX_PASSWORD), false,
    "a secret too short for the shape rule must still be removed from the path by exact match");

  // THE HEADLINE, AGAIN, FOR THE PATH. An id or a class is an ordinary place for a credential row
  // to put the credential.
  const pathWithSecret = `div#pw-${MINTED} > button.remove:nth-of-type(2)`;
  const cleaned = redactSelector(pathWithSecret, [MINTED]) ?? "";
  assert.equal(cleaned.toLowerCase().includes(MINTED.toLowerCase()), false,
    "a secret sitting in an id must not survive in the path");
  // What is left still locates the button, which is the entire value of keeping it.
  assert.match(cleaned, /button\.remove:nth-of-type\(2\)/);

  // A secret nobody passed is dropped on shape alone, exactly as a label would be.
  const unknownId = "div#ZmFrZS1zZWNyZXQtdmFs > button";
  assert.equal((redactSelector(unknownId, []) ?? "").includes("ZmFrZS1zZWNyZXQtdmFs"), false,
    "a secret-shaped id must be dropped without being named as a secret");

  // Nothing usable left means no path at all, rather than a row of [redacted] that reads located.
  assert.equal(redactSelector(MINTED, [MINTED]), null,
    "a path that was nothing but the secret must be omitted, not emitted as [redacted]");
  assert.equal(redactSelector("", []), null);
  assert.equal(redactSelector(null, []), null);

  // Long paths are capped.
  const long = `${"div.a > ".repeat(60)}button`;
  assert.ok((redactSelector(long, []) ?? "").length <= MAX_SELECTOR_LENGTH);

  // 🔴 THE AMBIGUITY THE FIRST RUN LEFT BEHIND, closed. Two Remove buttons used to collapse into
  // one line, so one app password and five printed identically — which is why `existingList` could
  // not be told from `emptyState`. Pathed, they stay apart and the count is readable.
  const twoEntries: ObservedControl[] = [
    { name: "", role: "button", selector: "div.list > div.row:nth-of-type(1) > button.rm", siblings: 2, text: "Remove" },
    { name: "", role: "button", selector: "div.list > div.row:nth-of-type(2) > button.rm", siblings: 2, text: "Remove" },
  ];
  const listed = buildControlReport("app-passwords", twoEntries, [MINTED]);
  assert.equal(listed.controls.length, 2, "two entries must report as two, not collapse into one");
  assert.equal(listed.controls.filter((l) => l.includes("×2")).length, 2, "the sibling count rides along");

  // A control with no path reports exactly as it always did — the old shape is untouched.
  const pathless = buildControlReport("app-passwords", [{ name: "", role: "button", text: "Generate" }], []);
  assert.deepEqual(pathless.controls, ["button: Generate"]);
}

function runReadExpressionSelectorCases(): void {
  // The reader builds the path from ATTRIBUTES, never from text.
  assert.match(CONTROL_READ_EXPRESSION, /nth-of-type/);
  assert.match(CONTROL_READ_EXPRESSION, /parentElement/);
  assert.match(CONTROL_READ_EXPRESSION, /selector: pathOf\(el\)/);

  // 🔴 AND THE BARGAIN THE PATH WAS ALLOWED ON: it added no second reading of the page's text.
  // `textContent` is read exactly once, in the one capped place it was already read.
  const reads = CONTROL_READ_EXPRESSION.match(/textContent/g) ?? [];
  assert.equal(reads.length, 1, "the path must not have introduced a second read of the page's text");
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /\.value\b/, "still never an input's value");
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /innerText|outerHTML|document\.body/,
    "still never a container's rendered text or markup");
  assert.doesNotMatch(CONTROL_READ_EXPRESSION, /\.click\(|submit\(/, "the reader must never act on the page");
}

export function runTurbifyControlReportTests(): void {
  runRedactionCases();
  runReportCases();
  runFlagCases();
  runReadExpressionCases();
  runSelectorCases();
  runReadExpressionSelectorCases();
}
