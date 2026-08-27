/**
 * The offer's reference number.
 *
 * ── The shape ──
 *   SP-HR-DSM-2026-019
 *   │     │   │    └── sequence, counted within that title and that year
 *   │     │   └─────── the year the offer was issued
 *   │     └─────────── the job title, abbreviated
 *   └───────────────── Sato Pharma, Human Resources
 *
 * ── Why it is counted per title, not per year ──
 * The abbreviation sits in the middle of the number, so the number reads as "the nineteenth
 * District Sales Manager offer of 2026". Counting every title into one run would make that middle
 * segment decorative — present, but meaning nothing about the number beside it.
 *
 * ── Why any of this is automated at all ──
 * It was a free-text box. Typing a reference by hand on every letter invites the two failures that
 * a reference exists to prevent: the same number on two offers, and a number that skips. Both are
 * invisible until somebody has to find one specific letter months later.
 *
 * Everything here is pure and works on data the caller already holds, so the composer can show the
 * number it is about to use before anything is saved, and the server can allocate the real one
 * from the same rules at the moment of writing.
 */

/** Sato Pharma, Human Resources. The one part of the reference that never varies. */
export const OFFER_REFERENCE_PREFIX = "SP-HR";

/** Where a title gives us nothing to abbreviate. Never blank — a reference must not have a hole. */
export const OFFER_REFERENCE_FALLBACK_CODE = "GEN";

/** The narrowest a sequence is ever printed. `019`, not `19`, so references sort as text. */
const SEQUENCE_WIDTH = 3;

/** Longest abbreviation. Past four letters it stops being an abbreviation. */
const MAX_CODE_LENGTH = 4;

/**
 * Words that carry no identity in a job title.
 *
 * "Head of Talent Acquisition" is HTA, not HOTA — nobody reads the "of". Kept deliberately short:
 * every word removed here is a letter somebody might have expected to see.
 */
const SKIPPED_WORDS = new Set(["a", "an", "and", "at", "for", "in", "of", "or", "the", "to"]);

/**
 * A job title as the letters that go in the middle of the reference.
 *
 *   "District Sales Manager"     → DSM
 *   "Medical Representative"     → MR
 *   "Head of Talent Acquisition" → HTA
 *   "Accountant"                 → ACC   (one word has no initials, so the first three letters)
 *   ""                           → GEN
 *
 * Digits survive — "Medical Rep 2" is a title somebody may well create, and dropping the 2 would
 * merge its references with plain "Medical Rep".
 */
export function offerTitleCode(title: string): string {
  const words = title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((word) => !SKIPPED_WORDS.has(word.toLowerCase()));

  if (words.length === 0) return OFFER_REFERENCE_FALLBACK_CODE;
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .map((word) => word[0])
    .join("")
    .slice(0, MAX_CODE_LENGTH)
    .toUpperCase();
}

export type OfferReferenceParts = { code: string; sequence: number; year: number };

/** Assemble a reference from its parts. */
export function buildOfferReference({ code, sequence, year }: OfferReferenceParts): string {
  return [
    OFFER_REFERENCE_PREFIX,
    code,
    String(year),
    String(Math.max(1, Math.trunc(sequence))).padStart(SEQUENCE_WIDTH, "0"),
  ].join("-");
}

/**
 * Read a reference back into its parts, or null when the text is not one of ours.
 *
 * Null matters more than it looks: a reference typed by hand in some other shape must not be
 * counted when working out the next sequence, or one stray entry moves the whole run.
 */
export function parseOfferReference(reference: string): OfferReferenceParts | null {
  const match = new RegExp(`^${OFFER_REFERENCE_PREFIX}-([A-Z0-9]+)-(\\d{4})-(\\d+)$`).exec(
    reference.trim().toUpperCase(),
  );
  if (!match) return null;
  const [, code, year, sequence] = match;
  return { code, sequence: Number(sequence), year: Number(year) };
}

/**
 * The next free reference for this title in this year.
 *
 * Takes the HIGHEST sequence already used and adds one, rather than filling the first gap. A gap
 * in a reference run is evidence — an offer was withdrawn, or a draft was deleted — and quietly
 * reusing the number destroys that evidence and makes two different letters share a reference in
 * anyone's records.
 *
 * `existing` may contain anything at all: other titles, other years, hand-typed text, empty
 * strings. Everything that is not this title in this year is ignored.
 */
export function nextOfferReference(title: string, year: number, existing: readonly string[]): string {
  const code = offerTitleCode(title);
  let highest = 0;

  for (const candidate of existing) {
    const parts = parseOfferReference(candidate ?? "");
    if (!parts || parts.code !== code || parts.year !== year) continue;
    if (parts.sequence > highest) highest = parts.sequence;
  }

  return buildOfferReference({ code, sequence: highest + 1, year });
}
