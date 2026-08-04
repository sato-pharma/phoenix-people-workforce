// Customer channel — is a Source-of-Sales customer a STORE (wholesaler / warehouse / trading
// company) or a PHARMACY?
//
// The owner's rule (2026-08-04): a customer whose NAME contains any of six Arabic words is a
// store; everything else is a pharmacy. This is deliberately computed at READ time from the
// customer's name rather than stored on the row, so it applies identically to the sales already
// uploaded and to every future historical upload — a new sheet needs no backfill, no migration
// and no re-classification step. Add a word to STORE_NAME_KEYWORDS below and the whole history
// re-classifies on the next render.
//
// Matching is SUBSTRING, not whole-word: مخزن must also catch المخزن, and فارم must catch فارما,
// فارماسي and فارمسي. Because فارم is a prefix of فارما, the shorter stem covers both.

export type CustomerChannel = "pharmacy" | "store";

export type StoreNameKeyword = {
  /** What the owner calls this word — shown in the UI and in exports. */
  readonly label: string;
  /** The stem actually matched. Normalised before use, so spelling here is forgiving. */
  readonly stem: string;
};

// THE single edit point for the store rule. Adding an entry re-classifies all history.
export const STORE_NAME_KEYWORDS: readonly StoreNameKeyword[] = [
  { label: "مخزن", stem: "مخزن" },
  // فارم is a prefix of فارما, so one stem covers فارم / فارما / فارماسي / فارمسي.
  { label: "فارما / فارم", stem: "فارم" },
  { label: "تريد", stem: "تريد" },
  { label: "الشركة", stem: "الشركة" },
  { label: "الجمعيه", stem: "الجمعيه" },
  { label: "للتجارة", stem: "للتجارة" },
];

// Harakat (U+064B–U+0652), tatweel (U+0640) and the superscript alef (U+0670) carry no identity
// in a typed customer name — distributors add them inconsistently. Strip them entirely.
const ARABIC_MARKS = /[ً-ْـٰ]/g;

// Letters Egyptian data entry treats as interchangeable. Without this fold, searching الشركة
// finds NONE of the real customers, because they are stored as الشركه.
const LETTER_FOLD: ReadonlyMap<string, string> = new Map([
  ["أ", "ا"], // أ -> ا
  ["إ", "ا"], // إ -> ا
  ["آ", "ا"], // آ -> ا
  ["ٱ", "ا"], // ٱ -> ا
  ["ة", "ه"], // ة -> ه
  ["ى", "ي"], // ى -> ي
  ["ی", "ي"], // ی (farsi yeh) -> ي
  ["ک", "ك"], // ک (keheh) -> ك
]);

/**
 * Fold an Arabic customer name to the form both sides of a comparison must share:
 * marks stripped, interchangeable letters unified, latin lowercased, whitespace collapsed.
 * Exported because the same folding has to be applied to any search box that looks for these
 * words — a raw `includes` silently misses most real matches.
 */
export function normalizeCustomerName(value: string | null | undefined): string {
  const raw = String(value ?? "").replace(ARABIC_MARKS, "");
  let folded = "";
  for (const char of raw) folded += LETTER_FOLD.get(char) ?? char;
  return folded.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Which of the owner's words appear in this customer's name, in the order they are listed
 * above. Empty array means the customer is a pharmacy. Used by the Stores tab to show WHY a
 * customer was classified as a store, so a false positive is visible rather than buried.
 */
export function matchedStoreKeywords(name: string | null | undefined): string[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return STORE_NAME_KEYWORDS.filter((keyword) =>
    normalized.includes(normalizeCustomerName(keyword.stem)),
  ).map((keyword) => keyword.label);
}

/**
 * A customer is a STORE when its name carries any of the six words, otherwise a PHARMACY.
 * A blank name cannot be shown to be a store, so it falls to pharmacy — the same side an
 * un-keyworded name lands on.
 */
export function classifyCustomerChannel(name: string | null | undefined): CustomerChannel {
  return matchedStoreKeywords(name).length > 0 ? "store" : "pharmacy";
}

export function isStoreCustomer(name: string | null | undefined): boolean {
  return classifyCustomerChannel(name) === "store";
}

/**
 * Split any list of named customers into the two channels, preserving the incoming order
 * within each side. Generic so the directory rows, an export row, or a future sales row can
 * all use the one rule instead of re-implementing it.
 */
export function splitByCustomerChannel<T>(
  rows: readonly T[],
  nameOf: (row: T) => string | null | undefined,
): { pharmacies: T[]; stores: T[] } {
  const pharmacies: T[] = [];
  const stores: T[] = [];
  for (const row of rows) {
    if (isStoreCustomer(nameOf(row))) stores.push(row);
    else pharmacies.push(row);
  }
  return { pharmacies, stores };
}
