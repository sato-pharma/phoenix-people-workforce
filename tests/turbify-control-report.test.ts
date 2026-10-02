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
  looksLikeSecret,
  MAX_LABEL_LENGTH,
  redactLabel,
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

export function runTurbifyControlReportTests(): void {
  runRedactionCases();
  runReportCases();
  runFlagCases();
  runReadExpressionCases();
}
