import type { GeoSignals } from "@/lib/sales/normalizer/geo-validate";

// The auto-accept gate for god-mode customer mapping. DELIBERATELY conservative: a suggestion
// auto-applies only when its confidence clears the threshold AND at least two independent
// signals agree — a single-signal 95 never auto-applies. Loosening this later is a one-line
// change; tightening it after bad mappings entered the crosswalk is an incident.

export type AutoApplyCandidate = {
  confidence?: number;
  source?: "ai" | "propagated";
  signals?: GeoSignals;
};

const DEFAULT_MIN = 95;

export function autoAcceptMin(env: string | undefined = process.env.SOS_AUTO_ACCEPT_MIN): number {
  const parsed = Number(env);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN;
  return Math.min(100, Math.max(90, Math.round(value)));
}

export function shouldAutoAccept(candidate: AutoApplyCandidate, min: number = autoAcceptMin()): boolean {
  const confidence = candidate.confidence;
  if (typeof confidence !== "number" || confidence < min) return false;
  const signals = candidate.signals;
  if (!signals || !signals.geocoded) return false;
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
