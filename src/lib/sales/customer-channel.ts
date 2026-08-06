// Customer channel — is a Source-of-Sales customer a HOSPITAL, a STORE (wholesaler / warehouse /
// trading company) or a PHARMACY?
//
// The owner's rule (2026-08-04): a customer whose NAME contains any of six Arabic words is a
// store; everything else is a pharmacy. Hospitals were added as a third channel on 2026-08-05 on
// the same principle — a name carrying مستشف (which covers both مستشفى and مستشفي) or the latin
// "hosp" is a hospital. This is deliberately computed at READ time from the customer's name rather
// than stored on the row, so it applies identically to the sales already uploaded and to every
// future historical upload — a new sheet needs no backfill, no migration and no re-classification
// step. Add a word to either list below and the whole history re-classifies on the next render.
//
// Matching is SUBSTRING, not whole-word: مخزن must also catch المخزن, and فارم must catch فارما,
// فارماسي and فارمسي. Because فارم is a prefix of فارما, the shorter stem covers both.

export type CustomerChannel = "hospital" | "pharmacy" | "store";

export type ChannelNameKeyword = {
  /** What the owner calls this word — shown in the UI and in exports. */
  readonly label: string;
  /** The stem actually matched. Normalised before use, so spelling here is forgiving. */
  readonly stem: string;
};

// THE single edit point for the store rule. Adding an entry re-classifies all history.
export const STORE_NAME_KEYWORDS: readonly ChannelNameKeyword[] = [
  { label: "مخزن", stem: "مخزن" },
  // فارم is a prefix of فارما, so one stem covers فارم / فارما / فارماسي / فارمسي.
  { label: "فارما / فارم", stem: "فارم" },
  { label: "تريد", stem: "تريد" },
  { label: "الشركة", stem: "الشركة" },
  { label: "الجمعيه", stem: "الجمعيه" },
  { label: "للتجارة", stem: "للتجارة" },
];

// THE single edit point for the hospital rule. مستشف is the shared prefix of مستشفى and مستشفي,
// so one stem covers both spellings and every suffix distributors put after them.
export const HOSPITAL_NAME_KEYWORDS: readonly ChannelNameKeyword[] = [
  { label: "مستشفى / مستشفي", stem: "مستشف" },
  // normalizeCustomerName lowercases latin, so this stem catches Hospital / HOSPITAL / hospitals.
  { label: "hospital", stem: "hosp" },
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

function matchKeywords(
  name: string | null | undefined,
  keywords: readonly ChannelNameKeyword[],
): string[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return keywords
    .filter((keyword) => normalized.includes(normalizeCustomerName(keyword.stem)))
    .map((keyword) => keyword.label);
}

/**
 * Which of the owner's store words appear in this customer's name, in the order they are listed
 * above. Empty array means the name carries no store word. Used by the Stores tab to show WHY a
 * customer was classified as a store, so a false positive is visible rather than buried.
 */
export function matchedStoreKeywords(name: string | null | undefined): string[] {
  return matchKeywords(name, STORE_NAME_KEYWORDS);
}

/** Which hospital words appear in this customer's name. Same purpose as the store version. */
export function matchedHospitalKeywords(name: string | null | undefined): string[] {
  return matchKeywords(name, HOSPITAL_NAME_KEYWORDS);
}

/**
 * The words that explain the channel this customer was actually placed in — hospital words when
 * it is a hospital, store words otherwise. A pharmacy reports none.
 */
export function matchedChannelKeywords(name: string | null | undefined): string[] {
  const hospital = matchedHospitalKeywords(name);
  return hospital.length > 0 ? hospital : matchedStoreKeywords(name);
}

/**
 * Customers the owner has ruled are PHARMACIES even though their name carries a store word.
 *
 * THE SINGLE EDIT POINT for the exceptions. Keyed by CUSTOMER CODE, not name: the same shop is
 * spelled differently in each distributor's file, so a name-keyed exception silently stops applying
 * the first time a distributor writes it another way — while the code stays put.
 *
 * The owner reviewed all 22 store-classified Anti Infective customers on 2026-08-06 and ruled every
 * one a genuine store except the two below. Kept as an explicit list rather than by weakening the
 * keywords, because he also ruled the keyword list must stay exactly as it is.
 */
export const PHARMACY_OVERRIDE_CLIENT_CODES: ReadonlySet<string> = new Set([
  // المتحدةشركة صيدليات عابدين فارما — a pharmacy chain, not a warehouse. Matched on فارم.
  "421516",
  // مخزن الطرشوبى للادويه — a pharmacy despite the name. Matched on مخزن, the one keyword that
  // looked safe, which is exactly why these exceptions are keyed by code and not by weakening a
  // word: no keyword survives contact with how shops actually name themselves.
  "1577318",
]);

/** Codes arrive with distributor-specific zero padding, so compare on the digits alone. */
function normalizeClientCode(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^0+/, "") || trimmed;
}

/** True when the owner has ruled this customer a pharmacy despite a store word in its name. */
export function isPharmacyOverride(clientCode: string | null | undefined): boolean {
  const code = normalizeClientCode(clientCode);
  return code !== "" && PHARMACY_OVERRIDE_CLIENT_CODES.has(code);
}

/**
 * A customer is a HOSPITAL when its name carries a hospital word, else a STORE when it carries one
 * of the six store words, else a PHARMACY. Hospital wins the overlap because a name like
 * "جمعيه ... (ص مستشفى)" carries both, and it is the hospital that identifies the customer.
 * A blank name is evidence of nothing, so it falls to pharmacy — the same side an un-keyworded
 * name lands on.
 *
 * `clientCode` is optional so every existing caller keeps working, but pass it wherever it is to
 * hand: it is the only way an owner override can be honoured, and a caller that omits it silently
 * gets the keyword answer.
 */
export function classifyCustomerChannel(
  name: string | null | undefined,
  clientCode?: string | null,
): CustomerChannel {
  if (matchedHospitalKeywords(name).length > 0) return "hospital";
  if (isPharmacyOverride(clientCode)) return "pharmacy";
  if (matchedStoreKeywords(name).length > 0) return "store";
  return "pharmacy";
}

/**
 * Does this customer carry a STORE word — regardless of whether it also carries a hospital word.
 *
 * Deliberately NOT `classifyCustomerChannel(name) === "store"`. The Monthly Closing's city split
 * (src/lib/sales/store-sales-city-split.ts) asks this question to decide whether a customer's
 * sales get spread across its city's areas. Routing it through the classifier would mean that
 * adding the hospital channel silently stopped splitting every store whose name also mentions a
 * hospital — a UI change quietly moving money between areas in the closing. Keep it keyword-based.
 */
export function isStoreCustomer(
  name: string | null | undefined,
  clientCode?: string | null,
): boolean {
  // The owner's override DOES apply here, unlike the hospital rule above. The reason they differ:
  // the hospital carve-out is a classification nuance, while an override says "this is not a
  // warehouse at all". Splitting an overridden customer's sales across its city would move a
  // pharmacy's money onto other reps — the exact error the override exists to stop.
  if (isPharmacyOverride(clientCode)) return false;
  return matchedStoreKeywords(name).length > 0;
}

/**
 * Split any list of named customers into the three channels, preserving the incoming order
 * within each side. Generic so the directory rows, an export row, or a future sales row can
 * all use the one rule instead of re-implementing it.
 */
export function splitByCustomerChannel<T>(
  rows: readonly T[],
  nameOf: (row: T) => string | null | undefined,
): { hospitals: T[]; pharmacies: T[]; stores: T[] } {
  const hospitals: T[] = [];
  const pharmacies: T[] = [];
  const stores: T[] = [];
  for (const row of rows) {
    const channel = classifyCustomerChannel(nameOf(row));
    if (channel === "hospital") hospitals.push(row);
    else if (channel === "store") stores.push(row);
    else pharmacies.push(row);
  }
  return { hospitals, pharmacies, stores };
}
