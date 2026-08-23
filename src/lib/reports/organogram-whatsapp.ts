/**
 * Turning a stored `employees.mobile_number` into a WhatsApp-dialable number.
 *
 * ## Why this is not a one-liner
 *
 * Measured against production on 2026-08-23, across all 175 rows of
 * `employees.mobile_number`:
 *
 * | shape                                   | rows   | share |
 * | --------------------------------------- | ------ | ----- |
 * | 10 digits, leading zero LOST (`1012…`)  | 124    | 70.9% |
 * | no number on file                       | 26     | 14.9% |
 * | proper local 11 digits (`01012…`)       | 18     | 10.3% |
 * | two numbers in one field, or malformed  | 7      | 4.0%  |
 *
 * The denominator is every employee row, not the active subset — until 2026-08-23 this
 * line read “175 active employees”, which conflated the two (only 112 rows are
 * `employment_status = 'active'`). Do not narrow it back: narrowing does not soften the
 * picture, it sharpens it — 88 of those 112 lost the leading zero, nearly eight in ten.
 *
 * So the raw column is dialable as-is for almost nobody: seven in ten rows lost their
 * leading zero (the classic spreadsheet-import-as-number), and a handful hold two
 * numbers separated by a slash or a dash.
 *
 * ## The rule that matters
 *
 * **Never guess.** A wrong digit here does not render a broken page — it opens a chat
 * with a stranger and invites the user to message them. So an input that cannot be
 * read with confidence returns `null`, the caller renders no button, and the person is
 * reached the way they were before. No button is always better than the wrong chat.
 *
 * That is why a too-long digit run is rejected outright rather than sliced down to a
 * plausible eleven digits: the slice would look valid and be someone else.
 */

/** Egyptian mobile prefixes in service: Vodafone 010, Etisalat 011, Orange 012, WE 015. */
const EGYPT_MOBILE_PREFIX = /^1[0125][0-9]{8}$/;
const EGYPT_COUNTRY_CODE = "20";

/** Arabic-Indic and Eastern Arabic-Indic digits, mapped onto ASCII by index. */
const ARABIC_INDIC_DIGITS = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";
const EXTENDED_ARABIC_INDIC_DIGITS = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";

function toAsciiDigits(value: string): string {
  let out = "";
  for (const char of value) {
    const arabic = ARABIC_INDIC_DIGITS.indexOf(char);
    if (arabic >= 0) {
      out += String(arabic);
      continue;
    }
    const extended = EXTENDED_ARABIC_INDIC_DIGITS.indexOf(char);
    if (extended >= 0) {
      out += String(extended);
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Reduce ONE candidate digit run to its national 10-digit form, or null.
 *
 * Accepts the three shapes the data actually holds and nothing else. A run longer than
 * an international number is refused rather than trimmed — see the note above on why a
 * confident-looking slice is the dangerous outcome, not the safe one.
 */
function toNationalDigits(run: string): string | null {
  let digits = run;

  if (digits.length === 12 && digits.startsWith(EGYPT_COUNTRY_CODE)) {
    digits = digits.slice(EGYPT_COUNTRY_CODE.length);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  return EGYPT_MOBILE_PREFIX.test(digits) ? digits : null;
}

/**
 * The stored mobile number as WhatsApp wants it: country code + national number, digits
 * only, no `+`. Returns null when nothing in the field can be read with confidence.
 *
 * Multiple numbers in one field resolve to the FIRST readable one, which matches how the
 * field is written — the primary number leads, the alternate follows a separator.
 */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const ascii = toAsciiDigits(raw);

  // Order matters, and it is the whole trick. Separators mean two opposite things in
  // this column: INSIDE one number they are cosmetic ("+20 101 234 5678", "010-1234-5678"),
  // BETWEEN two numbers they are the delimiter ("01012345678 / 01112345679"). Nothing in
  // the string says which it is, so try both readings, strictest first.
  //
  // 1. Every digit as ONE number. Cosmetic separators vanish and the field resolves. A
  //    field holding two numbers overflows the length check here and falls through.
  const joined = ascii.replace(/[^0-9]/gu, "");
  const asSingle = toNationalDigits(joined);
  if (asSingle) return `${EGYPT_COUNTRY_CODE}${asSingle}`;

  // 2. Only then, as several numbers — first readable one wins, since the primary leads.
  for (const run of ascii.split(/[^0-9]+/u)) {
    if (!run) continue;
    const national = toNationalDigits(run);
    if (national) return `${EGYPT_COUNTRY_CODE}${national}`;
  }

  return null;
}

/** Whether a stored mobile number yields a dialable chat. Drives whether the button renders. */
export function hasWhatsAppNumber(raw: string | null | undefined): boolean {
  return toWhatsAppNumber(raw) !== null;
}

/**
 * The same repair, rendered as the LOCAL form a person actually dials — `01012345678`,
 * not the `20…` that wa.me wants. Used by the organogram export, where the reader is a
 * human with a phone rather than a URL.
 *
 * Returns null on exactly the inputs `toWhatsAppNumber` refuses, so a number that cannot
 * be read confidently is never printed into a sheet as though it were trustworthy. The
 * export shows the raw stored text in that case — honest about what is on file, rather
 * than blank (which reads as "no number on record") or repaired-by-guessing.
 */
export function toDialableLocalMobile(raw: string | null | undefined): string | null {
  const international = toWhatsAppNumber(raw);
  if (!international) return null;
  return `0${international.slice(EGYPT_COUNTRY_CODE.length)}`;
}

/**
 * The chat URL. No `text` parameter on purpose: the owner asked to be taken to the
 * person's WhatsApp ready to write, and a canned opening line put words in his mouth.
 */
export function whatsAppChatUrl(number: string): string {
  return `https://wa.me/${number}`;
}
