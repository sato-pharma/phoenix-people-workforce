/**
 * The location block burned into every Phoenix evidence photo, in one place.
 *
 * Until 2026-08-23 the three capture surfaces each wrote their own caption, and two of them wrote
 * the place as nothing but a coordinate pair — `GPS: 30.059482, 31.223145`. An approver reading
 * that photo weeks later cannot tell whether the rep stood in front of the right pharmacy: a
 * number pair is a fact about the earth, not a fact about the business. Owner instruction
 * (2026-08-23): the captured location must read as a full ADDRESS, and must name the Phoenix
 * BRICK, AREA and REGION the pin falls in.
 *
 * This module owns the wording and ONLY the wording. It is pure — no database, no network, no
 * React — so the API route that resolves a stamp and the browser canvas that burns it into the
 * JPEG emit byte-identical text. Two photos whose captions were built by two different code paths
 * are exactly the thing that drifts, which is why `evidence-watermark.ts` was extracted in the
 * first place.
 *
 * Nothing here ever invents a place. When Google cannot resolve an address, or when no Phoenix
 * brick is near enough to stand behind, the line says so in words — a stamp that quietly omits a
 * failed lookup reads as "there was no address", and a stamp that prints a 40 km-away brick as
 * fact is worse than one that prints nothing.
 */

/** Everything known about where one evidence photo was taken. */
export type EvidenceLocationStamp = {
  /** GPS accuracy radius reported by the device, in metres. Null when the device withheld it. */
  accuracyMeters: number | null;
  /** Google's full formatted address for the pin. Null when the lookup failed or returned nothing. */
  address: string | null;
  areaName: string | null;
  /**
   * Great-circle distance from the pin to the matched brick's CENTRE, in km. Null when nothing
   * matched. This is what separates "the rep is standing in Mohandessin" from "the nearest brick
   * centre we know of happens to be Mohandessin, 40 km away" — see the qualifier below.
   */
  brickDistanceKm: number | null;
  brickName: string | null;
  latitude: number;
  longitude: number;
  regionName: string | null;
};

/**
 * Beyond this distance the nearest brick centroid is a neighbouring locality's, not the pin's own,
 * so the territory is printed WITH the distance rather than as plain fact.
 *
 * Deliberately the same 10 km as `REVIEW_KM` in `src/lib/crm/brick-geo.ts`, restated here rather
 * than imported: that module pulls in `next/cache` and the Supabase admin client, and this one has
 * to stay importable from a browser canvas. If one moves, move the other.
 */
export const EVIDENCE_BRICK_CONFIDENT_KM = 10;

/** What the stamp says when the address lookup gave nothing back. */
export const EVIDENCE_ADDRESS_UNRESOLVED = "could not be resolved";

/** What the territory line says when no brick centre is known near the pin at all. */
export const EVIDENCE_TERRITORY_UNMATCHED = "Territory: no Phoenix brick matched this location";

/** The separator between Brick / Area / Region. Spaced so it reads as three fields, not one. */
const FIELD_SEPARATOR = "  ·  ";

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A coordinate pair written the way a person reads one: six decimals (about 11 cm — finer than any
 * phone GPS) with an explicit hemisphere, so a negative sign can never be mistaken for a typo.
 */
export function formatCoordinatePair(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "unavailable";
  const lat = `${Math.abs(latitude).toFixed(6)}°${latitude < 0 ? "S" : "N"}`;
  const lng = `${Math.abs(longitude).toFixed(6)}°${longitude < 0 ? "W" : "E"}`;
  return `${lat}, ${lng}`;
}

/** `Address: 12 Ahmed Orabi Street, Mohandessin, Giza Governorate` */
export function formatEvidenceAddressLine(stamp: EvidenceLocationStamp): string {
  return `Address: ${clean(stamp.address) ?? EVIDENCE_ADDRESS_UNRESOLVED}`;
}

/**
 * `Brick: Mohandessin  ·  Area: Giza  ·  Region: Cairo`
 *
 * A brick further than {@link EVIDENCE_BRICK_CONFIDENT_KM} from the pin carries its distance, so a
 * nonsense match reads as the nonsense it is. Names only, never brick ids — the owner's standing
 * rule is human-readable names everywhere, and a code on an evidence photo helps nobody.
 */
export function formatEvidenceTerritoryLine(stamp: EvidenceLocationStamp): string {
  const brick = clean(stamp.brickName);
  const area = clean(stamp.areaName);
  const region = clean(stamp.regionName);
  if (!brick && !area && !region) return EVIDENCE_TERRITORY_UNMATCHED;

  const isApproximate =
    stamp.brickDistanceKm != null &&
    Number.isFinite(stamp.brickDistanceKm) &&
    stamp.brickDistanceKm > EVIDENCE_BRICK_CONFIDENT_KM;
  const qualifier = isApproximate
    ? ` (nearest, ${Math.round(Number(stamp.brickDistanceKm))} km away)`
    : "";

  const parts: string[] = [];
  if (brick) parts.push(`Brick: ${brick}${qualifier}`);
  if (area) parts.push(`Area: ${area}`);
  if (region) parts.push(`Region: ${region}`);
  return parts.join(FIELD_SEPARATOR);
}

/**
 * `GPS: 30.059482°N, 31.223145°E  ·  accuracy ±12 m`
 *
 * The coordinates STAY on the photo — they are the forensic part of the evidence and the only
 * thing that can be re-checked years later. What changed is that they are now the fine print under
 * a readable address, instead of being the whole answer.
 */
export function formatEvidenceCoordinateLine(stamp: EvidenceLocationStamp): string {
  const accuracy =
    stamp.accuracyMeters != null && Number.isFinite(stamp.accuracyMeters)
      ? `${FIELD_SEPARATOR}accuracy ±${Math.round(Number(stamp.accuracyMeters))} m`
      : "";
  return `GPS: ${formatCoordinatePair(stamp.latitude, stamp.longitude)}${accuracy}`;
}

/**
 * The three lines burned into the photo, in reading order: what the place is called, whose
 * territory it is, and the raw pin that proves both.
 */
export function formatEvidenceLocationLines(stamp: EvidenceLocationStamp): string[] {
  return [
    formatEvidenceAddressLine(stamp),
    formatEvidenceTerritoryLine(stamp),
    formatEvidenceCoordinateLine(stamp),
  ];
}

/**
 * The same information on ONE line, for the `capturedLocationLabel` column and the approver
 * screens that read it back. Kept separate from the photo lines on purpose: the stamp has a whole
 * panel to breathe in, a stored label has to survive being read in a detail row.
 */
export function formatEvidenceLocationLabel(stamp: EvidenceLocationStamp): string {
  const parts: string[] = [];
  const address = clean(stamp.address);
  if (address) parts.push(address);

  const brick = clean(stamp.brickName);
  const area = clean(stamp.areaName);
  const region = clean(stamp.regionName);
  if (brick) parts.push(`Brick ${brick}`);
  if (area) parts.push(`Area ${area}`);
  if (region) parts.push(`Region ${region}`);

  if (parts.length === 0) {
    // Never "Location unavailable" with nothing behind it: the pin is always known by the time a
    // stamp is built, so say where it was even when every lookup failed.
    return `Unresolved location at ${formatCoordinatePair(stamp.latitude, stamp.longitude)}`;
  }
  return parts.join(" · ");
}
