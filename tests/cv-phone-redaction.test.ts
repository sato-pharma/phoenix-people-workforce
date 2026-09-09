import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  findPhoneLikeSpans,
  hasPhoneLike,
  maskPhoneLike,
  PHONE_LIKE_MIN_DIGITS,
} from "../src/lib/recruitment/cv-phone-redaction.ts";

/**
 * "When I press on view the CV the number is clearly showing."
 *
 * The owner, 2026-09-09, with a screenshot of a CV printing +201091929363 in 14pt beside a telephone
 * icon — on the screen that had just hidden the phone field, blanked it out of the payload and
 * removed the download.
 *
 * THE HOLE WAS NOT A BUG IN ANY OF THAT. Every one of those worked. What nobody checked was the
 * thing the manager actually reads: a CV carries its own contact details, so hiding the database
 * column achieved nothing the moment he opened the document. It is this repo's own standing lesson
 * — VERIFY THE EMITTED ARTIFACT, NEVER THE SOURCE — in a shape that had not been seen before.
 *
 * THREE PROPERTIES THIS FILE HOLDS STILL.
 *
 * EVERY SHAPE A PERSON TYPES A NUMBER IN. Not "an Egyptian mobile": a CV carries +20…, 010…, spaced,
 * dashed, bracketed, and the same again in Arabic-Indic digits. Matching one canonical form and
 * missing the rest is worse than not trying, because the screen then LOOKS redacted and is not.
 *
 * AND NOTHING ELSE. A run of nine digits is the line, so the years, month ranges, salaries and
 * grades that fill a CV survive untouched. Over-redaction has no alarm either — it just quietly
 * makes CVs unreadable and the feature gets turned off.
 *
 * AND IT IS ACTUALLY APPLIED, TO BOTH RENDERERS AND TO NEITHER'S EXCEPTION. The pure function being
 * correct is worth nothing if the PDF path stops calling it, so the wiring is pinned too.
 */
export async function runCvPhoneRedactionTests() {
  // ── 1 · Every shape a number is written in ────────────────────────────────────────────────────
  const mustHide = [
    "+201091929363",
    "01005872847",
    "0100 587 2847",
    "0100-587-2847",
    "(+20) 100 782 3412",
    "+20 100 587 2847",
    "٠١٠٠٥٨٧٢٨٤٧",
    "Mobile: 01119623750",
    "Tel: +20 100 587 2847 (mobile)",
    "29801011234567",
  ];
  for (const value of mustHide) {
    assert.ok(hasPhoneLike(value), `must be recognised as a number to hide: ${value}`);
    assert.ok(
      !/\d{9}/.test(maskPhoneLike(value).replace(/[^\d]/g, "")),
      `no nine-digit run may survive the mask: ${value} -> ${maskPhoneLike(value)}`,
    );
  }

  // ── 2 · And nothing a CV legitimately prints ──────────────────────────────────────────────────
  //
  // Every one of these sits on a real CV a few lines from the phone number. Masking them would make
  // the document unreadable, and an unreadable CV is a feature somebody asks to have switched off.
  const mustSurvive = [
    "08 / 2025 - present.",
    "08/2022- 07/2025",
    "2022",
    "15000 EGP",
    "Grade: 3.4",
    "9 years of experience",
    "Beni swef, Egypt.",
    "Ahmedhassan4919@yahoo.com",
    "B.Sc. Pharmacy 2019",
    // MEASURED ON A REAL CV, 2026-09-09. Eleven digits, so the first version of this rule blacked
    // out an applicant's employment dates. Nobody reports that — the CV just looks damaged.
    "10-2024 - 4-2025",
    "1-2020 - 12-2023",
    "05/2021 - 08/2024",
  ];
  for (const value of mustSurvive) {
    assert.equal(maskPhoneLike(value), value, `must be left exactly as written: ${value}`);
  }

  // ── 3 · The mask keeps the length ─────────────────────────────────────────────────────────────
  //
  // A Word CV is a laid-out page. Swapping a thirteen-character number for the word "hidden" reflows
  // the line it sits on, and the reader is then looking at a document that is not what the applicant
  // wrote. Same length, in the same place, is what makes the removal visible AND harmless.
  const line = "Tel: +201091929363 | Cairo";
  assert.equal(maskPhoneLike(line).length, line.length, "the masked line is the same length");
  assert.ok(maskPhoneLike(line).startsWith("Tel: "), "and everything around the number is untouched");
  assert.ok(maskPhoneLike(line).endsWith(" | Cairo"), "on both sides");

  // ── 4 · The threshold is the rule, and it is stated once ──────────────────────────────────────
  assert.equal(PHONE_LIKE_MIN_DIGITS, 9, "nine digits is the line between a phone and a year");
  assert.ok(!hasPhoneLike("12345678"), "eight digits is not a phone number");
  assert.ok(hasPhoneLike("123456789"), "nine is");

  // A run must not cross a line break, or one CV ending a line with a digit and starting the next
  // with another would black out the paragraph between them.
  assert.equal(maskPhoneLike("2022\n2023"), "2022\n2023", "a run never spans a newline");

  // ── 4b · A range of two real numbers still loses both ─────────────────────────────────────────
  //
  // Splitting on the spaced dash must not become a way to smuggle a number past the mask. Each side
  // is judged on its own merits, so two phone numbers written as a range lose both halves while a
  // date range loses neither.
  {
    const masked = maskPhoneLike("0100-587-2847 - 0111-222-3333");
    assert.ok(!/\d/.test(masked.replace(/ - /, "")), `both numbers in a range are masked: ${masked}`);
    assert.ok(maskPhoneLike("10-2024 - 4-2025") === "10-2024 - 4-2025", "while a date range keeps every digit");
  }

  // ── 5 · Spans are reported in order and inside the string ─────────────────────────────────────
  {
    const text = "call 01005872847 or 01119623750 today";
    const spans = findPhoneLikeSpans(text);
    assert.equal(spans.length, 2, "both numbers on one line are found");
    assert.ok(spans[0].start < spans[1].start, "in the order they appear");
    for (const span of spans) {
      assert.equal(text.slice(span.start, span.end), span.text, "each span indexes its own text");
    }
  }

  // ── 6 · IT IS ACTUALLY WIRED, to both renderers ───────────────────────────────────────────────
  //
  // Read as source because the thing being pinned is that a call still HAPPENS. The pure function
  // above can be perfect while the PDF path quietly stops invoking it, and the screen would look
  // exactly the same as a working one until somebody opens a CV and reads a number off it — which
  // is precisely how this shipped the first time.
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const viewer = read("../src/components/recruitment/cv-preview-modal.tsx");

  assert.ok(
    viewer.includes("hasPhoneLike(textItem.str)"),
    "the PDF path must test each text item — 90% of CVs on record are PDFs",
  );
  assert.ok(
    /context\.fillRect\(/.test(viewer),
    "and must paint over the ones that match, onto the same canvas it just rendered",
  );
  assert.ok(
    viewer.includes("maskPhoneLike(node.nodeValue"),
    "the Word path must mask its text nodes",
  );
  assert.ok(
    /if \(redactPhones\) \{[\s\S]{0,400}?photograph/.test(viewer),
    "a photographed CV cannot be redacted, so it must be refused rather than shown with the number on it",
  );

  // The card must ask for redaction whenever the viewer is NOT the manager holding the reservation.
  // Inverted, this reads as working and hides nothing.
  const actions = read("../src/components/employee-portal/candidate-cv-actions.tsx");
  assert.ok(
    actions.includes("redactPhones={!showPhoneNumbers}"),
    "the manager's CV card must redact unless the viewer holds the claim",
  );
  for (const card of [
    "../src/components/employee-portal/candidate-read-card.tsx",
    "../src/components/employee-portal/recruitment-candidates-portal.tsx",
  ]) {
    assert.ok(
      read(card).includes("showPhoneNumbers={call.mine}"),
      `every card must pass the reservation through to the CV viewer: ${card}`,
    );
  }
}
