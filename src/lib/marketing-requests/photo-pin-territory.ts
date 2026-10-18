import type { ResolvedBrickPoint } from "@/lib/crm/brick-geo";
import { PHOTO_TERRITORY_TRUST_KM } from "@/lib/direct-orders/geography-check";

/** Where a transferred venue's area, region and brick came from — the page labels a guess as a guess. */
export type PinnedGeography = {
  areaCode: string | null;
  regionCode: string | null;
  brickId: string | null;
  source: "master_code" | "photo_pin" | "marketing_area" | "none";
};

/**
 * THE EVIDENCE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18), so a venue with no master
 * answer is filed where its photo's pin actually falls — never in the area an inherited marketing
 * label names. Measured the same day: حضانه عبد الكريم was filed under Menoufia 1 from the legacy
 * `delta_1` label and a nearest-centre guess confined to that area (6.9 km off), while its photo was
 * taken 0.7 km from منوف in Menoufia 2.
 *
 * THE PHOTO OUTRANKS THE REGISTERED DISTRIBUTOR CODE TOO (owner, 2026-10-18: "the photo wins everywhere,
 * including where a distributor code exists" — settling the older "registered code beats live GPS"
 * tension for this filing). So a venue whose code resolved to a different territory is still filed
 * where its photo's pin falls, and `overrode` names the master's answer it replaced so the reason on
 * the request can say so. A pin whose nearest brick centre is more than `PHOTO_TERRITORY_TRUST_KM`
 * away names no territory (brick centres are geocoded guesses), and then the previous behaviour
 * stands — master answer or inherited label alike.
 *
 * Pure on purpose — no database, no network — so the rule can be pinned and break-tested alone.
 */
export function applyPhotoPinTerritory(
  base: PinnedGeography,
  pin: ResolvedBrickPoint | null,
): {
  geography: PinnedGeography;
  pinBrick: { brickId: string; brickName: string | null; distanceKm: number } | null;
  /** The master-code territory the photo replaced; null when there was none or the photo agreed with it. */
  overrode: PinnedGeography | null;
} {
  if (!pin || !pin.brickId || !pin.areaCode || pin.distanceKm > PHOTO_TERRITORY_TRUST_KM) {
    return { geography: base, pinBrick: null, overrode: null };
  }
  const disagrees =
    base.source === "master_code" && (base.areaCode !== pin.areaCode || (base.brickId !== null && base.brickId !== pin.brickId));
  return {
    geography: {
      areaCode: pin.areaCode,
      brickId: pin.brickId,
      regionCode: pin.regionCode ?? base.regionCode,
      source: "photo_pin",
    },
    pinBrick: { brickId: pin.brickId, brickName: pin.brickName, distanceKm: Math.round(pin.distanceKm * 10) / 10 },
    overrode: disagrees ? base : null,
  };
}
