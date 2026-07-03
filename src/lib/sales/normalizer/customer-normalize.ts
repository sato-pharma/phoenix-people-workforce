import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";

// Customer-name-specific normalization, layered ON TOP of normalizeAliasKey. This is a separate
// function on purpose: normalizeAliasKey is the persistence key for stored product/territory
// aliases (upserts conflict on distributor_code+normalized_alias), so its output can never change.
// Customer mappings are keyed by (distributor_code, customer_code) — never by normalized name —
// so this richer folding is safe to evolve.
//
// Beyond normalizeAliasKey it folds the Arabic letter variants that distributor typists mix
// freely (ة/ه, ؤ/و, ئ/ي) and strips the entity prefixes (صيدلية, د/, dr, pharmacy …) that make
// the same pharmacy look like a different string in every upload.

// Leading tokens that carry no identity: legal/entity prefixes and honorifics. Stripped
// repeatedly so "صيدلية د احمد" → "احمد". Stored here ALREADY normalized (post letter-folding).
const STRIP_PREFIX_TOKENS = new Set([
  "صيدليه", // صيدلية folds to this via ة→ه
  "صيدليات",
  "د",
  "دكتور",
  "الدكتور",
  "دكتوره", // دكتورة post-fold
  "dr",
  "doctor",
  "ph",
  "pharmacy",
  "pharmacies",
]);

function foldCustomerLetters(value: string): string {
  return value
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

// Letter-folded, alias-normalized text WITHOUT prefix stripping. Chain detection matches against
// this form so word-anchored patterns like "صيدليات مصر" still see the صيدليات token.
export function foldCustomerNameText(value: unknown): string {
  return foldCustomerLetters(normalizeAliasKey(value));
}

// Strips leading entity-prefix tokens from an ALREADY letter-folded, alias-normalized string.
// Returns "" when every token is a prefix (caller decides the fallback).
export function stripEntityPrefixTokens(foldedText: string): string {
  const tokens = foldedText.split(" ").filter(Boolean);
  let start = 0;
  while (start < tokens.length && STRIP_PREFIX_TOKENS.has(tokens[start])) start += 1;
  return tokens.slice(start).join(" ");
}

export function normalizeCustomerNameKey(value: unknown): string {
  const base = foldCustomerLetters(normalizeAliasKey(value));
  const stripped = stripEntityPrefixTokens(base);
  if (stripped) return stripped;
  // Never strip the whole name away — a pharmacy literally named "صيدلية" keeps its last token.
  const tokens = base.split(" ").filter(Boolean);
  return tokens.length > 0 ? tokens[tokens.length - 1] : "";
}

// Normalized address tokens (length >= 2) for overlap scoring between two addresses.
export function customerAddressTokens(value: unknown): Set<string> {
  return new Set(
    foldCustomerLetters(normalizeAliasKey(value))
      .split(" ")
      .filter((t) => t.length >= 2),
  );
}

// Jaccard-style overlap of address token sets in [0, 1]; 0 when either side is empty.
export function addressTokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
