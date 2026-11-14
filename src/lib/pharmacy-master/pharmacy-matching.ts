// Pharmacy Master / Distributor Matching — pure candidate-detection logic (Phase 1).
//
// IO-free by design (matches the roi-explain.ts / roi-business-report.ts precedent in this
// repo) so every matching rule is unit-testable directly. The read-only data gathering
// (Supabase SELECTs over marketing_pharmacies / marketing_pharmacy_distributor_codes /
// marketing_distributors) lives in `pharmacy-matching-service.ts`.
//
// SUGGESTION-ONLY: this module only classifies candidate pairs — it never merges, writes,
// or auto-creates anything. Phase 0 audit (read-only, against production) found address/GPS
// coverage on marketing_pharmacies is ~0.3%, so name-only fuzzy matching is the primary
// signal today and is deliberately conservative: a "high" bucket that reproduced only 3
// candidates out of 287 pharmacies, and a documented, real false-positive rate at "medium"
// driven by common Arabic first names (احمد/محمد) — hence every non-exact match carries an
// explicit warning and nothing here is ever auto-applied.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import {
  foldCustomerName as normalizeArabicPharmacyName,
  removeCustomerStopWords as removeStopWords,
} from "@/lib/customer-master/name-key";

export type PharmacyMatchConfidence = "high" | "medium" | "low";
export type PharmacyMatchReason = "exact_key" | "normalized_name_similarity" | "token_overlap";

export const PHARMACY_MATCH_CONFIDENCE_LABEL: Record<PharmacyMatchConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PHARMACY_MATCH_REASON_LABEL: Record<PharmacyMatchReason, string> = {
  exact_key: "Exact key match (GPS or address)",
  normalized_name_similarity: "Normalized name similarity",
  token_overlap: "Shared name tokens",
};

// ── Access gate (Super Admin + CEO, Phase 1) ────────────────────────────────────────────
const PHARMACY_MASTER_ROLES = new Set<PhoenixRole>(["Super Admin", "CEO"]);

export function canAccessPharmacyMaster(access: AccessContext): boolean {
  if (access.source === "system" || access.scope === "system") return true;
  return PHARMACY_MASTER_ROLES.has(access.role);
}

export function assertPharmacyMasterAccess(access: AccessContext): void {
  if (!canAccessPharmacyMaster(access)) {
    throw new Error(`Forbidden: role "${access.role}" cannot access Pharmacy Master.`);
  }
}

// ── Arabic-aware name normalization: `foldCustomerName` in src/lib/customer-master/name-key.ts. ──
// The fold and its stop words live in the one customer-master home (REC-009, 14 Nov 2026), unchanged.
// These two names answer here as before, and are the very same functions.
export { normalizeArabicPharmacyName, removeStopWords };

export function nameTokens(value: string | null | undefined): Set<string> {
  const cleaned = removeStopWords(normalizeArabicPharmacyName(value));
  return new Set(cleaned.split(" ").filter((token) => token.length >= 2));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  const union = a.size + b.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function bigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  const result: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) result.push(compact.slice(i, i + 2));
  return result;
}

/** Dice's bigram coefficient — a dependency-free character-level similarity ratio (this
 *  codebase has no pg_trgm / Levenshtein / fuzzystrmatch utility; see the Phase 0 audit). */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const bigram of bigramsB) remaining.set(bigram, (remaining.get(bigram) ?? 0) + 1);
  let matches = 0;
  for (const bigram of bigramsA) {
    const count = remaining.get(bigram) ?? 0;
    if (count > 0) {
      matches += 1;
      remaining.set(bigram, count - 1);
    }
  }
  return (2 * matches) / (bigramsA.length + bigramsB.length);
}

/**
 * Confidence thresholds — reused verbatim from the Phase 0 read-only audit against
 * production (287 pharmacies): jaccard ≥ 0.66 or ratio ≥ 0.85 → high (produced exactly 3
 * candidates); jaccard ≥ 0.40 or ratio ≥ 0.70 → medium (24 candidates, several of which were
 * later found to be false positives from common first names — hence the mandatory warning);
 * anything else with SOME signal → low; no signal at all → not a candidate (`null`).
 */
export function resolvePharmacyMatchConfidence(jaccard: number, ratio: number): PharmacyMatchConfidence | null {
  if (jaccard === 0 && ratio < 0.55) return null;
  if (jaccard >= 0.66 || ratio >= 0.85) return "high";
  if (jaccard >= 0.4 || ratio >= 0.7) return "medium";
  return "low";
}

const EARTH_RADIUS_METERS = 6371000;

function haversineMeters(latA: number, lngA: number, latB: number, lngB: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLng = toRad(lngB - lngA);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type PharmacyMatchMember = {
  pharmacyId: string;
  pharmacyCode: string;
  displayName: string;
  distributorId: number;
  distributorCode: string;
  distributorName: string;
  distributorPharmacyCode: string;
  areaName: string | null;
  regionName: string | null;
  governorateName: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type PharmacyMatchCandidateGroup = {
  groupKey: string;
  members: [PharmacyMatchMember, PharmacyMatchMember];
  confidence: PharmacyMatchConfidence;
  matchReason: PharmacyMatchReason;
  score: number;
  warning: string | null;
};

const GPS_MATCH_RADIUS_METERS = 50;

export const PHARMACY_MATCH_WARNING: Record<Exclude<PharmacyMatchConfidence, "high">, string> = {
  low: "Weak match — only shown because it may still be useful; verify carefully before treating this as the same pharmacy.",
  medium: "Moderate similarity — needs human review; common names can produce false positives.",
};

/** Compare exactly one pair. Returns `null` when they're not a candidate at all — including
 *  always when both members share the same distributor (never compare within one distributor). */
export function comparePharmacyPair(a: PharmacyMatchMember, b: PharmacyMatchMember): PharmacyMatchCandidateGroup | null {
  if (a.distributorId === b.distributorId) return null;

  const groupKey = [a.pharmacyId, b.pharmacyId].sort().join("|");

  // 1) Exact key: GPS proximity (within ~50m) or an identical normalized address. Strongest
  //    possible signal — but real coverage today is ~0.3%, so this rarely fires yet.
  if (a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null) {
    if (haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude) <= GPS_MATCH_RADIUS_METERS) {
      return { confidence: "high", groupKey, matchReason: "exact_key", members: [a, b], score: 1, warning: null };
    }
  }
  const normalizedAddressA = normalizeArabicPharmacyName(a.address);
  const normalizedAddressB = normalizeArabicPharmacyName(b.address);
  if (normalizedAddressA && normalizedAddressB && normalizedAddressA === normalizedAddressB) {
    return { confidence: "high", groupKey, matchReason: "exact_key", members: [a, b], score: 1, warning: null };
  }

  // 2) Name-based fuzzy signal — the only signal available at today's data coverage.
  const tokensA = nameTokens(a.displayName);
  const tokensB = nameTokens(b.displayName);
  const jaccard = jaccardSimilarity(tokensA, tokensB);
  const normalizedNameA = removeStopWords(normalizeArabicPharmacyName(a.displayName));
  const normalizedNameB = removeStopWords(normalizeArabicPharmacyName(b.displayName));
  const ratio = diceCoefficient(normalizedNameA, normalizedNameB);
  const confidence = resolvePharmacyMatchConfidence(jaccard, ratio);
  if (!confidence) return null;

  const matchReason: PharmacyMatchReason = jaccard > 0 ? "token_overlap" : "normalized_name_similarity";
  const score = Math.max(jaccard, ratio);
  const warning = confidence === "high" ? null : PHARMACY_MATCH_WARNING[confidence];
  return { confidence, groupKey, matchReason, members: [a, b], score: Math.round(score * 1000) / 1000, warning };
}

/** All candidate groups across the given pharmacy set, sorted strongest-first. O(n²)
 *  comparisons — trivial at today's scale (287 pharmacies ≈ 41k pairs). */
export function findPharmacyMatchCandidates(members: PharmacyMatchMember[]): PharmacyMatchCandidateGroup[] {
  const groups: PharmacyMatchCandidateGroup[] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const group = comparePharmacyPair(members[i], members[j]);
      if (group) groups.push(group);
    }
  }
  return groups.sort((a, b) => b.score - a.score);
}
