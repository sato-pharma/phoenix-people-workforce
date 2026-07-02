import { foldCustomerNameText, stripEntityPrefixTokens } from "@/lib/sales/normalizer/customer-normalize";

// Known Egyptian pharmacy chains. A chain name alone identifies the BRAND, not the location —
// "العزبي مدينة نصر" and "العزبي أسيوط" are different bricks. So chain names get special matching
// rules: two chain entries match only when their branch tokens (the residual text after the chain
// pattern) are compatible, and a chain name never fuzzy-matches a non-chain name.
//
// Const config, not a table: the chain landscape is ~6 brands and changes rarely; a table would
// add a migration + admin UI for a handful of rows.

export type PharmacyChain = {
  key: string;
  label: string;
  // Patterns are matched against the NORMALIZED name (normalizeCustomerNameKey output), as
  // whole-word substrings. Multi-word patterns match consecutive tokens.
  patterns: string[];
};

export const PHARMACY_CHAINS: PharmacyChain[] = [
  { key: "elezaby", label: "El Ezaby", patterns: ["العزبي", "عزبي", "el ezaby", "al ezaby", "elezaby", "ezaby"] },
  { key: "19011", label: "19011", patterns: ["19011"] },
  { key: "seif", label: "Seif", patterns: ["سيف", "seif"] },
  // Bare "مصر" is far too common in addresses (مصر الجديدة, شارع مصر…) — require the explicit
  // chain form "صيدليات مصر" which normalizeCustomerNameKey keeps when صيدليات is followed by مصر.
  { key: "misr", label: "Misr Pharmacies", patterns: ["صيدليات مصر", "misr pharmacies"] },
  { key: "roshdy", label: "Roshdy", patterns: ["رشدي", "روشدي", "roshdy", "roshdi"] },
  { key: "care", label: "Care", patterns: ["كير", "care"] },
];

export type ChainMatch = {
  chainKey: string;
  // Residual normalized text after removing the chain pattern — the branch discriminator
  // (e.g. "العزبي المنصورة" → "المنصوره"). Empty when the name is just the chain.
  branchToken: string;
};

function matchPatternTokens(nameTokens: string[], patternTokens: string[]): number {
  // Returns the start index of the first consecutive-token match, or -1.
  outer: for (let i = 0; i + patternTokens.length <= nameTokens.length; i += 1) {
    for (let j = 0; j < patternTokens.length; j += 1) {
      if (nameTokens[i + j] !== patternTokens[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function detectChain(rawName: string): ChainMatch | null {
  // Match against the NON-stripped normalized form so word-anchored patterns keep their anchor
  // token (e.g. "صيدليات مصر" needs to see صيدليات — the stripped key would delete it).
  const normalized = foldCustomerNameText(rawName);
  if (!normalized) return null;
  const nameTokens = normalized.split(" ").filter(Boolean);
  for (const chain of PHARMACY_CHAINS) {
    for (const pattern of chain.patterns) {
      const patternTokens = foldCustomerNameText(pattern).split(" ").filter(Boolean);
      if (patternTokens.length === 0) continue;
      const at = matchPatternTokens(nameTokens, patternTokens);
      if (at < 0) continue;
      const residual = [...nameTokens.slice(0, at), ...nameTokens.slice(at + patternTokens.length)].join(" ");
      // Strip entity prefixes from the residual so "صيدلية العزبي المنصورة" → branch "المنصوره";
      // a residual of just "صيدليه" (name was only prefix + chain) collapses to "".
      return { chainKey: chain.key, branchToken: stripEntityPrefixTokens(residual) };
    }
  }
  return null;
}

// Two names belong to the same physical branch only when both are the same chain AND their
// branch tokens are compatible (equal, or one side empty is NOT enough — an unbranched chain
// name could be any branch, so it never asserts a match).
export function sameChainBranch(a: ChainMatch, b: ChainMatch): boolean {
  if (a.chainKey !== b.chainKey) return false;
  if (!a.branchToken || !b.branchToken) return false;
  return a.branchToken === b.branchToken;
}
