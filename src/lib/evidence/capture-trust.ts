/**
 * What makes a live capture trustworthy: the PHOTO and the PHOTO'S OWN LOCATION, together.
 *
 * ─── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * Every live-capture camera in Phoenix used to take ONE GPS reading — when the rep pressed
 * *Capture Location* — and then stamp that same stored reading onto the photo when the shutter
 * fired. The evidence row's `captured_latitude/longitude` were therefore a COPY of the venue row's,
 * byte for byte, and the distance between them was structurally zero. The columns implied a
 * comparison that was never being performed.
 *
 * Measured on production 2026-09-29 (marketing capture `MKT-PHA-20260929-9A9A45F5`, Nashwah,
 * Zagazig): the location fix was taken at 17:10:09 Cairo and the shutter fired at 17:28:40 — a gap
 * of **18 minutes 31 seconds** — yet both rows carried latitude 30.4954306, longitude 31.4770646
 * and accuracy 43.8289985656738 identically to thirteen decimal places. Two independent GPS reads
 * never agree to thirteen decimals; that identity was the tell. Nothing in Phoenix could say
 * whether the camera had stayed put, for that capture or any other, and a coordinate on its own was
 * never proof of anything.
 *
 * The owner's ruling, 2026-09-29: *"lazm el gps b location w el live b location tany w n compare"*
 * — the location fix and the live photo each carry their own position, and we compare them; and
 * *"the photo + the location of photo is the more trustable"*.
 *
 * ─── WHAT A NULL MEANS HERE, AND IT IS LOAD-BEARING ───────────────────────────
 *
 * A missing photo fix is **NOT MEASURED**. It is never "the same place". The shutter never blocks
 * on a second reading — a rep in a shop doorway with a weak signal keeps working — so nulls are
 * normal and expected, and `assessCaptureTrust` returns `"unmeasured"` for them rather than any
 * flavour of agreement. No caller may read a null as corroboration. Substituting the location fix
 * when the photo fix is absent is precisely the bug this module exists to end, and it must never be
 * reintroduced anywhere in the write path.
 *
 * ─── WHO MAY SEE THE VERDICT ──────────────────────────────────────────────────
 *
 * This is an INTEGRITY signal, so AGENTS.md §4 Phoenix CRM golden rule #1 governs it: it is
 * recorded, and it is readable by the **Super Admin and the SFE Manager only**. The person who took
 * the photo is never shown a verdict, never warned, never refused and never given any wording that
 * a check exists — a message teaches the one person you caught what to defeat. A verdict is where
 * to look, never an accusation and never an action.
 *
 * Thresholds are deliberately loose for the same reason the CRM's are: a false positive accuses a
 * real person of fraud, which is worse than a missed catch. They are set so that an honest capture
 * cannot trip them even on a bad handset — see `CAPTURE_DRIFT_*` below.
 *
 * Pure arithmetic, no I/O, no Supabase, no `navigator` — safe to import from a server route, a
 * `"use client"` component and a test alike.
 */

/** One GPS reading. Every field is optional because a handset may supply none of them. */
export type CaptureFix = {
  /** Reported horizontal accuracy in metres; null when the browser did not give one. */
  accuracyMeters?: number | null;
  /** ISO-8601. The moment this particular reading was taken, not when the row was saved. */
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

/**
 * How far apart two fixes may be before the pair stops corroborating each other.
 *
 * 250 m, and generous on purpose. The two readings are seconds-to-minutes apart and each carries
 * its own error: an indoor or urban-canyon fix routinely reports 40-80 m of accuracy here (the
 * 2026-09-29 pharmacy capture reported 43.8 m), two such readings can legitimately sit ~150 m
 * apart, and a rep who steps out of a shop to get signal moves further still. Below this, say
 * nothing.
 */
export const CAPTURE_DRIFT_AGREE_METRES = 250;

/**
 * Beyond this the two readings are not describing one place. 2 km is far past any doorway, any
 * signal walk and any accuracy cone — at this distance the camera and the location fix were in
 * different parts of a city.
 */
export const CAPTURE_DRIFT_DISAGREE_METRES = 2000;

/**
 * How long the location fix may precede the shutter before the pair stops being one visit.
 *
 * 10 minutes. The 2026-09-29 capture sat at 18m31s, which is what made it unanswerable. This is a
 * flag on the GAP alone and never on its own a finding: a rep can legitimately locate, be kept
 * waiting by a doctor, and photograph the shop afterwards.
 */
export const CAPTURE_GAP_FLAG_SECONDS = 600;

export type CaptureTrustVerdict =
  /** No photo fix was recorded. Says nothing either way — never read as agreement. */
  | "unmeasured"
  /** Both fixes present and consistent: the photo corroborates the location. */
  | "agrees"
  /** Present but further apart than one place should be. Worth a human look, not a verdict. */
  | "drifted"
  /** Present and irreconcilable — different places entirely. */
  | "disagrees";

export type CaptureTrustAssessment = {
  /** Metres between the two fixes; null when either fix has no coordinates. */
  distanceMeters: number | null;
  /** Seconds from the location fix to the shutter; null when either timestamp is missing. */
  gapSeconds: number | null;
  /** True when the gap exceeds {@link CAPTURE_GAP_FLAG_SECONDS}. False when it is unknown. */
  gapIsLong: boolean;
  /**
   * True only when the photo carried its OWN coordinates. False means the pair could not be
   * compared — never that it was compared and agreed.
   */
  measured: boolean;
  verdict: CaptureTrustVerdict;
};

const EARTH_RADIUS_METRES = 6_371_008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A fix is usable for comparison only when BOTH coordinates are real numbers in range. */
function coordinatesOf(fix: CaptureFix | null | undefined): { lat: number; lng: number } | null {
  if (!fix) return null;
  const lat = finiteOrNull(fix.latitude);
  const lng = finiteOrNull(fix.longitude);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Great-circle distance in metres, or null when either fix has no usable coordinates.
 *
 * Haversine rather than a flat-earth approximation: the inputs are two readings of the same doorway
 * and the interesting answers are tens of metres, where the cheap approximation's error is a real
 * fraction of the result.
 */
export function distanceBetweenFixesMeters(
  a: CaptureFix | null | undefined,
  b: CaptureFix | null | undefined,
): number | null {
  const first = coordinatesOf(a);
  const second = coordinatesOf(b);
  if (!first || !second) return null;

  const dLat = toRadians(second.lat - first.lat);
  const dLng = toRadians(second.lng - first.lng);
  const lat1 = toRadians(first.lat);
  const lat2 = toRadians(second.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Seconds from `from` to `to`, or null when either timestamp is missing or unparseable.
 *
 * Signed: a negative value means the shutter timestamp PRECEDES the location fix, which a handset
 * with a wandering clock can produce. Callers judge the magnitude, so the sign is preserved rather
 * than swallowed by an abs() here.
 */
export function secondsBetweenFixes(
  from: CaptureFix | null | undefined,
  to: CaptureFix | null | undefined,
): number | null {
  const start = from?.capturedAt ? Date.parse(from.capturedAt) : NaN;
  const end = to?.capturedAt ? Date.parse(to.capturedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / 1000;
}

/**
 * Compare a venue's location fix against its photo's own fix.
 *
 * Returns `"unmeasured"` whenever the photo carried no coordinates — including when the location
 * fix is itself missing. That case is common and benign, and it is the one result callers most
 * often get wrong: it is the absence of evidence, never evidence of absence.
 */
export function assessCaptureTrust(input: {
  locationFix: CaptureFix | null | undefined;
  photoFix: CaptureFix | null | undefined;
}): CaptureTrustAssessment {
  const distanceMeters = distanceBetweenFixesMeters(input.locationFix, input.photoFix);
  const gapSeconds = secondsBetweenFixes(input.locationFix, input.photoFix);
  const gapIsLong = gapSeconds !== null && Math.abs(gapSeconds) > CAPTURE_GAP_FLAG_SECONDS;

  if (distanceMeters === null) {
    return { distanceMeters: null, gapIsLong, gapSeconds, measured: false, verdict: "unmeasured" };
  }

  const verdict: CaptureTrustVerdict =
    distanceMeters > CAPTURE_DRIFT_DISAGREE_METRES
      ? "disagrees"
      : distanceMeters > CAPTURE_DRIFT_AGREE_METRES
        ? "drifted"
        : "agrees";

  return { distanceMeters, gapIsLong, gapSeconds, measured: true, verdict };
}

/**
 * Two fixes that are IDENTICAL to the floating-point bit are not two fixes.
 *
 * This is the fingerprint of the bug this module replaces — one reading copied onto both rows — and
 * it is also what a naive spoofer produces when it pins a constant position. Real consecutive GPS
 * reads always differ in the low decimals, even from a stationary handset.
 *
 * Reported, never enforced: a legacy row written before the shutter fix shipped looks exactly like
 * this and its rep did nothing wrong. Callers use it to tell "copied" apart from "genuinely
 * measured and genuinely identical", which is not a thing that happens.
 */
export function fixesAreBitIdentical(
  a: CaptureFix | null | undefined,
  b: CaptureFix | null | undefined,
): boolean {
  const first = coordinatesOf(a);
  const second = coordinatesOf(b);
  if (!first || !second) return false;
  if (first.lat !== second.lat || first.lng !== second.lng) return false;
  // Accuracy agreeing to the bit as well is what removes any doubt: two readings can land on the
  // same rounded coordinate pair, but not on the same 13-decimal accuracy figure.
  const accuracyA = finiteOrNull(a?.accuracyMeters);
  const accuracyB = finiteOrNull(b?.accuracyMeters);
  if (accuracyA === null || accuracyB === null) return true;
  return accuracyA === accuracyB;
}
