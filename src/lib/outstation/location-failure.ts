/**
 * WHY a departure photo carries no GPS position, recorded with the photo.
 *
 * Owner, 2026-09-18, on Saad Salama's 1 September departure photo: "the system must record the
 * reason". The photo was saved with no position and nothing said why. Both capture paths already
 * knew: the browser hands back a coded error, and the Android app knew whether location was
 * refused, switched off or too slow (it even told the employee "your approver will see that").
 * Neither sent it, so the approver saw "Location unavailable" and nothing more.
 *
 * A departure photo with no fix is still accepted (owner decision: flag, never refuse), so the
 * reason is the only account of the gap. It is stored in the photo's metadata and shown to the
 * approver in words. The codes are sent by the web card and by the Android app, which cannot
 * import this file; `tests/outstation-departure-gps-reason.test.ts` pins every code the app sends
 * to the list below.
 *
 * Pure and import-free on purpose: the web capture card and the approver screens are client code.
 */

export const LOCATION_FAILURE_REASONS = [
  "permission_denied",
  "location_off",
  "timeout",
  "position_unavailable",
  "unsupported",
  "not_reported",
] as const;

export type LocationFailureReason = (typeof LOCATION_FAILURE_REASONS)[number];

export type LocationFailure = {
  reason: LocationFailureReason;
  /** The device's own words for the failure, when it gave any, e.g. "User denied Geolocation". */
  detail: string | null;
};

/** Longest device message kept. Browser and Android messages are a few words; this is a cap, not a budget. */
export const LOCATION_FAILURE_DETAIL_MAX_LENGTH = 200;

const REASON_WORDS: Record<LocationFailureReason, string> = {
  permission_denied: "Location access was refused on the phone, so Phoenix could not read where it was.",
  location_off: "Location was switched off on the phone.",
  timeout: "The phone did not find its position within the 12 seconds allowed.",
  position_unavailable:
    "The phone tried but could not work out its position. Location may be switched off, or there was no signal.",
  unsupported: "The browser used cannot report a location.",
  not_reported:
    "No reason was recorded. The photo was taken before Phoenix kept one, or on an older version of the app.",
};

export function isLocationFailureReason(value: unknown): value is LocationFailureReason {
  return typeof value === "string" && (LOCATION_FAILURE_REASONS as readonly string[]).includes(value);
}

/** The reason in plain words, for the approver. */
export function describeLocationFailure(reason: LocationFailureReason): string {
  return REASON_WORDS[reason];
}

/**
 * A browser `GeolocationPositionError.code` as a reason: 1 is PERMISSION_DENIED, 2 is
 * POSITION_UNAVAILABLE, 3 is TIMEOUT. Anything else is still a failure to find the position.
 */
export function locationFailureFromBrowserErrorCode(code: unknown): LocationFailureReason {
  if (code === 1) return "permission_denied";
  if (code === 3) return "timeout";
  return "position_unavailable";
}

function readDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters out, whitespace collapsed: this is shown to a person and stored as JSON.
  const printable = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
  const cleaned = printable.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, LOCATION_FAILURE_DETAIL_MAX_LENGTH) : null;
}

/**
 * The reason a request body gives for having no position. Null when a position WAS captured, so a
 * photo with a fix never carries a stale reason. A body with no position and no recognised reason
 * (an older app, an unknown code) records `not_reported` rather than nothing: the gap is always
 * accounted for, and an unknown code is never stored as if it meant something.
 */
export function readLocationFailure(
  body: { locationFailure?: unknown; locationFailureDetail?: unknown },
  hasPosition: boolean,
): LocationFailure | null {
  if (hasPosition) return null;
  const sent = body.locationFailure;
  return { detail: readDetail(body.locationFailureDetail), reason: isLocationFailureReason(sent) ? sent : "not_reported" };
}

/**
 * The stored reason read back from photo metadata. Null when the photo has a position. A photo
 * with no position and no stored reason (every one taken before 2026-09-18) reads `not_reported`.
 */
export function storedLocationFailure(meta: {
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  locationFailure?: { detail?: unknown; reason?: unknown } | null;
}): LocationFailure | null {
  const hasPosition =
    typeof meta.capturedLatitude === "number" &&
    Number.isFinite(meta.capturedLatitude) &&
    typeof meta.capturedLongitude === "number" &&
    Number.isFinite(meta.capturedLongitude) &&
    // The exact pair 0,0 is the old failed-fix marker, never a place (captured-coordinates.ts).
    !(meta.capturedLatitude === 0 && meta.capturedLongitude === 0);
  if (hasPosition) return null;
  const stored = meta.locationFailure;
  const reason = stored?.reason;
  return {
    detail: readDetail(stored?.detail),
    reason: isLocationFailureReason(reason) ? reason : "not_reported",
  };
}
