// When a car trip's fuel cannot be priced.
//
// Fuel is distance x 2 x rate, and the distance comes from the Google Routes API. When that
// lookup fails the distance is null, which the calculation coerces to 0 -- producing a
// real-looking 0.00 EGP fuel line that an approver can wave through, paying a rep nothing for a
// real drive. On 2026-08-01 the Routes key lost billing and every car claim silently costed at
// zero.
//
// Extracted from submitOutstationRequest so the condition can be asserted without an
// AccessContext or a database.

export const UNPRICEABLE_CAR_TRIP_MESSAGE =
  "The distance from your residence could not be measured, so the fuel amount cannot be calculated. "
  + "Please try again in a few minutes, and contact HR if it keeps failing — do not submit a car trip "
  + "with a zero fuel amount.";

/**
 * True when a submission must be refused because its fuel cost is unknowable.
 *
 * Two distinctions this deliberately preserves:
 *
 *   - `0` is a MEASURED answer, not a missing one. A trip that genuinely resolves to zero
 *     distance is priceable and must still submit; only `null`/`undefined` means the lookup
 *     failed. Collapsing the two is the original bug in the opposite direction.
 *   - Only `car` needs a distance. Train and bus claims are priced from ticket amounts the
 *     employee enters, so a dead geocoder must not block them.
 */
export function carTripFuelIsUnpriceable(
  transportationType: string | null | undefined,
  distanceFromResidenceKm: number | null | undefined,
): boolean {
  if (transportationType !== "car") return false;
  return distanceFromResidenceKm == null;
}
