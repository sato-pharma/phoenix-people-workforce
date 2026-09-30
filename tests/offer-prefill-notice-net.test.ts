import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The offer prefill's notice states the net salary it actually filled in (owner, 2026-09-29).
 *
 * ── Why this exists ──
 * That evening the owner reported the salary boxes blank on an Add Employee opened from an accepted
 * offer, and said he had to type them by hand. Every link was verified and every one was correct:
 * the endpoint returned `netSalary: "18000"` for that exact offer, run through the deployed code
 * against live data; the seat effect provably cannot fire on a `fromOffer`-only URL; nothing else
 * writes the form without a click. And the notice he saw is printed on the line AFTER the form is
 * set, inside the same `try` — so the fill had run.
 *
 * The one thing nobody could say was what landed in the form's own state. So a correct prefill and
 * a broken render produced identical evidence, and the question could not be settled from either
 * side. This makes them different: a notice naming the net beside an empty box is a rendering
 * fault and nothing else; a notice saying the offer carried no salary is a data fault.
 *
 * These assertions are about that distinction surviving. It is instrumentation on a message, not a
 * change to how any money is computed — no figure here is derived, only reported.
 */
export function runOfferPrefillNoticeNetTests() {
  const source = readFileSync("src/components/employees/employee-management.tsx", "utf8");

  // ── 1 · The notice reports the FORM, not the response ───────────────────────────────────────
  //
  // The whole point. Reading the draft would describe what arrived over the wire, which was never
  // in doubt; reading `filled` describes the state the boxes render from, which is what was.
  assert.match(
    source,
    /const filled = withSalaryAutofill\(\{ \.\.\.emptyForm, \.\.\.payload\.draft \}, new Set\(\)\);\s*\n\s*setForm\(filled\);/,
    "the filled form is held and set, so the notice can describe it",
  );
  assert.match(
    source,
    /const netFilled = Number\(filled\.netSalary\);/,
    "the net figure is read off the FILLED FORM — reading payload.draft would prove nothing about the boxes",
  );

  // ── 2 · Both outcomes are said out loud ─────────────────────────────────────────────────────
  //
  // Silence is what made this unfalsifiable: a prefill that carried no salary and one that carried
  // 18,000 into a box that would not render both produced a notice with nothing to say about money.
  assert.match(
    source,
    /Net salary \$\{netFilled\.toLocaleString\("en-US"\)\}/,
    "a filled salary names the number, so an empty box beside it is unambiguous",
  );
  assert.match(
    source,
    /The offer carried no salary, so every salary box is blank/,
    "and an offer with no salary says so, rather than leaving the reader to guess",
  );

  // ── 3 · It is a REPORT, never a second opinion on the money ─────────────────────────────────
  //
  // `deriveSalaryFromNet` (through withSalaryAutofill) stays the only thing that turns a package
  // into figures. If this sentence ever started computing one, it would be a fourth voice on pay
  // sitting in a toast — which is exactly what src/lib/offers/pay.ts warns against.
  // The end marker is searched FROM the start index, never from 0: the recruitment-application
  // effect above this one ends with the identical `generateEmployeeId` call, so a bare indexOf
  // finds THAT one, returns an index before the block begins, and slices an empty string — which
  // would make every assertion below pass against nothing.
  const blockStart = source.indexOf("const filled = withSalaryAutofill");
  const noticeBlock = source.slice(
    blockStart,
    source.indexOf("void generateEmployeeId(payload.draft.lineId", blockStart),
  );
  assert.ok(noticeBlock.length > 0, "the prefill block must still be here — re-point this test if it moved");
  for (const forbidden of ["deriveSalaryFromNet", "BASIC_SALARY_RATE", "* 0.7", "0.7 *"]) {
    assert.ok(
      !noticeBlock.includes(forbidden),
      `the notice must not compute salary itself (found ${forbidden}) — it reports what the form already holds`,
    );
  }

  // ── 4 · Zero and nonsense read as "no salary", not as a figure ──────────────────────────────
  //
  // A notice reading "Net salary 0" would look like a real answer on a form that pays somebody.
  assert.match(
    source,
    /Number\.isFinite\(netFilled\) && netFilled > 0/,
    "only a real positive number is reported as a salary",
  );

  // ── 5 · The four sentences stay separable ───────────────────────────────────────────────────
  //
  // Joined from parts rather than written as four near-identical template literals, which is what
  // let the seat wording drift out of step with the rest before this.
  //
  // THREE became FOUR on 2026-09-30, when the offer door started carrying the CV of the candidate
  // the letter was written for. `cvSentence` is the only conditional one — it is "" when no
  // candidate points at the letter (nine of production's 27) or when their record is bare, because a
  // sentence about a CV nobody read is worse than silence: it would tell somebody the personal boxes
  // are filled when those are the ones still to type. `.filter(Boolean)` is what makes it vanish.
  assert.match(
    source,
    /setNotice\(\[opening, seatSentence, salarySentence, cvSentence\]\.filter\(Boolean\)\.join\(" "\)\)/,
    "one notice assembled from four named sentences, so none can silently disappear",
  );
  assert.match(
    source,
    /carried\.length > 0 \? `From their CV: \$\{carried\.join\(", "\)\}/,
    "the CV sentence NAMES what was carried — a bare 'filled from the CV' cannot be checked against the boxes",
  );
}
