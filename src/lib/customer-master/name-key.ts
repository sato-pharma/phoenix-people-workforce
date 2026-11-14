// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER NAME KEY — the one exported matcher for a customer's (pharmacy's) name
// (enterprise audit REC-009, F-SAL-010; 14 Nov 2026).
//
// `foldCustomerName` is the fold Pharmacy Master, Pharmacy Search, Direct Orders and Phoenix CRM's
// pharmacy rules compare names on. It is the same function that lived in
// `pharmacy-master/pharmacy-matching.ts` as `normalizeArabicPharmacyName`, moved here unchanged, so no
// key and no match changed; that name still answers at its old address, and is the same function.
//
// The owner chose (14 Nov 2026) "one home, no merges": the other customer-name folds keep their own
// rules, because switching them would merge names that some screens now treat as two customers.
// They are listed in `CUSTOMER_NAME_FOLDS_THAT_DIFFER` below, each with the reason it differs. A new
// fold of a customer's name either calls `foldCustomerName` or is added to that list on purpose;
// `tests/customer-name-key.test.ts` refuses one that does neither. Which folder owns what:
// docs/customer-master.md.
//
// PURE: no database, no clock.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The customer name key: NFKD, Latin combining marks and Arabic harakat dropped, tatweel dropped,
 * every alef form (إ أ آ ا) to ا, ى to ي, lowercased, anything that is not a Latin letter, a digit, an
 * Arabic letter or a space to a space, runs of spaces to one. Words are kept apart; ة and ه stay apart.
 */
export function foldCustomerName(value: string | null | undefined): string {
  if (!value) return "";
  let text = value.normalize("NFKD");
  text = Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const isLatinCombining = code >= 0x0300 && code <= 0x036f;
      const isArabicHarakat = (code >= 0x064b && code <= 0x065f) || code === 0x0670;
      return !isLatinCombining && !isArabicHarakat;
    })
    .join("");
  text = text.replace(/ـ/g, ""); // tatweel
  text = text.replace(/[إأآا]/g, "ا");
  text = text.replace(/ى/g, "ي");
  text = text.toLowerCase();
  text = text.replace(/[^0-9a-zء-ي\s]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Generic words that say nothing about WHICH customer it is ("pharmacy", "new", "doctor", "hospital"). */
export const CUSTOMER_NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  "صيدلية",
  "صيدليه",
  "فارما",
  "الجديدة",
  "الجديده",
  "جديدة",
  "جديده",
  "دكتور",
  "د",
  "مستشفى",
  "مستشفي",
]);

/**
 * Remove the stop words from an already-keyed name — never down to zero words, so a name made ONLY
 * of generic words still has something to compare.
 */
export function removeCustomerStopWords(keyed: string): string {
  const tokens = keyed.split(" ").filter(Boolean);
  const filtered = tokens.filter((token) => !CUSTOMER_NAME_STOP_WORDS.has(token));
  return (filtered.length > 0 ? filtered : tokens).join(" ");
}

/** A customer-name fold that deliberately keeps its own rule (owner, 14 Nov 2026: "one home, no merges"). */
export type CustomerNameFoldThatDiffers = {
  /** The exported function (or SQL function) name. */
  name: string;
  /** Where it is defined. */
  file: string;
  /** Who reads it. */
  usedBy: string;
  /** Why it is not `foldCustomerName`, and what switching it would change. */
  why: string;
};

export const CUSTOMER_NAME_FOLDS_THAT_DIFFER: readonly CustomerNameFoldThatDiffers[] = [
  {
    name: "pharmacyNameKey",
    file: "src/lib/phoenix-crm/pharmacy-call-rules.ts",
    usedBy: "Phoenix CRM's Add a pharmacy and pharmacy-visit matching; Customer 360's pharmacy matcher",
    why: "Builds ON foldCustomerName: Arabic digits to Latin first, then ة→ه, ؤ→و, ئ→ي, the word 'pharmacy' dropped and the words joined with no space.",
  },
  {
    name: "normalizePharmacyName",
    file: "src/lib/phoenix-crm/server/list.ts",
    usedBy: "Phoenix CRM's list: a doctor's pharmacies grouped, and the insight reports' pharmacy key",
    why: "Spacing and case only. Folding letters here would merge pharmacies a rep's list now shows as two (صيدلية / صيدليه).",
  },
  {
    name: "normalizeName",
    file: "src/lib/phoenix-crm/google-place-rules.ts",
    usedBy: "Phoenix CRM's check of a Google listing against a hospital or pharmacy on the list",
    why: "NFKC, also folds ٱ, ة→ه, ؤ→و, ئ→ي and keeps every Unicode letter; a different listing match would change which places validate.",
  },
  {
    name: "identityNameKey",
    file: "src/lib/customer-identity/suggestions.ts",
    usedBy: "Customer identity suggestions (a CRM doctor or pharmacist against a sales customer)",
    why: "A PERSON's name: titles stripped (normalizeContactName), then the place-spelling fold (placeNameKey, ض↔د and the vowels) for transliterations.",
  },
  {
    name: "customerNameKey",
    file: "src/lib/phoenix-crm/name-fold.ts",
    usedBy: "Phoenix CRM: refusing a second customer of one kind on one seat (the browser copy of phoenix_crm_fold_name)",
    why: "Must equal the database's phoenix_crm_fold_name step for step: NFKC, ٱ and ة→ه folded, honorifics dropped. A different job from foldCustomerName, despite the similar name.",
  },
  {
    name: "foldSearchText",
    file: "src/lib/phoenix-crm/name-fold.ts",
    usedBy: "Phoenix CRM's search boxes and sort order, in the browser",
    why: "Letters only, punctuation and spaces kept, so a typed word is found inside a name. Runs on every keystroke.",
  },
  {
    name: "venueKey",
    file: "src/lib/crm/contact-trade.ts",
    usedBy: "The CRM's contact trade: a venue name matched by prefix",
    why: "Keeps spaces so a prefix respects word boundaries; switching it would change which venues a prefix reaches.",
  },
  {
    name: "normalizeAccountText",
    file: "src/lib/crm/campaign-account.ts",
    usedBy: "CRM campaigns: whether a campaign's account words appear in a visit's account",
    why: "A containment check on words, with ة→ه folded; keyed names would change which visits count for a campaign.",
  },
  {
    name: "normalizeKey",
    file: "src/lib/sales/weekly/mapping-normalize.ts",
    usedBy: "Weekly Sales mapping: a branch or outlet name (and a product name) joined to its mapped value",
    why: "Also folds ٱ; stored weekly mappings are joined by this key, so a different fold would miss saved mappings.",
  },
  {
    name: "normalizeIdentityText",
    file: "src/lib/sales/customer-mapping.ts",
    usedBy: "Source of Sales customer map: the stable master id of a sales customer",
    why: "Keeps every alef form apart. The master id is a hash of this key, so a different fold would give every mapped customer a new id.",
  },
  {
    name: "normalizeAliasKey",
    file: "src/lib/sales/normalizer/resolvers.ts",
    usedBy: "Source Normalizer: a distributor's customer and product aliases",
    why: "Arabic digits folded, harakat kept. Stored aliases are looked up by this key, so a different fold would miss saved aliases.",
  },
  {
    name: "phx_normalize_arabic",
    file: "supabase (SQL function)",
    usedBy: "The direct-order customer picker (phx_search_direct_order_customers), in the database",
    why: "Drops every space and folds ٱ, ة→ه, ئ→ي. It runs inside SQL, where the TypeScript key cannot.",
  },
];
