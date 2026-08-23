/**
 * How the request form names the venue it is targeting.
 *
 * Attribution used to be keyed on the distributor code id alone, which worked only because every
 * venue had one. A nursery has none, and two codeless nurseries would collapse into the same
 * option, so the picker needs an identity that exists for every venue.
 *
 * For a pharmacy that identity IS the distributor code id, unchanged and unprefixed — deliberately,
 * so a draft saved before this existed submits exactly the string it always did and still resolves.
 * Only a codeless venue gets the prefix.
 */
const NURSERY_TARGET_PREFIX = "venue:";

export type DecodedVenueTarget =
  | { distributorCodeId: string; pharmacyId: null }
  | { distributorCodeId: null; pharmacyId: string };

export function encodeVenueTarget(params: {
  distributorCodeId: string | null;
  pharmacyId: string;
}): string {
  return params.distributorCodeId ?? `${NURSERY_TARGET_PREFIX}${params.pharmacyId}`;
}

/** Returns null for anything that names neither — an empty string, or a bare prefix. */
export function decodeVenueTarget(value: unknown): DecodedVenueTarget | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (!text.startsWith(NURSERY_TARGET_PREFIX)) {
    return { distributorCodeId: text, pharmacyId: null };
  }
  const pharmacyId = text.slice(NURSERY_TARGET_PREFIX.length).trim();
  return pharmacyId ? { distributorCodeId: null, pharmacyId } : null;
}
