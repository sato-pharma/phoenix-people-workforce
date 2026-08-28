/**
 * One key that an Arabic place name and its English spelling both collapse to.
 *
 * WHY THIS EXISTS. Phoenix's bricks are written in Arabic — all 697 active ones, name and
 * description alike, with not a single Latin character between them. The CRM (iReports360) writes
 * its regions in English transliteration. So the two halves of the same country never match on
 * text, and every visit in production sat in an "unmapped" region: 0 rows in
 * `ireports360_crm_region_brick_resolutions` against 239 distinct CRM regions.
 *
 * The owner's instruction, 2026-08-28: *"Kit Kat in Imbaba — translate to Arabic, you will find it.
 * Put effort in the Arabic."* He was right, twice over, and both are checked in the tests:
 *
 *   CRM 473 "Kit kat Imbaba"  ->  brick B198-3  "الكيت كات"   Imbaba - Imbaba Centers · Giza
 *   CRM 212 "Beba"            ->  brick B191-6  "بيبا"        Beni Suef · Giza
 *
 * HOW. Arabic does not write short vowels, and Egyptian transliteration into English is wildly
 * inconsistent about the ones it invents — Shebeen/Shibin, Menouf/Manouf, Naga Hamady/Nag Hammadi.
 * So neither side's vowels can be trusted, and the key is the CONSONANT SKELETON of the name:
 *
 *   1. strip the definite article — Arabic "ال" and English "El"/"Al"
 *   2. strip the words that classify rather than name — مركز/markaz, مدينة/city, قسم, حي, شارع/street
 *   3. transliterate Arabic letters to Latin, Egyptian-style (ج -> g, ق -> k, ث -> t)
 *   4. fold the digraphs both scripts share — kh, sh, gh, th — to one symbol each
 *   5. delete every vowel, collapse doubled letters, drop a trailing h (ة and the English "-a")
 *
 * WHAT IT IS NOT. A short name yields a short key — بيبا and Beba both collapse to "b" — so this
 * alone can never be an answer. It is a CANDIDATE GENERATOR. `scoreBrickCandidate` below pairs it
 * with the second, independent signal (where the rep's visits actually happened), and nothing is
 * written to the mapping table without a human confirming it. Never guess a place.
 */

import { normalizeArabic } from "@/lib/geo/egypt-locations";

/**
 * Egyptian-Arabic letter values, chosen for how Egyptians SPELL their towns in English rather than
 * for classical accuracy: ج is g (Giza, Gerga, Naga), ق is k (Kous, Kotor, Kena), the emphatics fold
 * onto their plain partners (ط->t, ص->s, ض->d, ظ->z), and ع and the hamzas carry no consonant at all
 * in English spelling so they vanish.
 */
const ARABIC_TO_LATIN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ا: "a", ب: "b", ت: "t", ث: "t", ج: "g", ح: "h", خ: "kh", د: "d", ذ: "d",
    ر: "r", ز: "z", س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z", ع: "",
    غ: "gh", ف: "f", ق: "k", ك: "k", ل: "l", م: "m", ن: "n", ه: "h", و: "w",
    ي: "y", ء: "", "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  }),
);

/**
 * Words that classify a place instead of naming it. Dropped from both scripts so that
 * "مركز ببا" and "Beba Center" reach the same key as "بيبا" and "Beba".
 *
 * "El"/"Al" are here as whole words; the attached Arabic article "ال" is stripped separately,
 * because it is a prefix rather than a word.
 */
const CLASSIFIER_WORDS = new Set([
  "el", "al", "le", "the", "of",
  "markaz", "center", "centers", "centre", "city", "district", "zone", "zones", "street", "st",
  "square", "road", "avenue", "kism", "hay", "sharea", "shara",
  "مركز", "مدينه", "قسم", "حي", "شارع", "ش", "طريق", "ميدان", "منطقه", "قريه",
]);

/** kh / sh / gh / th exist in both scripts and must not be read as two consonants. */
const DIGRAPHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/kh/g, "X"],
  [/sh/g, "C"],
  [/ch/g, "C"],
  [/gh/g, "Q"],
  [/th/g, "t"],
  [/ph/g, "f"],
];

const VOWELS = /[aeiouwy]/g;

/**
 * Latin letters that never survive a transliteration round trip on their own.
 *
 * `v` and `p` do not exist in Arabic at all — Victoria is فيكتوريا and Port Said is بورسعيد — so a
 * Latin spelling that uses them can only ever match through the letter Egyptians actually write.
 */
function foldLatinEquivalents(value: string): string {
  return value
    .replace(/q/g, "k") // Qena / Kena, Qous / Kous
    // English writes one letter for two sounds and Arabic writes two letters for them. Soft first,
    // then hard — and "ch" is left alone for the digraph pass, which has not run yet.
    .replace(/c(?=[eiy])/g, "s") // Cecil / سيسيل
    .replace(/c(?!h)/g, "k") // October / اكتوبر, Cairo / القاهره
    .replace(/j/g, "g") // Guiza / Jiza
    .replace(/v/g, "f") // Vectoria -> فيكتوريا
    .replace(/p/g, "b") // Port Said -> بورسعيد
    .replace(/'/g, "");
}

function stripArabicArticle(word: string): string {
  return word.length > 3 && word.startsWith("ال") ? word.slice(2) : word;
}

/**
 * Strip the definite article where it is glued to the front of a LATIN word.
 *
 * The CRM writes it both ways in the same column — "El Marg" and "Elmanwat", "Al Korba" and
 * "Alkorba" — and only the spaced form is caught by the classifier-word list. Measured on production:
 * 8 CRM regions carrying 585 visits were missed by this alone.
 *
 * Guarded on what is LEFT, not on what is stripped: "Alex" must stay Alex, so a stem shorter than
 * three letters is not an article at all.
 */
function stripLatinArticle(word: string): string {
  const stripped = word.replace(/^(?:el|al)(?=[a-z]{3,})/, "");
  return stripped || word;
}

/** "6th October" is "6 اكتوبر". The ordinal suffix is an English habit, not part of the name. */
function stripOrdinalSuffix(word: string): string {
  return word.replace(/^(\d+)(?:st|nd|rd|th)$/, "$1");
}

/**
 * The consonant skeleton of a place name, in either script.
 *
 * Returns "" when nothing survives — a name made only of classifier words, or of digits. Callers
 * MUST treat "" as "no key", never as a match: two empty keys are not the same place.
 */
export function placeNameKey(raw: string | null | undefined): string {
  const input = normalizeArabic(String(raw ?? "").toLowerCase());
  if (!input) return "";

  const words = input
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .split(" ")
    .map((word) => stripOrdinalSuffix(stripLatinArticle(stripArabicArticle(word))))
    .filter((word) => word && !CLASSIFIER_WORDS.has(word));
  if (words.length === 0) return "";

  // Arabic -> Latin, letter by letter. A letter with no entry (a stray Latin char inside an Arabic
  // name, a digit) passes through unchanged.
  const latin = words
    .map((word) =>
      [...word].map((letter) => ARABIC_TO_LATIN.get(letter) ?? letter).join(""),
    )
    .join(" ");

  let key = foldLatinEquivalents(latin);
  for (const [pattern, symbol] of DIGRAPHS) key = key.replace(pattern, symbol);
  key = key
    .replace(VOWELS, "")
    .replace(/\s+/g, "")
    .replace(/(.)\1+/g, "$1") // gemination: Mahalla / المحلة, Hammadi / حمادي
    .replace(/h$/, ""); // ta marbuta, and the English "-a" it is usually spelled with

  return key;
}

/**
 * Do two place names, in any mix of scripts, reduce to the same consonant skeleton?
 *
 * Compares the whole name on each side — never a sub-run, that is
 * {@link placeNameKeyCandidates}'s job — but it does compare every SPELLING of each side, so
 * الزقازيق and Zagazig match on the ج reading of ق while قنا and Qena match on the ك one. A
 * single-key comparison would answer "no" to the first of those, and 648 visits ride on it.
 */
export function placeNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return matchedNameKey(a, b) !== null;
}

/** The key two names actually met on, or null if they never met. Empty keys never match. */
function matchedNameKey(a: string | null | undefined, b: string | null | undefined): string | null {
  const keysB = new Set(nameVariantKeys(b));
  for (const key of nameVariantKeys(a)) {
    if (keysB.has(key)) return key;
  }
  return null;
}

/** Every spelling of one whole name — the key itself, plus the ق variant when Arabic supplies one. */
function nameVariantKeys(raw: string | null | undefined): string[] {
  const out = new KeySet();
  out.addName(String(raw ?? ""));
  return out.keys;
}

/**
 * Every key a name could reasonably be filed under, longest first.
 *
 * A CRM region routinely names the place AND its parent in one string — "Kit kat Imbaba",
 * "Dar El Salam (Sohag)", "Al Ibrahemia Sharkia", "Mansoura east" — while the brick names only the
 * place ("الكيت كات"). Keying the whole string would miss every one of those, so each contiguous run
 * of words gets a key too, and the caller takes the LONGEST run that hits a brick. Longest-first is
 * what stops "Kit kat Imbaba" resolving to Imbaba when the Kit Kat brick itself exists.
 *
 * Runs are contiguous, never arbitrary subsets: "Meet Ghamr" must not be allowed to match a brick
 * called "Meet Salsil" through the shared word alone — that is a different town.
 */
export function placeNameKeyCandidates(raw: string | null | undefined): string[] {
  const words = splitWords(raw);
  if (words.length === 0) return [];

  const out = new KeySet();
  for (let size = words.length; size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      out.addName(words.slice(start, start + size).join(" "));
    }
  }
  return out.keys;
}

/**
 * The keys a name should be FILED under, so that a shorter query can still reach it.
 *
 * The mirror image of the function above, and deliberately narrower. A brick often carries a
 * qualifier the CRM leaves off — "المحلة الكبرى" for Mahalla, "مدينة أسيوط" for Assiut — so the brick
 * has to be findable by its opening words as well as by its whole name. What it must NOT be findable
 * by is its qualifier alone: indexing "المحلة الكبرى" under "kbr" would let any name containing
 * "kubra" land on Mahalla. Leading runs only, never trailing ones.
 */
export function placeNameIndexKeys(raw: string | null | undefined): string[] {
  const words = splitWords(raw);
  if (words.length === 0) return [];

  const out = new KeySet();
  for (let size = words.length; size >= 1; size -= 1) out.addName(words.slice(0, size).join(" "));
  return out.keys;
}

function splitWords(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .replace(/[()[\]]/g, " ")
    .split(/[\s,،/\\-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Accumulates keys in insertion order, without duplicates, expanding the one Arabic letter whose
 * English spelling is genuinely bimodal.
 *
 * ق is `k` in most of the country (Qena/Kena, قوص/Kous, قطور/Kotor) and `g` in the Delta
 * (الزقازيق/Zagazig — 648 visits, missed by the k-spelling alone). Which one a town uses is local
 * habit, not a rule, so an Arabic name containing ق is filed under BOTH spellings rather than
 * guessed at.
 */
class KeySet {
  private readonly seen = new Set<string>();
  readonly keys: string[] = [];

  addName(name: string): void {
    this.push(placeNameKey(name));
    if (name.includes("ق")) this.push(placeNameKey(name.replace(/ق/g, "ج")));
  }

  private push(key: string): void {
    if (!key || this.seen.has(key)) return;
    this.seen.add(key);
    this.keys.push(key);
  }
}

/**
 * How confident a name match is, on its own, before any other evidence.
 *
 * Length is the whole story: "ktkt" (Kit Kat) is a near-certain match and "b" (Beba) is a coin toss
 * that happens to be right. This is deliberately pessimistic — it feeds a suggestion a human
 * confirms, and an over-confident wrong brick is far more expensive than an unmapped one.
 */
export type NameMatchStrength = "strong" | "weak" | "none";

export function nameMatchStrength(a: string | null | undefined, b: string | null | undefined): NameMatchStrength {
  const key = matchedNameKey(a, b);
  if (!key) return "none";
  return key.length >= 3 ? "strong" : "weak";
}
