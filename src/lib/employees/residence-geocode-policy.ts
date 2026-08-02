// Residence geocoding policy — the two decisions that made an employee save destroy data.
//
// Extracted from upsertEmployeeResidenceLocation so they can be asserted without a Supabase
// client or a live geocoder. Deliberately dependency-free: importing employee-directory.ts pulls
// in the Supabase admin client, which throws without a service-role key.
//
// Both rules exist because of the 2026-08-01 Maps billing failure. Geocoding began answering
// HTTP 200 with REQUEST_DENIED, which the caller reads as "no result found" rather than as an
// error — so the failure was completely silent.

export type GeocodedPoint = { lat: number; lng: number };

type ResidenceFields = {
  residenceAddress?: string | null;
  residenceArea?: string | null;
  residenceCity?: string | null;
};

/**
 * True when a mutation says nothing about the residence, so the geocode must not re-run.
 *
 * The original guard tested `=== undefined`. The Employee Management form always sends these
 * three as `null`, so it never fired: every save of ANY field — salary, job title, manager,
 * insurance — re-geocoded and rewrote the row. `null` and `undefined` both mean "unchanged"
 * here; only a present string is a change.
 */
export function residenceUnchanged(input: ResidenceFields): boolean {
  return (
    input.residenceAddress == null
    && input.residenceArea == null
    && input.residenceCity == null
  );
}

/**
 * The address to geocode, or null when there is nothing worth looking up.
 *
 * Guards the PARTS, not the joined string. The original joined `[...parts, "Egypt"]` and tested
 * the result for truthiness — with all three parts empty that is the string "Egypt", which
 * geocodes *successfully* to the country centroid and was then stored as the employee's home
 * address: a plausible-looking coordinate that is wrong for every employee it touched.
 */
export function residenceGeocodeQuery(parts: Array<string | null | undefined>): string | null {
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length === 0) return null;
  return [...present, "Egypt"].join(", ");
}

/**
 * The coordinate columns to include in the residence upsert.
 *
 * Returns an EMPTY object when the geocode produced nothing, so the columns are omitted from the
 * PostgREST payload entirely. This is the load-bearing part: the upsert runs under
 * `Prefer: resolution=merge-duplicates`, where sending `residence_latitude: null` OVERWRITES a
 * good stored coordinate. A failed lookup is not evidence that the employee moved — it is
 * usually a dead API key — and nothing in the system can re-derive a coordinate once lost.
 */
export function residenceCoordinateColumns(
  geocoded: GeocodedPoint | null,
): { residence_latitude: number; residence_longitude: number } | Record<string, never> {
  if (!geocoded) return {};
  return { residence_latitude: geocoded.lat, residence_longitude: geocoded.lng };
}
