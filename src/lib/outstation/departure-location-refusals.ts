/**
 * Every departure photo refused for having no GPS location, kept with its time and its cause.
 *
 * Owner, 2026-09-18. A departure photo with no location is refused and nothing is stored
 * (departure-photo-location.ts). He then chose "Record refused tries": each refusal is saved on the
 * request, and the approver reads it where the departure photo would be. His words for the line:
 * "No GPS location because" the cause, for example no network there, or location turned off.
 * Short, the cause only.
 *
 * Stored in outstation_expense_requests.departure_location_refusals as [{ at, reason }]. The web
 * card, the Android app and the service send the codes below. The app cannot import this file, so
 * tests/outstation-departure-gps-reason.test.ts pins every code it sends to this list.
 *
 * Pure and import-free: the web capture card and the approver screens are client code.
 */

export const DEPARTURE_LOCATION_REFUSAL_REASONS = [
  "permission_denied",
  "location_off",
  "timeout",
  "position_unavailable",
  "unsupported",
  "not_reported",
] as const;

export type DepartureLocationRefusalReason = (typeof DEPARTURE_LOCATION_REFUSAL_REASONS)[number];

export type DepartureLocationRefusal = {
  /** When the photo was refused, as an ISO time. */
  at: string;
  reason: DepartureLocationRefusalReason;
};

/** The newest this many are kept. A person retrying in a dead spot must not grow the row forever. */
export const DEPARTURE_LOCATION_REFUSALS_KEPT = 20;

/** For a photo, or a try, whose cause nobody reported. */
export const NO_GPS_CAUSE_NOT_REPORTED = "No GPS location. The phone did not report why.";

const CAUSE: Record<Exclude<DepartureLocationRefusalReason, "not_reported">, string> = {
  permission_denied: "location was turned off for Phoenix",
  location_off: "location was turned off on the phone",
  timeout: "the phone found no signal in time",
  position_unavailable: "the phone could not find its position",
  unsupported: "this browser cannot share location",
};

export function isDepartureLocationRefusalReason(value: unknown): value is DepartureLocationRefusalReason {
  return typeof value === "string" && (DEPARTURE_LOCATION_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** A code from a request body. Anything unknown, or nothing, is `not_reported`, never a guess. */
export function readDepartureLocationRefusalReason(value: unknown): DepartureLocationRefusalReason {
  return isDepartureLocationRefusalReason(value) ? value : "not_reported";
}

/**
 * A browser `GeolocationPositionError.code` as a cause: 1 is PERMISSION_DENIED, 3 is TIMEOUT, and
 * 2 (POSITION_UNAVAILABLE) or anything else is a failure to find the position.
 */
export function departureRefusalReasonFromBrowserErrorCode(code: unknown): DepartureLocationRefusalReason {
  if (code === 1) return "permission_denied";
  if (code === 3) return "timeout";
  return "position_unavailable";
}

/** What the approver reads, e.g. "No GPS location because location was turned off on the phone." */
export function noGpsLocationText(reason: DepartureLocationRefusalReason): string {
  return reason === "not_reported" ? NO_GPS_CAUSE_NOT_REPORTED : `No GPS location because ${CAUSE[reason]}.`;
}

/** The stored list read back. A missing column, a bad value or a malformed entry reads as nothing. */
export function readDepartureLocationRefusals(raw: unknown): DepartureLocationRefusal[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): DepartureLocationRefusal[] => {
    if (!item || typeof item !== "object") return [];
    const { at, reason } = item as { at?: unknown; reason?: unknown };
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return [];
    return [{ at, reason: readDepartureLocationRefusalReason(reason) }];
  });
}

/** The stored list with one more refusal on the end, newest kept. */
export function withDepartureLocationRefusal(
  stored: unknown,
  refusal: DepartureLocationRefusal,
): DepartureLocationRefusal[] {
  return [...readDepartureLocationRefusals(stored), refusal].slice(-DEPARTURE_LOCATION_REFUSALS_KEPT);
}
