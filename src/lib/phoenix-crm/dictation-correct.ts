/**
 * Phoenix CRM — correcting product names in what the speech engine returns.
 *
 * WHAT THIS IS NOT. It is not training. The Web Speech API is Google's service on Chrome and
 * Apple's on Safari; there is no interface to teach either one a word, no model to fine-tune, and no
 * amount of Phoenix data changes what they return. Anything claiming to "train" them is claiming
 * something the API does not offer. This corrects the output AFTER it arrives, which is the only
 * place a Phoenix-specific vocabulary can be applied at all.
 *
 * WHAT IT FIXES, AND WHY THAT IS THE PART WORTH FIXING. The engine handles ordinary Egyptian Arabic
 * well. It fails on exactly one class of word — the product names — because it has never heard them
 * and substitutes the nearest real word it knows. That is also the only part of a visit comment
 * anyone reads it for, so a sentence that is 95% right and has the drug name wrong is worth close to
 * nothing. `PRODUCT_VOCABULARY` holds those names with the spellings the field itself uses, counted
 * from 136,983 real comments in the old CRM.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE — this is the boundary that keeps it honest:
 *
 *   · Ordinary words. Only tokens close to a KNOWN PRODUCT are touched. The corrector has no opinion
 *     about grammar, phrasing or spelling anywhere else, because "correcting" a rep's own Arabic is
 *     putting words in his mouth, and a wrong guess there changes what he reported about a doctor.
 *   · Short forms. A rep who says الايفي said الايفي; expanding it to the full brand is rewriting
 *     him, not fixing an error. They are matched only so they are recognised and SKIPPED.
 *   · Anything it is not confident about. A token only changes when it is close enough to exactly one
 *     product. Two plausible products, or a weak match, and it is left exactly as spoken.
 *
 * THE DIRECTION OF THE ERROR IS THE WHOLE DESIGN. Leaving a wrong word costs a rep one correction he
 * can see and fix. Silently replacing a right word with a product name he never said puts a claim in
 * a clinical record that nobody knows is false. The thresholds below are deliberately tight for that
 * reason, and a near-miss fails toward leaving the text alone.
 */

import {
  COMPETITOR_TERMS,
  PRODUCT_VOCABULARY,
  PROTECTED_SHORT_FORMS,
  type VocabularyEntry,
} from "@/lib/phoenix-crm/dictation-vocabulary";

/**
 * Arabic writes the article and conjunctions onto the front of the word, so the corpus carries
 * التيبوفورتين, والتيبوفورتين and بالتيبوفورتين as one name wearing three different hats. Matching
 * without stripping them compares "والتيبوفورتين" against "تيبوفورتين" and scores it as a bad match;
 * stripping without putting them back returns a sentence missing its grammar. Longest first, so
 * "وبال" is taken whole rather than leaving "بال" behind.
 *
 * "عال" is the Egyptian contraction of "على ال" and is in the list because the corpus is full of it
 * — عالايفيرونك, عالجواميسين and عالرويافلوكساسين together are over 500 real comments. It was
 * missing from the first version, which left every one of those spellings uncorrected.
 */
const ARABIC_CLITICS = [
  "وبال",
  "فبال",
  "وكال",
  "وعال",
  "ولل",
  "فلل",
  "بال",
  "كال",
  "فال",
  "وال",
  "عال",
  "لل",
  "ال",
  "و",
  "ف",
  "ب",
  "ك",
  "ل",
];

/** Harakat and tatweel. The engine does not emit them; a rep pasting text might. */
const ARABIC_DIACRITICS = /[ً-ْـٰ]/g;

/**
 * Fold the spellings Arabic treats as interchangeable. أ إ آ ا are one letter for this purpose, ى and
 * ي are routinely swapped, ة and ه are swapped constantly in Egyptian typing, and the Persian letters
 * چ ڤ گ appear where a rep is reaching for a sound Arabic has no letter for — which is precisely what
 * happens with a European brand name.
 */
export function normalizeArabic(word: string): string {
  return word
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/چ/g, "ج")
    .replace(/ڤ/g, "ف")
    .replace(/گ/g, "ك");
}

function isArabic(word: string): boolean {
  return /[؀-ۿ]/.test(word);
}

/**
 * Every way an Arabic token could be read, longest clitic first and the WHOLE word last.
 *
 * Returning only the longest match was a real defect: ك and ل are both clitics and both are also
 * the first letter of a product name, so "كونفيبان" had its ك stripped to "ونفيبان" and "لاكتو" its
 * ل to "اكتو". Neither stem matched anything, so Conviban and Lacto — spoken bare, which is how
 * 1,639 and 2,894 real comments write them — were never corrected at all.
 *
 * The whole word must come LAST rather than first: "الكونفيبان" is only two edits from "كونفيبان",
 * so matching it whole would replace the article along with the name and quietly delete the rep's
 * own grammar.
 */
function cliticCandidates(word: string): { prefix: string; stem: string }[] {
  const candidates = ARABIC_CLITICS.filter(
    (clitic) => word.length > clitic.length + 2 && word.startsWith(clitic),
  ).map((clitic) => ({ prefix: clitic, stem: word.slice(clitic.length) }));
  candidates.push({ prefix: "", stem: word });
  return candidates;
}

/**
 * How close the WHOLE word must be when it also reads as a clitic plus a stem.
 *
 * The whole-word reading has to exist — كونفيبان and لاكتو begin with ك and ل and are the names
 * themselves — but it is the reading that can silently eat the rep's grammar, because a name with
 * the article on the front is only two edits from the bare name. The measurement caught it doing
 * exactly that: "الاكتووا" came back as "لاكتو", with the rep's ال deleted.
 *
 * So a word that opens with a clitic may only match whole when it is the name almost exactly — an
 * exact hit on a listed spelling, or one letter off it. Anything looser has to go through the
 * clitic reading, which puts the prefix back.
 */
const WHOLE_WORD_DISTANCE_BEHIND_CLITIC = 1;

function startsWithClitic(word: string): boolean {
  return ARABIC_CLITICS.some((clitic) => word.length > clitic.length + 2 && word.startsWith(clitic));
}

/** Levenshtein, two rows rather than a full matrix — these are single words, but it runs per token. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * How wrong a word may be and still count as the same word. Proportional, because one wrong letter in
 * a four-letter word is a different word while two in "رويافلوكساسين" is the same one said quickly.
 * Capped at 3 so a long product name cannot swallow an unrelated long word.
 */
function allowedDistance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 6) return 1;
  if (length <= 10) return 2;
  return 3;
}

type Candidate = { entry: VocabularyEntry; distance: number };

function bestMatch(stem: string, arabic: boolean): Candidate | null {
  const needle = arabic ? normalizeArabic(stem) : stem.toLowerCase();
  const budget = allowedDistance(needle.length);

  let best: Candidate | null = null;
  let tiedWithDifferentProduct = false;

  for (const entry of PRODUCT_VOCABULARY) {
    const variants = arabic ? entry.arabicVariants : entry.latinVariants;
    let entryBest = Number.POSITIVE_INFINITY;

    for (const variant of variants) {
      const candidate = arabic ? normalizeArabic(variant) : variant.toLowerCase();
      // A length gap wider than the budget cannot come back under it, and skipping it keeps the
      // per-token cost down on a vocabulary that will grow.
      if (Math.abs(candidate.length - needle.length) > budget) continue;
      const distance = editDistance(needle, candidate);
      if (distance < entryBest) entryBest = distance;
      if (entryBest === 0) break;
    }

    if (entryBest > budget) continue;
    if (!best || entryBest < best.distance) {
      best = { entry, distance: entryBest };
      tiedWithDifferentProduct = false;
    } else if (entryBest === best.distance && entry !== best.entry) {
      tiedWithDifferentProduct = true;
    }
  }

  // Two products equally close means the corrector does not know which was said. Leaving the rep's
  // own word is the only safe answer — picking one would invent a fact about a doctor's prescribing.
  if (!best || tiedWithDifferentProduct) return null;
  return best;
}

/** A word the field uses on its own. Recognised so it is skipped, never expanded. */
function isProtectedShortForm(stem: string): boolean {
  const needle = normalizeArabic(stem);
  return PROTECTED_SHORT_FORMS.some((form) => normalizeArabic(form) === needle);
}

/**
 * Another company's product or molecule. Matched EXACTLY — no edit budget — because the list is a
 * refusal, and a fuzzy refusal would start swallowing Phoenix's own misspellings alongside it.
 * `الريفلوكساسين` is a Royafloxacin typo and `الليفلوكساسين` is levofloxacin; one letter apart, and
 * only an exact comparison keeps them on opposite sides of the line.
 */
function isCompetitorTerm(stem: string, arabic: boolean): boolean {
  const needle = arabic ? normalizeArabic(stem) : stem.toLowerCase();
  return COMPETITOR_TERMS.some(
    (term) => (arabic ? normalizeArabic(term) : term.toLowerCase()) === needle,
  );
}

/**
 * A token carrying a digit is a STRENGTH, and the strength is what distinguishes the two things a
 * rep might have meant. The corrector matches letters, so `respadex3` was coming back as `Rispadex`
 * and `التيبوفورتين٤٠` as `التيبوفورتين` — the name tidied and the dose quietly deleted, which is
 * worse than the misspelling it fixed. Arabic-Indic digits count: the corpus writes both.
 */
const CARRIES_A_DIGIT = /[0-9٠-٩۰-۹]/;

export type Correction = { from: string; to: string };

export type CorrectionResult = {
  /** The transcript with product names in their canonical spelling. */
  text: string;
  /** What changed, in order. Empty when nothing did. */
  corrections: Correction[];
};

/**
 * Correct product names in one settled transcript.
 *
 * Splits on the separators rather than on words, so punctuation, spacing and newlines come back
 * exactly as they arrived — the rep's text with some product names respelled, never reflowed.
 */
export function correctDictatedProducts(transcript: string): CorrectionResult {
  if (!transcript.trim()) return { text: transcript, corrections: [] };

  const pieces = transcript.split(/([^\p{L}\p{N}]+)/u);
  const corrections: Correction[] = [];

  const corrected = pieces.map((piece, index) => {
    // Odd indices are the separators the split captured; they are returned untouched.
    if (index % 2 === 1 || !piece) return piece;

    const arabic = isArabic(piece);
    // A Latin token of three letters or fewer is a preposition, not a brand.
    if (!arabic && piece.length <= 3) return piece;
    // A dose is not a spelling mistake. Nothing with a number in it is touched.
    if (CARRIES_A_DIGIT.test(piece)) return piece;

    const readings = arabic ? cliticCandidates(piece) : [{ prefix: "", stem: piece }];
    // A word the field uses on its own under ANY reading is left alone, before any matching runs —
    // and so is another company's product, which is the one rewrite with no way back.
    if (readings.some((reading) => isCompetitorTerm(reading.stem, arabic))) return piece;
    if (arabic && readings.some((reading) => isProtectedShortForm(reading.stem))) return piece;

    const wholeWordCapped = arabic && startsWithClitic(piece);

    // The closest reading wins. Ties go to the earlier one, which is the longer clitic — the more
    // specific reading of the word rather than the accident of a name starting with ك or ل.
    let prefix = "";
    let match: Candidate | null = null;
    for (const reading of readings) {
      if (!reading.stem) continue;
      const candidate = bestMatch(reading.stem, arabic);
      if (!candidate) continue;
      // The whole-word reading of a word that opens with a clitic has to be near-exact, or it
      // replaces the prefix along with the name.
      if (
        !reading.prefix &&
        wholeWordCapped &&
        candidate.distance > WHOLE_WORD_DISTANCE_BEHIND_CLITIC
      ) {
        continue;
      }
      if (!match || candidate.distance < match.distance) {
        match = candidate;
        prefix = reading.prefix;
      }
      if (match.distance === 0) break;
    }
    if (!match) return piece;

    // A distance of 0 is NOT "nothing to do" — the variant lists hold the field's own misspellings,
    // so an exact hit on one is the clearest case for correcting it. Whether the word was already
    // right is decided by comparing the result, below, not by the distance.
    const canonical = arabic ? match.entry.arabic : match.entry.latin;
    const replacement = `${prefix}${canonical}`;
    if (replacement === piece) return piece;

    corrections.push({ from: piece, to: replacement });
    return replacement;
  });

  return { text: corrected.join(""), corrections };
}
