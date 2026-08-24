// Recruitment / ATS — is this string the name of an employer, or is it wreckage?
//
// The "Who this is" card exists to answer one question in a glance: who is this person. The Employer
// cell is one of six slots on it, and a slot spent on something that is not a company name is worse
// than an empty slot — the reader stops, re-reads, and works out for themselves that the system has
// nothing. Measured against production 2026-08-25, of the 307 undecided candidates showing an
// Employer, the cell was rendering: `(`, `( )` four times over, `01/`, `07.`, a bare `2`, `From`,
// `From :`, `from 15-12`, `and missions.`, `insurance.`, `training`, `Key Responsibilities`, and in
// one case 285 characters of somebody's job duties — "Oversaw medication inventory management,
// including ordering, stocking, and secure storage.- Collaborated with…".
//
// None of that is a fault in the CV reader. The model was asked for the current employer, found a
// line that looked like one, and honestly hedged it — 38 of the 39 arrive marked low-confidence and
// render in italic with a "?", which is the marking doing exactly its job. But a garbage value
// flagged as uncertain is still garbage occupying the slot, so this module decides what earns the
// slot at all.
//
// TWO RULES GOVERNED EVERY CHOICE BELOW, and they are why the lists are short and closed:
//
//   1. **When in doubt, keep it.** An odd employer is still information; a missing one is not.
//      `S. A. Miro, Inc.`, `Egyptian Russian University.`, `Kk's Tavern, 25 Nkonjane Street
//      kwanobuhle 6242` and `Qfix info Infocomm Pvt. Ltd. (100% subsidiary of Pine Labs)` all look
//      strange and all are real answers. Every rule here was checked against the full production
//      list of 307 before it was written, and any rule that stripped one of those was dropped.
//   2. **Tidy before rejecting.** Most of what looks broken is a good name wearing noise —
//      `Maxim Foods ( )`, `Psychological Medicine Hospital Dr.Adel Sadek ( ).`, `NP Pharma from .`.
//      Cleaning those keeps the fact and loses only the wreckage, which is strictly better than
//      either showing them as-is or throwing them away.
//
// What this module deliberately does NOT catch: prose that reads like a name unless you know the
// language ("proper documentation.", "relationship-driven selling.", "Ent, Im, Ortho, pedia,
// Chest)"), and mojibake. Catching those needs semantics, and a rule loose enough to reach them
// takes real companies with it. They stay on screen, hedged, which is the honest outcome.
//
// Nothing here writes anything. The stored column and the stored extraction are untouched — this
// decides only what is shown.

/** Empty bracket pairs: what is left when the CV reader copies "Company ( )" out of a template. */
const EMPTY_BRACKETS = /[([{]\s*[)\]}]/g;

/** Dot leaders and ellipses — "Ahmedabad)………......" is a table of contents, not a company. */
const DOT_LEADERS = /[.…]{2,}/g;

/**
 * Leading wreckage. A single `.` is included here but NOT in the trailing set: see below.
 *
 * Brackets are deliberately ABSENT from both classes — they are handled by balance instead, below.
 */
const LEADING_JUNK = /^[\s\-–—|/\\,;:.·•]+/;

/**
 * Trailing wreckage. A lone `.` is NOT stripped here — `Safe Hearts co.`, `Carea pharma.` and
 * `Best Agrolife Ltd.` all end in a period that belongs to the name. An ORPHAN period (one with a
 * space in front of it) is a different thing and is handled separately.
 */
const TRAILING_JUNK = /[\s\-–—|/\\,;:·•([{]+$/;

/** " ." left behind after an empty bracket pair is removed. */
const ORPHAN_PERIOD = /\s+\.\s*$/;

/** Punctuation pushed away from its word by a bracket removal: "Laboratory : Lab" -> "Laboratory: Lab". */
const FLOATING_PUNCTUATION = /\s+([,;:.])/g;

/**
 * Words that cannot begin the name of a company, only the middle of a sentence.
 *
 * Kept to the six that are unambiguous. `for`, `at`, `in`, `to` and `by` were all considered and
 * rejected: Egyptian companies are routinely named "<X> for Trading", and a rule that fires on a
 * leading `for` is one bad CV parse away from deleting a real one.
 */
const FRAGMENT_STARTS = new Set(["and", "from", "of", "since", "until", "till"]);

/** Trailing connectives, stripped once: "NP Pharma from ." tidies to "NP Pharma". */
const TRAILING_CONNECTIVES = new Set(["and", "from", "of", "with", "at", "in"]);

/**
 * A whole value that answers nothing. Matched against the ENTIRE tidied string, never a substring,
 * so `Scab Pharmacy` and `Advanced care pharma` are untouched.
 *
 * `freelance`, `student` and `unemployed` are deliberately absent — those DO tell a screener
 * something real about the person, and stripping them would hide an answer rather than a gap.
 */
const EMPTY_ANSWERS = new Set([
  "company",
  "current",
  "date",
  "duties",
  "employer",
  "experience",
  "insurance",
  "job description",
  "key responsibilities",
  "main tasks",
  "n/a",
  "na",
  "nil",
  "none",
  "not available",
  "not mentioned",
  "not specified",
  "personnel & operations",
  "present",
  "responsibilities",
  "training",
  "unknown",
  "unspecified",
  "various",
  "various clients",
  "work experience",
]);

/**
 * Places. Used ONLY to reject a value whose every word is one of these — never as a substring test,
 * because `Fly Egypt`, `Toyota Egypt`, `Dabur Egypt Ltd`, `Union pharma Egypt` and `Egypt Sun
 * Marine` are all real employers and every one of them contains a place name.
 */
const PLACE_WORDS = new Set([
  "africa", "alexandria", "arabia", "area", "asia", "assiut", "aswan", "asyut", "bahrain", "beheira",
  "cairo", "china", "city", "dakahlia", "damietta", "delhi", "dubai", "east", "egypt", "emirates",
  "fayoum", "gcc", "gharbia", "giza", "governorate", "greater", "india", "iraq", "ismailia",
  "jeddah", "jordan", "ksa", "kuwait", "lahore", "lanka", "lebanon", "libya", "luxor", "mansoura",
  "menoufia", "middle", "minya", "new", "north", "oman", "pakistan", "qatar", "qena", "region",
  "riyadh", "saudi", "sharkia", "sohag", "south", "sri", "sudan", "suez", "syria", "tanta",
  "turkey", "uae", "west", "zagazig",
]);

/** Date words. Same all-of-them rule: "Jan 2026 _ till now" is a period of employment, not a place of it. */
const DATE_WORDS = new Set([
  "apr", "april", "aug", "august", "current", "date", "dec", "december", "feb", "february", "from",
  "jan", "january", "jul", "july", "jun", "june", "mar", "march", "may", "month", "months", "nov",
  "november", "now", "oct", "october", "present", "sep", "sept", "september", "till", "to", "until",
  "year", "years", "yr", "yrs",
]);

/**
 * Verbs a CV bullet begins with. Only fires as the FIRST word of a value of four words or more, so
 * a two-word company that happens to start with one of these survives.
 */
const DUTY_VERBS = new Set([
  "achieved", "analysed", "analyzed", "assigned", "built", "collaborated", "conducted",
  "coordinated", "created", "delivered", "designed", "developed", "drove", "ensured", "established",
  "executed", "expanding", "focused", "focusing", "generated", "handled", "implemented", "improved",
  "increased", "led", "maintained", "managed", "monitored", "negotiated", "optimised", "optimized",
  "organised", "organized", "oversaw", "performed", "planned", "prepared", "promoted", "provided",
  "responsible", "reviewed", "supervised", "supported", "trained", "worked",
]);

/**
 * The longest a company name gets before it is prose.
 *
 * The longest REAL name in the production list is 78 characters (`Madawa Pharmaceutical Company |
 * Twenty One Food Industries | Mira Technologies`), so this sits above it with headroom and catches
 * the two paragraphs at 134 and 285. It has a second, independent justification: the card must not
 * wrap, and a value this long cannot be laid out without wrapping.
 */
const LONGEST_PLAUSIBLE_EMPLOYER_NAME = 90;

/** Whitespace-delimited words, lowercased and stripped of surrounding punctuation. Empties dropped. */
function words(value: string): string[] {
  return value
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
    .filter((word) => word.length > 0);
}

/** Every word is in `set`. An empty list is not "all of them" — it is nothing, and answers false. */
function everyWordIn(list: readonly string[], set: ReadonlySet<string>): boolean {
  return list.length > 0 && list.every((word) => set.has(word) || /^\d+(st|nd|rd|th)?$/.test(word));
}

/**
 * A bracket at either end with nothing to match it. `Ahmedabad)` and `New Cairo)` lost their
 * opener to a CV template; a lone `(` lost its closer. The leftover is wreckage either way.
 *
 * BALANCE is the whole test, and it has to be, at BOTH ends: `CIB (Commercial International Bank
 * - Egypt)` and `Cosmo Pharma (Pvt.) Ltd.` end in a bracket that belongs to them, and
 * `(PharmaOverSeas ) with Over Than 54 Branches` opens with one. A rule that stripped a bracket on
 * sight rewrote all three on screen — the leading half of it actually shipped in a first draft of
 * this module and was caught by measuring the tidy against production rather than by the test.
 */
function dropUnbalancedBrackets(value: string): string {
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const;
  let out = value;
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [open, close] of pairs) {
      const opened = out.split(open).length - 1;
      const closed = out.split(close).length - 1;
      if (out.endsWith(close) && closed > opened) out = out.slice(0, -1).trim();
      if (out.startsWith(open) && opened > closed) out = out.slice(1).trim();
    }
  }
  return out;
}

function tidy(raw: string): string {
  let value = raw.replace(/\s+/g, " ").trim();
  // Twice: "Company ( ) ( )" and "Office ( ):" both need a second pass once the brackets are gone.
  for (let pass = 0; pass < 2; pass += 1) {
    value = value.replace(EMPTY_BRACKETS, " ").replace(DOT_LEADERS, " ").replace(/\s+/g, " ").trim();
    value = value.replace(ORPHAN_PERIOD, "").replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "").trim();
    value = dropUnbalancedBrackets(value);
  }
  value = value.replace(FLOATING_PUNCTUATION, "$1").trim();

  // One trailing connective, and only one: "NP Pharma from ." has already lost its orphan period
  // above and is left dangling on "from".
  const parts = value.split(/\s+/);
  const last = parts[parts.length - 1]?.replace(/[^\p{L}]/gu, "").toLowerCase() ?? "";
  if (parts.length > 1 && TRAILING_CONNECTIVES.has(last)) {
    value = parts.slice(0, -1).join(" ").replace(TRAILING_JUNK, "").trim();
  }
  return value;
}

/**
 * The employer name to show, or `null` when the value cannot be one.
 *
 * `null` means the Employer cell is omitted entirely rather than rendered with wreckage in it — and
 * because the "Current role" cell takes its hover hint from the same value, one answer here fixes
 * both places at once.
 */
export function cleanEmployerName(raw: string | null | undefined): string | null {
  const value = tidy(String(raw ?? ""));
  if (value.length === 0) return null;

  // Not a name: fewer than two letters in it at all. `(`, `( )`, `01/`, `07.`, `2`.
  const letters = value.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return null;

  // Prose, by length. Checked before the word rules because a paragraph can start with anything.
  if (value.length > LONGEST_PLAUSIBLE_EMPLOYER_NAME) return null;

  const list = words(value);
  if (list.length === 0) return null;

  // A sentence fragment, caught by the word it starts on.
  if (FRAGMENT_STARTS.has(list[0])) return null;

  // A CV bullet. Four words or more, so a short company name starting on the same word survives.
  if (list.length >= 4 && DUTY_VERBS.has(list[0])) return null;

  // A value that answers nothing, matched whole. Both forms are checked because the two disagree
  // on punctuation: "Personnel & Operations" keeps its ampersand, the word list drops it.
  const whole = value.toLowerCase().trim();
  const bare = whole.endsWith(".") ? whole.slice(0, -1) : whole;
  if (EMPTY_ANSWERS.has(whole) || EMPTY_ANSWERS.has(bare) || EMPTY_ANSWERS.has(list.join(" "))) return null;

  // A location or a date rather than an employer — only when EVERY word is one.
  if (everyWordIn(list, PLACE_WORDS)) return null;
  if (everyWordIn(list, DATE_WORDS)) return null;

  return value;
}
