import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  bracketTokens,
  buildPolishPrompt,
  cleanPolishedBody,
  cleanPolishedSubject,
  emailPlainText,
  findPolishViolations,
  linkTargets,
  numericTokens,
  parseSatoAssistMode,
  SATO_ASSIST_MAX_INSTRUCTION_CHARS,
  SATO_POLISH_MAX_SUBJECT_CHARS,
  SATO_WRITE_INSTRUCTIONS,
  senderWriting,
  unverifiedFigures,
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

  // An image address is a link the reader never has to click — it loads on open. Once the model
  // was taught the Insert image tool, `src` had to count exactly as `href` does.
  assert.deepEqual(linkTargets('<img src="https://Cdn.Example/Poster.png" />'), ["https://cdn.example/poster.png"]);

  const mintedImage = findPolishViolations(
    { bodyHtml: '<p>See the poster.</p><img src="https://cdn.example/poster.png" alt="" />', subject: "Poster" },
    { bodyHtml: "<p>see the poster</p>", subject: "Poster" },
  );
  assert.ok(
    mintedImage.some((violation) => /links nobody wrote/.test(violation)),
    `an image address the sender never wrote fetches from a server nobody chose, and must be refused, got ${JSON.stringify(mintedImage)}`,
  );

  // The sender's own image survives — the guard is "nothing new", not "no pictures".
  const senderImage = findPolishViolations(
    { bodyHtml: '<p>The poster.</p><img src="https://cdn.example/poster.png" alt="" />', subject: "Poster" },
    { bodyHtml: '<p>heres the poster</p><img src="https://cdn.example/poster.png" />', subject: "Poster" },
  );
  assert.deepEqual(senderImage, [], "an image the sender himself pasted must survive the rewrite");

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

  runSatoEmailWriteTests();
}

/**
 * WRITE MODE — THE ASSISTANT THAT ACTUALLY WRITES THE EMAIL.
 *
 * Owner 2026-09-17: "I want to be able to tell it write a job offer to someone whose area will be
 * like this ... I wanted a real assistant, a real AI assist, not a fucking do nothing."
 *
 * The rewrite guards above are exactly what made it a do-nothing when he asked it to WRITE: an
 * email composed from his instruction is, by definition, full of words that are not in the body he
 * never typed. So write mode moves two of the five guards — the invented figure and the filled-in
 * gap — from "refuse the draft" to "name it on screen", and counts his typed instruction as his own
 * writing. The three that stay are the three that cannot be made safe by reading them: an empty
 * draft, a draft that names the assistant, and an address nobody wrote.
 *
 * These pin that division. If a later change quietly restores the old refusals, the assistant goes
 * back to handing him nothing and these go red first.
 */
function runSatoEmailWriteTests() {
  // -- the mode itself -------------------------------------------------------------------------

  assert.equal(parseSatoAssistMode("write"), "write");
  for (const value of ["rewrite", "", "WRITE", undefined, null, 1, {}]) {
    assert.equal(parseSatoAssistMode(value), "rewrite", `anything but the exact word "write" is a rewrite`);
  }

  // -- 🔴 what he typed in the box IS his writing ----------------------------------------------

  const asked = {
    bodyHtml: "",
    instruction: "write a job offer for Ahmed Samir, medical rep, Giza, basic 9000, starting 1 October",
    subject: "",
  };
  assert.ok(
    /9000/.test(senderWriting(asked)),
    "the instruction is the sender's own writing — a figure he typed there is his, not an invention",
  );

  const fromInstruction = findPolishViolations(
    {
      bodyHtml: "<p>We are pleased to offer you the role of medical representative in Giza, at a basic salary of 9,000 EGP, starting 1 October.</p>",
      subject: "Job offer",
    },
    asked,
    "write",
  );
  assert.deepEqual(
    fromInstruction,
    [],
    `the email he asked for, built only from figures he typed, must be handed back — got ${JSON.stringify(fromInstruction)}`,
  );

  // The same draft in REWRITE mode is still his own figures, so it passes there too — the guard
  // that changed is about figures NOBODY wrote, not about which box he wrote them in.
  assert.deepEqual(findPolishViolations({ bodyHtml: "<p>Basic 9000.</p>", subject: "Offer" }, asked), []);

  // -- write mode reports an invented figure, it does not throw the email away ------------------

  const guessed = {
    bodyHtml: "<p>Your probation period is 3 months and your annual leave is 21 days.</p>",
    subject: "Job offer",
  };
  assert.deepEqual(
    findPolishViolations(guessed, asked, "write"),
    [],
    "🔴 a figure it added is NOT a refusal in write mode — refusing would hand him back no email at all",
  );
  assert.deepEqual(
    unverifiedFigures(guessed, asked).sort(),
    ["21", "3"],
    "it is reported instead, so he reads every figure he did not dictate before the email goes out",
  );

  // Rewrite mode is unchanged: there, the same draft is refused.
  assert.ok(
    findPolishViolations(guessed, asked).some((violation) => /figures nobody wrote/.test(violation)),
    "rewrite mode must still refuse a figure nobody wrote — this change never loosened that path",
  );

  // A [square bracket] gap is what a well-behaved draft leaves instead, and it reports nothing.
  assert.deepEqual(
    unverifiedFigures({ bodyHtml: "<p>Probation is [probation period].</p>", subject: "Job offer" }, asked),
    [],
    "a gap left for him to fill is the right answer to a fact nobody gave it",
  );

  // -- the three guards that hold in BOTH modes ------------------------------------------------

  const mintedInWrite = findPolishViolations(
    {
      bodyHtml: '<p>Accept through <a href="https://offers.satopharma.com/accept">this link</a>.</p>',
      subject: "Job offer",
    },
    asked,
    "write",
  );
  assert.ok(
    mintedInWrite.some((violation) => /links nobody wrote/.test(violation)),
    `🔴 a minted URL stays a refusal in write mode — a phishing-shaped link is not made safe by being asked for, got ${JSON.stringify(mintedInWrite)}`,
  );

  // A link he pasted into the instruction is his, exactly as one in the body would be.
  assert.deepEqual(
    findPolishViolations(
      { bodyHtml: '<p>Apply at <a href="https://phoenix-hr.satopharma.com/portal">the portal</a>.</p>', subject: "Apply" },
      { bodyHtml: "", instruction: "tell them to apply at https://phoenix-hr.satopharma.com/portal", subject: "" },
      "write",
    ),
    [],
    "an address he pasted into the instruction box is an address he wrote",
  );

  const namedInWrite = findPolishViolations(
    { bodyHtml: "<p>This offer was prepared with AI assistance.</p>", subject: "Job offer" },
    asked,
    "write",
  );
  assert.ok(
    namedInWrite.some((violation) => /named the assistant/.test(violation)),
    "owner rule 2026-08-04 holds in both modes — a recipient never learns a model was involved",
  );

  const emptyInWrite = findPolishViolations({ bodyHtml: "<p> </p>", subject: "" }, asked, "write");
  assert.ok(emptyInWrite.some((violation) => /body came back empty/.test(violation)), "an empty body is still refused");

  // -- the prompt carries his request, and the body may be empty --------------------------------

  const writePrompt = buildPolishPrompt({ bodyHtml: "", instruction: asked.instruction, mode: "write", subject: "" });
  assert.ok(writePrompt.includes(asked.instruction), "write mode's prompt is built around what he asked for");
  assert.match(writePrompt, /body is empty/i, "an empty body is the normal case in write mode, not an error");

  // A briefing arrives as a list of points; flattening it would merge three terms into one.
  assert.match(
    buildPolishPrompt({ bodyHtml: "", instruction: "line one\nline two", mode: "write", subject: "" }),
    /line one\nline two/,
    "the line breaks in his briefing survive into the prompt",
  );

  assert.ok(
    SATO_ASSIST_MAX_INSTRUCTION_CHARS >= 4_000,
    "a briefing is not a nudge — the old 200-character box could not hold a job offer's terms",
  );

  // -- the write prompt says the one thing that makes this safe --------------------------------

  assert.match(
    SATO_WRITE_INSTRUCTIONS,
    /\[square bracket\] gap/,
    "🔴 the rule that lets it write a job offer without inventing the salary must be in the prompt",
  );
  assert.match(SATO_WRITE_INSTRUCTIONS, /never mint a link/i, "and the rule that keeps a minted link out of it");

  // -- the screen and the route agree on the briefing length ------------------------------------

  const composer = readFileSync("src/components/admin/sato-email-composer.tsx", "utf8");
  assert.match(
    composer,
    new RegExp(`ASSIST_INSTRUCTION_MAX_CHARS = ${SATO_ASSIST_MAX_INSTRUCTION_CHARS.toLocaleString("en-US").replace(",", "_")}`),
    "the composer's own cap must match the server's, or he types words the route silently cuts",
  );
  assert.match(composer, /mode: assistMode/, "the mode must actually reach the route — without it every press rewrites");
  assert.match(
    composer,
    /void polish\("write"\)/,
    'the screen must offer Write it, which is the button the owner asked for on 2026-09-17',
  );
}
