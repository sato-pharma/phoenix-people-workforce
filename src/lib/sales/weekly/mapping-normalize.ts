// Shared key-normalization for Weekly Sales mapping lookups (product aliases + branch->region).
// The upload parser and the mapping importer MUST normalize identically, so a value mapped once
// joins the raw distributor file deterministically every week.

/** Uppercased, whitespace-collapsed key for codes (product codes, region codes, branch codes). */
export function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * Lowercased, Arabic-folded join key for free-text values (product/item names, branch/outlet
 * names). Unifies alef-hamza forms and ya/alef-maqsura, strips Arabic diacritics/tatweel, and
 * collapses whitespace so the mapped value and the raw cell resolve to the same key.
 */
export function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[أإآٱ]/g, "ا") // alef-hamza forms -> bare alef
    .replace(/ى/g, "ي") // alef-maqsura -> ya
    .replace(/[ً-ْٰـ]/g, "") // strip Arabic diacritics + tatweel
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalize an alias by kind: codes are upper-cased, names are Arabic-folded. */
export function normalizeAlias(value: unknown, kind: "code" | "name"): string {
  return kind === "code" ? normalizeCode(value) : normalizeKey(value);
}
