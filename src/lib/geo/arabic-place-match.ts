// Geography — deciding whether an ENGLISH address names an ARABIC place.
//
// WHY THIS EXISTS. The company's 697 sales bricks are the only fine-grained map of Egypt this
// system owns: each names a neighbourhood and points at the area covering it. Measured 2026-08-28
// in production, ALL 697 are written in Arabic, with zero Latin characters. Every CV address is
// written in English. So the two halves of the answer have never been able to see each other, and a
// candidate living in Helmeyet El-Zeitoun matched nothing finer than "Cairo".
//
// WHAT WAS TRIED FIRST, AND WHY IT FAILED. The obvious approach is to drop the vowels from both
// sides and compare consonants: Zeitoun, Zaytoun and Zeytoon all reduce to `ztn`, and so does
// زيتون. It matched 20 of 22 hand-checked pairs, and it was still wrong, because Egyptian place
// names are SHORT and three consonants of any language collide with them constantly. Measured over
// the real 447 CVs it produced, with total confidence:
//
//     "Post Office BOX"  ->  باكوس, Bacos      -> an Alexandria seat
//     "Ada GEORGE Road"  ->  جرجا, Girga       -> a Sohag seat
//     "KARACHI 75850"    ->  القرشية           -> a Gharbia seat
//     "MATARYA"          ->  المطار, the airport -> an Alexandria seat
//     "NASSER"           ->  الناصرية          -> a Gharbia seat
//
// Box is not Bacos. George is not Girga. Matarya is not the airport. The consonant skeleton was
// throwing away the very thing that separates them, and no amount of filtering downstream of it
// could put that back.
//
// HOW IT WORKS NOW. Arabic omits SHORT vowels but WRITES the long ones — ا و ي are on the page.
// So an Arabic name is compiled into a pattern that says which vowels must be there and which may
// be, and English words are tested against it:
//
//     باكوس  ->  b [must contain a] k [must contain o or u] s      "bacos" ✓   "box" ✗
//     المطار ->  m [short?] t [must contain a] r [end]             "matar"  ✓   "matarya" ✗
//     المطريه->  m [short?] t [short?] r [must contain i/e/y] +a   "matarya" ✓  "matar"   ✗
//
// Short vowels, which Arabic does not write, are permitted anywhere between consonants — that is
// what makes Haram, Horom and Hurum all match هرم. What is NOT permitted is an extra consonant, a
// missing long vowel, or a long vowel of the wrong colour. That single rule is the difference
// between the five wrong answers above and none of them.
//
// Pure: no React, no database, no network, no environment. Pinned by a test.

/** Harakat, tatweel and the superscript alef — decoration that carries no consonant. */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

/**
 * How English can spell each Arabic consonant.
 *
 * Alternatives, not one answer, wherever Egyptian usage genuinely disagrees with itself: ج is Gamal
 * to almost everyone here and Jamal to a minority, ق is written q and k with equal frequency, and ث
 * arrives as th, s or t depending on who typed it.
 */
const CONSONANTS: Record<string, string> = {
  "ب": "b",
  "ت": "t",
  "ث": "(?:th|s|t)",
  "ج": "(?:g|j|dj)",
  "ح": "h",
  "خ": "(?:kh|k)",
  "د": "d",
  "ذ": "(?:dh|th|z|d)",
  "ر": "r",
  "ز": "z",
  "س": "(?:ss|s|c)",
  "ش": "(?:sh|ch)",
  "ص": "(?:ss|s|c)",
  "ض": "(?:d|dh)",
  "ط": "t",
  "ظ": "(?:z|dh)",
  "غ": "(?:gh|g)",
  "ف": "(?:f|ph)",
  "ق": "(?:q|k|c|g)",
  "ك": "(?:ck|k|c|q)",
  "ل": "l",
  "م": "m",
  "ن": "n",
  "ه": "h",
};

/** Which English vowels each Arabic long vowel is actually written with. */
const LONG_VOWELS: Record<string, string> = {
  "ا": "a",
  "و": "[ouw]",
  "ي": "[iey]",
  "ى": "[iey]",
};

/**
 * Ordinary English words that appear in addresses AS ENGLISH, never as a transliterated Arabic name.
 *
 * The matcher's question is "is this English word an Egyptian place name written in Latin letters",
 * and for these the answer is no before any phonetics are consulted. "Post Office BOX" is the case
 * that named this list; "Green fields colony, Faridabad" is the case that filled it out, because
 * القرين, El Qurain, is legitimately spelled with a g — الزقازيق is Zagazig — so "green" cannot be
 * excluded by tightening the consonant table without also breaking Zagazig.
 *
 * Only English vocabulary goes in here. Nothing Arabic, however generic: دار, سلام, نصر and هرم are
 * all real brick names and all common words, and excluding them would delete real places.
 */
const ENGLISH_ADDRESS_WORDS = new Set([
  "apartment", "apt", "avenue", "block", "box", "building", "city", "colony", "district", "east",
  "field", "fields", "first", "flat", "floor", "front", "garden", "gardens", "gate", "green",
  "ground", "home", "house", "mail", "near", "new", "next", "north", "number", "office", "old",
  "post", "region", "road", "sector", "second", "south", "square", "street", "third", "tower",
  "town", "village", "west", "zone",
]);

/**
 * Words that say WHERE within a place, not WHICH place.
 *
 * بحرى — "northern" — is a brick name on its own, and it matched "El Galaa El Bahary Street" in
 * Menoufia for an Alexandria seat. A direction is a qualifier: it can distinguish two places of the
 * same name, so it is kept inside a multi-word name, but it identifies nowhere by itself.
 */
const DIRECTION_WORDS = new Set(["بحرى", "بحري", "قبلى", "قبلي", "شرقى", "شرقي", "غربى", "غربي"]);

/** Letters that reach English as a vowel, an apostrophe, or nothing at all. */
const SOFT_LETTERS = new Set(["ء", "أ", "إ", "آ", "ؤ", "ئ", "ع"]);

/**
 * What may sit between two consonants: up to two vowel letters.
 *
 * Two, not one, because English spells a single Egyptian short vowel with two letters all the time
 * — the "ou" of Shoubra, the "ee" of Basateen, the "ea" of Talbeya. Requiring one would lose them.
 *
 * This was briefly an explicit list of legal digraphs, written to stop "GEORGE" satisfying جرجا
 * through its "eo". That list was measured against all 626 bricks and all 251 real CV addresses and
 * refused NOTHING the plain form refuses — because what actually stops George is the ا below
 * demanding an a, which "george" has nowhere. Keeping a guard that guards nothing only invites the
 * next reader to trust it.
 */
const GAP = "[aeiouwy]{0,2}";

/**
 * Words that say what KIND of place this is, never which one.
 *
 * An Egyptian writing their address in English does not write these — nobody puts "Share'" in a CV.
 * Requiring them would kill the brick; treating them as identity would be a lie.
 */
const STRUCTURAL_WORDS = new Set(["ش", "شارع", "شارغ", "ميدان", "حى", "حي"]);

/**
 * Bricks recorded at STREET or SQUARE level are refused outright.
 *
 * A precision decision, not a recall one. "ش زغلول" belongs to one area, but Saad Zaghloul has a
 * street in most Egyptian cities, so matching it would place a candidate in Haram for living on a
 * street of the same name in Tanta. The neighbourhood bricks carry the signal; the landmark ones
 * carry the false answers.
 */
const STREET_LEVEL_HEADS = new Set(["ش", "شارع", "شارغ", "ميدان"]);

/**
 * What a word must carry to be compiled at all: two consonants, or one with a long vowel.
 *
 * The one-consonant case exists for أبو, Abu, which opens dozens of Egyptian place names. It used
 * to fail this floor and be DROPPED, which quietly turned the two-word "أبو يوسف" into the one-word
 * "يوسف" — and a CV listing "Youssef Ibn-Ayoub Street" in Cairo then matched an Alexandria seat on
 * a man's first name. A word that cannot be compiled now fails its whole place rather than
 * weakening it (see compileArabicPlace).
 */
const MIN_CONSONANTS = 2;
/**
 * What a place named by a SINGLE word must carry to stand alone: three consonants, or two with a
 * long vowel pinning them. المعادى is only م and د, but the ا and the ى fix every vowel in it —
 * "maadi" fits and "mahdi", "medi" and "mud" do not.
 */
const MIN_SOLO_CONSONANTS = 3;

export type PlaceWord = {
  /** The compiled pattern an English word must satisfy in full. */
  pattern: RegExp;
  /** Consonants only, as a cheap pre-filter before the pattern is run. */
  skeleton: string;
  /** How many vowels Arabic actually wrote down — the ones English is not free to choose. */
  longVowels: number;
};

export type ArabicPlace = {
  /** The name as recorded, kept so a person can read what was matched. */
  arabic: string;
  /** Every word of the name. An address must satisfy all of them. */
  words: PlaceWord[];
};

/**
 * Compile one Arabic word into the English spellings it accepts.
 *
 * Returns null when the word carries too little to identify anywhere — a word of long vowels and ع,
 * like عين, which English writes "Ain" and which this scheme cannot pin down. Such a word is struck
 * out of the name rather than failing it, because English cannot key it either and requiring it
 * would make the brick unmatchable by anybody.
 */
export function compileArabicWord(word: string): PlaceWord | null {
  const cleaned = word.replace(ARABIC_MARKS, "").trim();
  if (!cleaned) return null;
  // The definite article is not part of the name: El Haram, Al Haram and Haram are one place.
  const bare = cleaned.replace(/^(?:ال|أل)/, "") || cleaned;
  const letters = [...bare];

  let source = "^";
  let skeleton = "";
  let consonants = 0;
  /** What must appear before the NEXT consonant. Reset each time one is written. */
  let pending = GAP;
  /**
   * Whether `pending` holds a REQUIREMENT or merely the optional gap every consonant is allowed.
   *
   * It decides what happens at the END of the word, and it is the whole of the guard below: a
   * requirement is emitted, an optional gap is dropped. Emitting the gap instead let الظاهر, El
   * Zaher, end on a free vowel and answer to "Zahra".
   */
  let pendingIsRequirement = false;
  /**
   * What may follow the last consonant. EMPTY by default, and that emptiness is the guard: Arabic
   * writes the vowel a name ends on, so a name ending in a consonant matches only an English word
   * ending in a consonant. ظاهر ends on ر, so "zaher" fits and "zahra" does not.
   */
  let trailing = "";
  let longVowels = 0;
  let sawConsonant = false;

  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index];
    const isLast = index === letters.length - 1;

    // ة is the feminine ending. It is never silent in English: Kerdasa, Talbeya, Omraneya all end
    // on it, and so does "Manshet" when the name runs on into the next word. Requiring it is what
    // keeps المعصره, El Masara, from answering to "Masr".
    if (letter === "ة") {
      trailing = "(?:[ae]h?|ah|eh|[ae]?t)";
      continue;
    }
    // A final ه behaves the same way — العمرانيه is Omraneya, never "Omran".
    if (letter === "ه" && isLast && sawConsonant) {
      trailing = "(?:[ae]h?|ah|eh|h[ae]?)";
      continue;
    }

    const consonant = CONSONANTS[letter];
    if (consonant) {
      source += pending + consonant;
      skeleton += letter;
      consonants += 1;
      pending = GAP;
      pendingIsRequirement = false;
      sawConsonant = true;
      continue;
    }

    const longVowel = LONG_VOWELS[letter];
    if (longVowel) {
      // و and ي open a word as consonants — يوسف is Youssef, وادى is Wadi — and are vowels anywhere
      // after that.
      if (!sawConsonant && (letter === "و" || letter === "ي")) {
        source += pending + (letter === "و" ? "w" : "y");
        skeleton += letter;
        consonants += 1;
        pending = GAP;
        pendingIsRequirement = false;
        sawConsonant = true;
        continue;
      }
      pending += `${longVowel}${GAP}`;
      pendingIsRequirement = true;
      longVowels += 1;
      continue;
    }

    if (SOFT_LETTERS.has(letter)) {
      pending += GAP;
      continue;
    }
    // A digit, a slash, a stray Latin letter — the name stops here rather than fusing on.
    break;
  }

  if (consonants < MIN_CONSONANTS && !(consonants >= 1 && longVowels > 0)) return null;
  // A long vowel after the last consonant — the ي of المطريه, the ى of المعادى — is part of the
  // name and has to be written out. Dropping it deleted the one vowel separating Matarya from the
  // AIRPORT, and every name ending in ية lost its ي the same way. A bare optional gap is dropped
  // instead, for the reason given where `pendingIsRequirement` is declared.
  source += `${pendingIsRequirement ? pending : ""}${trailing}$`;
  return { longVowels, pattern: new RegExp(source), skeleton };
}

/**
 * Compile a whole Arabic place name, or refuse it.
 *
 * Refused when it is a street or a square, when nothing in it can be compiled, or when a name of a
 * single word is too short to be an identity on its own.
 */
export function compileArabicPlace(name: string): ArabicPlace | null {
  const raw = name.replace(ARABIC_MARKS, "").trim();
  const words = raw.split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return null;
  if (STREET_LEVEL_HEADS.has(words[0])) return null;

  const compiled: PlaceWord[] = [];
  let identifying = 0;
  for (const word of words) {
    if (STRUCTURAL_WORDS.has(word)) continue;
    const one = compileArabicWord(word);
    // A word that will not compile FAILS THE PLACE. It used to be skipped, which silently turned a
    // two-word name into whichever of its words happened to compile — the difference between
    // requiring "Abu Youssef" and answering to anybody called Youssef.
    if (!one) return null;
    compiled.push(one);
    if (!DIRECTION_WORDS.has(word)) identifying += 1;
  }
  // A name made only of directions identifies nowhere: "بحرى" is "northern".
  if (identifying === 0) return null;
  if (compiled.length === 0) return null;
  if (
    compiled.length === 1 &&
    compiled[0].skeleton.length < MIN_SOLO_CONSONANTS &&
    !(compiled[0].skeleton.length >= MIN_CONSONANTS && compiled[0].longVowels > 0)
  ) {
    return null;
  }
  return { arabic: raw, words: compiled };
}

/**
 * The English words of an address, ready to be tested.
 *
 * The Arabic article is stripped on this side too, and BOTH forms are kept: "Almaadi" written as
 * one word is El Maadi, and the name is the second half. Keeping both means neither spelling has to
 * be guessed at.
 */
export function addressWords(address: string): string[] {
  const words = new Set<string>();
  for (const raw of String(address ?? "").split(/[^\p{L}]+/u)) {
    const word = raw
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    if (word.length < 3) continue;
    if (ENGLISH_ADDRESS_WORDS.has(word)) continue;
    words.add(word);
    const withoutArticle = word.replace(/^(?:el|al|il)/, "");
    if (withoutArticle.length >= 3 && withoutArticle !== word && !ENGLISH_ADDRESS_WORDS.has(withoutArticle)) {
      words.add(withoutArticle);
    }
  }
  return [...words];
}

/** True when every word of the place is named somewhere in the address. */
export function addressNamesPlace(place: ArabicPlace, words: readonly string[]): boolean {
  return place.words.every((word) => words.some((candidate) => word.pattern.test(candidate)));
}
