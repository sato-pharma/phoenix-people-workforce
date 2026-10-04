// Recruitment / ATS — hiding the phone number that is printed ON the CV itself.
//
// THE HOLE THIS CLOSES, AND WHY IT WAS INVISIBLE. On 2026-09-09 the owner asked for the phone
// number to be hidden on every CV in a manager's portal. The field was hidden, the payload was
// redacted, and the number was still there in enormous type the moment he pressed View CV: a CV
// prints its own contact details. His words: *"when I press on view the CV the number is clearly
// showing"*.
//
// It is the repo's own standing lesson in a new shape — VERIFY THE EMITTED ARTIFACT, NEVER THE
// SOURCE. Everything measurable had been measured. What nobody looked at was the thing the manager
// actually reads.
//
// WHAT COUNTS AS A NUMBER TO HIDE. Deliberately WIDER than "an Egyptian mobile". A CV carries the
// number in every shape a person can type: +201091929363, 0100 587 2847, 0100-587-2847, (+20)
// 100 782 3412, and the same again in Arabic-Indic digits. Matching one canonical form and missing
// the rest is worse than not trying, because the screen then looks redacted and is not.
//
// So the rule is a RUN OF DIGITS, nine or more once the separators are taken out. That is long
// enough that ordinary CV numbers survive untouched — a year (2022), a month range (08 / 2025), a
// salary (15000), a graduation grade — and short enough to catch every phone shape plus a 14-digit
// national ID, which is PII this screen has no business showing either.
//
// PURE. No DOM, no pdf.js, no React: the PDF path measures spans on a canvas and the Word path
// walks text nodes, and both have to agree about what a number IS. The test pins the shapes.

/** How many digits a run must carry before it is treated as a phone number. */
export const PHONE_LIKE_MIN_DIGITS = 9;

/**
 * A candidate run: an optional +, then digits mixed with the separators people actually type.
 *
 * The run must START and END on a digit so a trailing bracket or dash is not swallowed, and the
 * digit count is checked afterwards rather than in the pattern — expressing "nine digits ignoring
 * separators" as a regex is where this would quietly stop matching a spacing nobody predicted.
 */
// The separator class holds ONLY the characters that sit inside a typed phone number, and the
// hyphen is last so it is a literal rather than the start of a range. Spaces are the two real ones
// rather than \s: \s includes a newline, and a run allowed to cross lines would swallow a whole
// paragraph the moment a CV happened to end one line with a digit and start the next with another.
const RUN = /\+?[\d٠-٩۰-۹][\d٠-٩۰-۹  ().‐‑‒–—-]*[\d٠-٩۰-۹]/g;

function digitCount(value: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") count += 1;
    else if (/[٠-٩۰-۹]/.test(ch)) count += 1;
  }
  return count;
}

/**
 * A DASH WITH SPACES ROUND IT JOINS TWO THINGS; A DASH WITHOUT THEM IS INSIDE ONE.
 *
 * Measured on a real CV, 2026-09-09: `10-2024 - 4-2025` is a date range, and it carries eleven
 * digits, so the plain rule blacked out somebody's employment dates. Nobody would report that as a
 * bug — the CV would simply look damaged, and the feature would get switched off.
 *
 * So a run is split here before it is judged, and each side is judged alone: `10-2024` and `4-2025`
 * are six and five digits and survive. A phone number never contains a spaced dash — `0100-587-2847`
 * and `+20 100 587 2847` are both untouched by this — and the one shape that would, two numbers
 * written as a range, still has each half masked on its own merits.
 */
const RANGE_SEPARATOR = /[  ][-‐‑‒–—][  ]/;

/** Where the phone-like runs are in this string. Empty when there are none. */
export function findPhoneLikeSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  if (!text) return spans;
  RUN.lastIndex = 0;
  for (const match of text.matchAll(RUN)) {
    const value = match[0];
    const base = match.index ?? 0;
    // Walk the pieces, keeping each one's offset, so a span still indexes the ORIGINAL string — a
    // mask computed against a split copy would blank the wrong characters.
    let offset = 0;
    for (const piece of value.split(RANGE_SEPARATOR)) {
      const at = value.indexOf(piece, offset);
      offset = at + piece.length;
      const trimmed = piece.replace(/^[^\d٠-٩۰-۹+]+|[^\d٠-٩۰-۹]+$/g, "");
      if (!trimmed || digitCount(trimmed) < PHONE_LIKE_MIN_DIGITS) continue;
      const start = base + at + piece.indexOf(trimmed);
      spans.push({ end: start + trimmed.length, start, text: trimmed });
    }
  }
  return spans;
}

/** True when this string carries something that must not be shown. */
export function hasPhoneLike(text: string): boolean {
  return findPhoneLikeSpans(text).length > 0;
}

/**
 * The same string with every phone-like run replaced by a block of the SAME visible length.
 *
 * Same length on purpose: a Word CV is a laid-out page, and swapping a thirteen-character number
 * for the word "hidden" reflows the line it sits on. A reader should see that something has been
 * taken out, in the place it was, and read the rest of the page exactly as it was written.
 */
export function maskPhoneLike(text: string, fill = "█"): string {
  const spans = findPhoneLikeSpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + fill.repeat(span.text.length);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
