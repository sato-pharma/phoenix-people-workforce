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

/** Two names in list order, with أحمد and احمد next to each other. */
export function compareFoldedNames(left: string | null | undefined, right: string | null | undefined): number {
  return foldSearchText(left).localeCompare(foldSearchText(right)) || String(left ?? "").localeCompare(String(right ?? ""));
}
