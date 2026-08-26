import type { GeoSignals } from "@/lib/sales/normalizer/geo-validate";

// The auto-accept gate for god-mode customer mapping. DELIBERATELY conservative: a suggestion
// auto-applies only when its confidence clears the threshold AND at least two independent
// signals agree — a single-signal 95 never auto-applies. Loosening this later is a one-line
// change; tightening it after bad mappings entered the crosswalk is an incident.
//
// There are two ways through, and BOTH still demand two independent signals:
//
//   1. GEOGRAPHIC — confidence, plus a geocoded pharmacy near the brick centroid. Unchanged.
//   2. TEXTUAL — deterministic cross-distributor propagation whose name identity is corroborated
//      by address text, accepted only when geography is UNAVAILABLE.
//
// Path 2 was added 2026-08-27 because path 1 is unreachable for almost every customer. Measured
// on production that day: 1,953 of 66,109 mapped customers had a geocode — 3.0%. For the other
// 97% `signals.geocoded` is false, so no suggestion could EVER auto-apply however obvious the
// answer was. That is how 14,345 customer codes accumulated unmapped and had to be backfilled by
// hand. Geography is also a weak arbiter here even when it is present: Phoenix bricks are sales
// territories, not map polygons, and the nearest brick centroid is the true brick only 39.7% of
// the time (measured on held-out codes the same day; 180 of the stored centroids are borrowed
// `shared_fallback` values and 13 are outright region mismatches).
//
// Path 2 cannot fire against a geocode that DISAGREES. When geography is available and
// contradicts the suggestion, customer-suggest.ts has already demoted the propagated confidence
// to 45, which fails both thresholds below. Path 2 only ever runs where path 1 had no opinion.

export type PropagationEvidence = {
  // True when propagateSuggestions matched an unambiguous multi-token name (a name resolving to
  // more than one brick is suppressed outright) AND the address tokens agreed at >= 0.5 overlap.
  // Those are two independent textual signals, which is what earns a geography-free accept.
  addressCorroborated: boolean;
};

export type AutoApplyCandidate = {
  confidence?: number;
  source?: "ai" | "propagated";
  signals?: GeoSignals;
  propagation?: PropagationEvidence;
};

const DEFAULT_MIN = 95;
// Deterministic propagation tops out at 93 (customer-propagate.ts: 90 base, 93 once address
// overlap clears 0.5), so the textual path needs its own floor — unaided it can never reach 95.
const DEFAULT_TEXT_MIN = 93;

export function autoAcceptMin(env: string | undefined = process.env.SOS_AUTO_ACCEPT_MIN): number {
  const parsed = Number(env);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN;
  return Math.min(100, Math.max(90, Math.round(value)));
}

export function autoAcceptTextMin(env: string | undefined = process.env.SOS_AUTO_ACCEPT_TEXT_MIN): number {
  const parsed = Number(env);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TEXT_MIN;
  return Math.min(100, Math.max(90, Math.round(value)));
}

export function shouldAutoAccept(
  candidate: AutoApplyCandidate,
  min: number = autoAcceptMin(),
  textMin: number = autoAcceptTextMin(),
): boolean {
  const confidence = candidate.confidence;
  if (typeof confidence !== "number") return false;
  const signals = candidate.signals;

  // Path 2 — textual. Reached only when there is no usable geocode to judge against.
  if (!signals || !signals.geocoded) {
    return candidate.source === "propagated"
      && candidate.propagation?.addressCorroborated === true
      && confidence >= textMin;
  }

  // Path 1 — geographic.
  if (confidence < min) return false;
  if (candidate.source === "propagated") {
    // Deterministic twin + geographic corroboration.
    return (signals.distanceKm != null && signals.distanceKm < 15) || signals.markazMatch;
  }
  if (candidate.source === "ai") {
    // AI alone needs the strongest geographic proof: pharmacy within 5 km of the brick centroid.
    return signals.distanceKm != null && signals.distanceKm < 5;
  }
  return false;
}

export type AutoApplyPartition<T extends AutoApplyCandidate> = { accepted: T[]; parked: T[] };

export function partitionAutoApply<T extends AutoApplyCandidate>(candidates: T[], min: number = autoAcceptMin()): AutoApplyPartition<T> {
  const accepted: T[] = [];
  const parked: T[] = [];
  for (const candidate of candidates) {
    if (shouldAutoAccept(candidate, min)) accepted.push(candidate);
    else parked.push(candidate);
  }
  return { accepted, parked };
}
