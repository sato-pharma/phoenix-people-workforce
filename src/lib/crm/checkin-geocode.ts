/**
 * Reverse geocoding door for CRM check-in addresses ONLY. Tries LocationIQ (free tier) first,
 * accepting its result only when it's precise enough (see LOCATIONIQ_CONFIDENCE_THRESHOLD) —
 * otherwise falls back to Google (already configured/paid for elsewhere — outstation,
 * marketing-requests, Routes/Directions). Accuracy over cost: a cheap-but-vague address ("Cairo
 * Governorate, Egypt") is worse than a Google call, so a low-confidence LocationIQ hit is treated
 * the same as a miss.
 *
 * Deliberately isolated from src/lib/google-maps/server.ts: outstation, marketing-requests, and
 * Routes/Directions distance calculations keep calling googleReverseGeocode/googleDirectionsRoute
 * directly and are untouched by this module. Only scripts/backfill-checkin-addresses.ts goes through
 * this door (the retired iReports360 sync's backfillMissingCheckinAddresses was the other caller).
 */

import { googleReverseGeocode } from "@/lib/google-maps/server";
import {
  hasLocationIqKey,
  locationIqReverseGeocode,
  LOCATIONIQ_CONFIDENCE_THRESHOLD,
  scoreReverseConfidence,
} from "@/lib/geocoding/locationiq";

export { hasLocationIqKey };

async function googleReverseGeocodeLabel(lat: number, lon: number): Promise<string | null> {
  const result = await googleReverseGeocode({ lat, lng: lon });
  const label = result?.formattedAddress ?? [result?.area, result?.city].filter(Boolean).join(", ");
  return label || null;
}

/**
 * Resolves a human-readable address for a check-in's coordinates: LocationIQ first (free) when
 * its match is precise enough, then Google as a fallback for whatever LocationIQ's coverage
 * misses or only resolves vaguely. Best-effort, matching the caller's existing posture — never
 * throws; a total failure on both providers just leaves the check-in without an address.
 */
export async function resolveCheckinAddress(lat: number, lon: number): Promise<string | null> {
  const locationIqResult = await locationIqReverseGeocode(lat, lon);
  if (scoreReverseConfidence(locationIqResult) >= LOCATIONIQ_CONFIDENCE_THRESHOLD) {
    const label = locationIqResult?.display_name?.trim();
    if (label) return label;
  }

  try {
    return await googleReverseGeocodeLabel(lat, lon);
  } catch {
    return null;
  }
}
