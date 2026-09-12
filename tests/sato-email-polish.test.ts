import assert from "node:assert/strict";

import {
  bracketTokens,
  cleanPolishedBody,
  cleanPolishedSubject,
  emailPlainText,
  findPolishViolations,
  linkTargets,
  numericTokens,
  SATO_POLISH_MAX_SUBJECT_CHARS,
} from "../src/lib/sato-email/polish.ts";

/**
 * THE REWRITE CHANGES WORDING AND NOTHING ELSE.
 *
 * Owner 2026-09-12: "i write what i want and it enhance rephrase more to the point more corporate".
 * The danger in granting that wish on THIS screen is that the Sato composer mails a whole
 * distribution list at once: a fabricated effective date, a fabricated figure or a fabricated link,
 * written in confident corporate prose, is far more damaging than the clumsy sentence it replaced.
 *
 * So these pin the refusal, not the rewrite. Each one asserts that a candidate carrying something
 * the sender never wrote is REJECTED rather than handed back looking plausible.
 */
export function runSatoEmailPolishTests() {
  // -- the words of a body, with the markup and its numbers out of the way --------------------

  const styled =
    '<p style="font-size:18px;color:#0A527D">The office closes at 3 PM</p><ul><li>Bring 2 copies</li></ul>';
  const text = emailPlainText(styled);
  assert.ok(/The office closes at 3 PM/.test(text), "the sender's words survive");
  assert.ok(!/font-size|0A527D/i.test(text), "a style attribute is not the sender's writing");
  assert.deepEqual(
    numericTokens(text).sort(),
    ["2", "3"],
    "only the figures a reader actually sees count as figures the sender wrote — 18 and the hex are markup",
  );

  assert.deepEqual(numericTokens("1,250.00 and 1250 and 1250.0"), ["1250", "1250", "1250"], "one value, three spellings");

  // -- a figure nobody wrote -------------------------------------------------------------------

  const sender = {
    bodyHtml: "<p>The office will close early on Thursday for the holiday.</p>",
    subject: "Early closing",
  };

  assert.deepEqual(
    findPolishViolations(
      { bodyHtml: "<p>The office closes early on Thursday for the holiday.</p>", subject: "Early closing on Thursday" },
      sender,
    ),
    [],
    "a pure rephrase passes — same facts, fewer words",
  );

  const inventedHour = findPolishViolations(
    { bodyHtml: "<p>The office closes at 2 PM on Thursday for the holiday.</p>", subject: "Early closing" },
    sender,
  );
  assert.ok(
    inventedHour.some((violation) => /figures nobody wrote \(2\)/.test(violation)),
    `an invented closing time must be refused, got ${JSON.stringify(inventedHour)}`,
  );

  // A figure the sender DID write is his to keep, in either field.
  assert.deepEqual(
    findPolishViolations(
      { bodyHtml: "<p>The office closes at 2 PM on Thursday.</p>", subject: "Early closing" },
      { bodyHtml: "<p>we close 2 pm thursday coz of the holiday</p>", subject: "Early closing" },
    ),
    [],
    "his own figure, rewritten around, is not an invention",
  );

  // -- a gap it filled in by itself ------------------------------------------------------------

  assert.deepEqual(bracketTokens("Effective [date] across [ Department ]"), ["[date]", "[ department ]"]);

  const filledGap = findPolishViolations(
    { bodyHtml: "<p>The policy takes effect on 1 October.</p>", subject: "Policy update" },
    { bodyHtml: "<p>The policy takes effect on [date].</p>", subject: "Policy update" },
  );
  assert.ok(
    filledGap.some((violation) => /gaps it filled in by itself \(\[date\]\)/.test(violation)),
    `a [square bracket] the sender still has to fill may never be answered for him, got ${JSON.stringify(filledGap)}`,
  );

  // -- a link nobody wrote ---------------------------------------------------------------------

  assert.deepEqual(linkTargets('<a href="https://Portal.example/Leave">apply</a>'), ["https://portal.example/leave"]);

  const mintedLink = findPolishViolations(
    { bodyHtml: '<p>Apply through <a href="https://portal.satopharma.com/leave">the portal</a>.</p>', subject: "Leave" },
    { bodyHtml: "<p>apply through the portal</p>", subject: "Leave" },
  );
  assert.ok(
    mintedLink.some((violation) => /links nobody wrote/.test(violation)),
    `an invented URL in a company-wide email is phishing-shaped and must be refused, got ${JSON.stringify(mintedLink)}`,
  );

  // -- the reader never learns a model was involved ---------------------------------------------

  const named = findPolishViolations(
    { bodyHtml: "<p>This announcement was drafted with AI assistance.</p>", subject: "Notice" },
    { bodyHtml: "<p>announcement</p>", subject: "Notice" },
  );
  assert.ok(
    named.some((violation) => /named the assistant/.test(violation)),
    `owner rule 2026-08-04 — a user never learns a model was involved, got ${JSON.stringify(named)}`,
  );

  // -- an empty rewrite is a failure, not a blank email -----------------------------------------

  const emptied = findPolishViolations({ bodyHtml: "<p>  </p>", subject: "" }, sender);
  assert.ok(emptied.some((violation) => /body came back empty/.test(violation)), "an empty body is refused");
  assert.ok(emptied.some((violation) => /subject came back empty/.test(violation)), "an empty subject is refused");

  // -- cleanup: the body can only carry markup the house design renders -------------------------

  const cleaned = cleanPolishedBody(
    '```html\n<div><h2>Scope</h2><p onclick="x()">Everyone</p><script>alert(1)</script></div>\n```',
    "<p>everyone</p>",
  );
  assert.ok(!/```/.test(cleaned), "a code fence is packaging, not content");
  assert.ok(!/<script|onclick/i.test(cleaned), "the same sanitizer every other body passes");
  assert.match(
    cleaned,
    /font-size:18px;font-weight:bold/,
    "an <h2> becomes the bold paragraph the house template turns into a section rule and label",
  );

  // -- cleanup: one sign-off, never two ---------------------------------------------------------

  assert.ok(
    !/Best regards/i.test(cleanPolishedBody("<p>The office closes early.</p><p>Best regards,<br>HR</p>", "<p>we close early</p>")),
    "the composer has its own Signed field and the frame prints it — a second sign-off signs the email twice",
  );
  assert.match(
    cleanPolishedBody("<p>The office closes early.</p><p>Best regards,<br>Omar</p>", "<p>we close early</p><p>best regards, Omar</p>"),
    /Best regards/i,
    "but a sign-off the SENDER wrote is his wording to keep",
  );

  // -- cleanup: a subject is one line, and is never elided with an ellipsis ----------------------

  assert.equal(cleanPolishedSubject('  "<strong>Early closing</strong>\n on Thursday"  '), "Early closing on Thursday");
  const long = cleanPolishedSubject(`${"word ".repeat(80)}end`);
  assert.ok(long.length <= SATO_POLISH_MAX_SUBJECT_CHARS, "never longer than the send route accepts");
  assert.ok(!/…|\.\.\./.test(long), "the owner's standing rule — no text in this system is elided with an ellipsis");
}
