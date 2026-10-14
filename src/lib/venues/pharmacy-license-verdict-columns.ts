import { hrIdForStorage } from "@/lib/hr-id";

// The two pure halves of "does the trade name on the licence match the name on the shop sign?".
//
// They live HERE, not beside the marketing approver's recorder, because two screens write the same
// three columns on `marketing_pharmacies` - the approver's detail view (marketing requests) and the
// Approve button on Customer Pharmacy Mapping (a licence-only pharmacy is released by a person who
// has just read the licence). One writer for the shape means the database CHECK can only ever be
// hit by a bug in this file, not by a second caller forgetting a field.

/**
 * Normalise whatever arrived over the wire into the three-valued answer.
 *
 * ONLY an explicit `true` or `false` is an answer. Everything else - undefined, a missing key, a
 * string "true", a number - clears back to "nobody was asked". A verdict accuses a real pharmacy of
 * carrying a name that does not match its licence, so it must never be arrived at by coercion.
 */
export function parseLicenseVerdict(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * The three columns, always moving together.
 *
 * `marketing_pharmacies_license_verdict_check` refuses any other shape: a verdict with no author,
 * or an author and a timestamp stranded beside a cleared verdict. Building the patch in one place
 * means the constraint can only ever be hit by a bug in this function, rather than by any of the
 * call sites forgetting one field.
 */
export function licenseVerdictColumns(input: {
  actorHrId: string | null;
  matchesSign: boolean | null;
  now: string;
}): {
  license_name_checked_at: string | null;
  license_name_checked_by_hr_id: string | null;
  license_name_matches_sign: boolean | null;
} {
  if (input.matchesSign === null) {
    return {
      license_name_checked_at: null,
      license_name_checked_by_hr_id: null,
      license_name_matches_sign: null,
    };
  }
  return {
    license_name_checked_at: input.now,
    license_name_checked_by_hr_id: hrIdForStorage(input.actorHrId),
    license_name_matches_sign: input.matchesSign,
  };
}
