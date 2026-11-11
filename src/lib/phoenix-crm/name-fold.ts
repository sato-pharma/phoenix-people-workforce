/**
 * Phoenix CRM — one spelling for a name typed two ways, so a search finds both and a sort sits them side
 * by side. No I/O and no imports: the plan boards run it in the browser on every keystroke.
 *
 * Owner walk, 2026-10-28: typing مستشفى بنها found only the ى spelling of the hospital, and the list put
 * أحمد and احمد about 30 rows apart. Egyptian keyboards and copied lists disagree on the hamza carriers
 * (أ إ آ ٱ typed as bare ا), final ى against ي, final ة against ه, and diacritics — every one a spelling,
 * never a different doctor. The same letters `normalizeContactName` folds for the duplicate finder.
 */

const ARABIC_MARKS = /[ً-ْٰـ]/g;

/** A name, lower-cased with its Arabic spelling folded. For matching and ordering only — never shown. */
export function foldSearchText(text: string | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** Every word typed appears somewhere in the parts, in any order, Arabic spelling folded on both sides. */
export function foldedWordsMatch(query: string, parts: ReadonlyArray<string | null | undefined>): boolean {
  const words = foldSearchText(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = foldSearchText(parts.filter((part): part is string => Boolean(part)).join(" "));
  return words.every((word) => text.includes(word));
}

/** The honorifics `phoenix_crm_fold_name` drops, after the letter folds (so دكتورة arrives as دكتوره). */
const NAME_KEY_TITLES = new Set([
  "د",
  "دكتور",
  "دكتوره",
  "الدكتور",
  "الدكتوره",
  "دكتره",
  "dr",
  "drs",
  "doctor",
  "prof",
  "professor",
  "mr",
  "mrs",
  "ms",
]);

/**
 * 🔴 THE DATABASE'S OWN NAME KEY, IN THE BROWSER — `public.phoenix_crm_fold_name`, step for step: NFKC, lower case,
 * the letter folds, the marks and the tatweel, anything not a letter or a digit as a space, the honorifics out.
 * The door refuses a second customer of one kind on one seat by this key; a screen that warns by `toLowerCase`
 * missed "د. أحمد" beside "احمد" and let the rep save past it (47 same-seat pairs on 11 Nov 2026). "" is no name,
 * never a key.
 */
export function customerNameKey(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْٰـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !NAME_KEY_TITLES.has(word))
    .join(" ");
}

/** Two names in list order, with أحمد and احمد next to each other. */
export function compareFoldedNames(left: string | null | undefined, right: string | null | undefined): number {
  return foldSearchText(left).localeCompare(foldSearchText(right)) || String(left ?? "").localeCompare(String(right ?? ""));
}
