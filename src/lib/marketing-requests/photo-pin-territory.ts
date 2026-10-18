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
 * The master database's own answer (`source === "master_code"`) is left exactly as it was: whether a
 * registered distributor code outranks the photo is still an open ruling, so this changes nothing for
 * a venue whose code resolved. A pin whose nearest brick centre is more than
 * `PHOTO_TERRITORY_TRUST_KM` away names no territory (brick centres are geocoded guesses), and then
 * the previous behaviour stands.
 *
 * Pure on purpose — no database, no network — so the rule can be pinned and break-tested alone.
 */
export function applyPhotoPinTerritory(
  base: PinnedGeography,
  pin: ResolvedBrickPoint | null,
): { geography: PinnedGeography; pinBrick: { brickId: string; brickName: string | null; distanceKm: number } | null } {
  if (base.source === "master_code") return { geography: base, pinBrick: null };
  if (!pin || !pin.brickId || !pin.areaCode || pin.distanceKm > PHOTO_TERRITORY_TRUST_KM) {
    return { geography: base, pinBrick: null };
  }
  return {
    geography: {
      areaCode: pin.areaCode,
      brickId: pin.brickId,
      regionCode: pin.regionCode ?? base.regionCode,
      source: "photo_pin",
    },
    pinBrick: { brickId: pin.brickId, brickName: pin.brickName, distanceKm: Math.round(pin.distanceKm * 10) / 10 },
  };
}
