/**
 * Was the location evidence on an outstation request captured DURING the trip it describes?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A request's `captured_latitude`/`captured_longitude` are taken from the phone at the moment the
 * traveller files, and nothing compares that moment to the trip's dates. File on the day and the
 * coordinate is real evidence of where you went. File three weeks later and the coordinate records
 * where you were STANDING WHEN YOU FILED — which may be your desk, your home, or, in the case that
 * prompted this, another city on a different trip.
 *
 * The departure photo already has this window: `isWithinDepartureWindow` bounds a retake at the end
 * of the trip's last day, "so every version was taken while he was still on the trip". The
 * submission capture has no equivalent, so the one coordinate an approver reads as proof of the
 * trip can silently belong to a different day.
 *
 * Measured on production 2026-09-28, all 153 requests carrying both a capture and a trip end:
 *
 *   - 130 captured during the trip or on its last day — sound
 *   -   3 captured 1 day after
 *   -   4 captured 2-7 days after
 *   -  14 captured 8-30 days after   (7 people, EGP 7,702.96)
 *   -   2 captured over 30 days after
 *
 * So 23 of 153 — 15% — carry location evidence from after the trip ended. The case that surfaced
 * it: AI-0013 filed four claims on 2026-09-17 for trips on 24 Aug, 1 Sep, 6 Sep and 13-17 Sep. All
 * four captured Heliopolis, Cairo, because that is where she stood that morning at the end of the
 * fourth trip. Three of the four therefore carry a 518 km "distance from residence" that measures
 * her filing spot, and a "Location match: High" that compares the capture to itself.
 *
 * ── What this does, and deliberately does NOT do ─────────────────────────────
 *
 * It reports. It does not refuse, and it does not reach the decision engine.
 *
 *   - NEVER a refusal. The house rule on this evidence is explicit: the departure review "NEVER
 *     refuses the photo — the owner chose to flag a suspicious pair rather than block it, so an
 *     employee with a poor GPS fix is never stranded". Filing late is not misconduct; a rep on the
 *     road for a week has every reason to file on return, and blocking that punishes the honest
 *     majority to catch nobody.
 *   - NEVER an input to a decision. `workload-freshness.ts` refused the same widening for the same
 *     reason — "quietly swapping a live read underneath a live rejection rule would change
 *     outstation money with nobody asking for it". The owner's standing rule is that the system
 *     FLAGS an expense and never auto-decides one. This is a sentence for a human, nothing more.
 *   - NEVER an accusation. A late capture says the coordinate cannot corroborate the trip. It says
 *     nothing whatever about whether the trip happened, and the wording must not imply otherwise.
 *
 * Pure on purpose: the caller supplies both sides, so this is testable without a database.
 */

/** Whether the capture can corroborate the trip it is attached to. */
export type CaptureTimelinessVerdict =
  /** Captured during the trip or on its last day — the coordinate is evidence of the trip. */
  | "on_trip"
  /** Captured after the trip ended — the coordinate records the filing place, not the trip. */
  | "late"
  /** A date is missing or unreadable, so no comparison is possible. */
  | "unknown";

export type CaptureTimeliness = {
  /** Cairo calendar day the capture happened, or null when unreadable. */
  readonly capturedDay: string | null;
  /** Whole days between the trip's last day and the capture. Null unless the verdict is "late". */
  readonly daysAfterTripEnd: number | null;
  /**
   * One neutral sentence for a reviewer, or null when there is nothing to say. Written to sit
   * beside the captured facts, so it names what the coordinate does and does not show.
   */
  readonly headline: string | null;
  /** Cairo calendar day the trip ended, or null when unreadable. */
  readonly tripEndDay: string | null;
  readonly verdict: CaptureTimelinessVerdict;
};

/** The Cairo calendar day of an instant, as YYYY-MM-DD, or null when it cannot be read. */
function cairoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
}

/** Whole days from one YYYY-MM-DD to another. Both are calendar days, so no clock arithmetic. */
function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Compare a request's capture against its trip end.
 *
 * Fails OPEN, exactly as `isWithinDepartureWindow` does: when either side is missing or unreadable
 * the verdict is "unknown" and there is no headline. A gap in our own data must never surface as a
 * warning about a person.
 */
export function resolveCaptureTimeliness(input: {
  capturedAt: string | null | undefined;
  tripEndDate: string | null | undefined;
}): CaptureTimeliness {
  const capturedDay = cairoDay(input.capturedAt);
  const rawEnd = String(input.tripEndDate ?? "").slice(0, 10);
  const tripEndDay = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ? rawEnd : null;

  if (!capturedDay || !tripEndDay) {
    return { capturedDay, daysAfterTripEnd: null, headline: null, tripEndDay, verdict: "unknown" };
  }

  if (capturedDay <= tripEndDay) {
    // Nothing to say. A capture taken on the trip is the normal case and needs no commentary.
    return { capturedDay, daysAfterTripEnd: null, headline: null, tripEndDay, verdict: "on_trip" };
  }

  const daysAfterTripEnd = daysBetween(tripEndDay, capturedDay);
  const dayWord = daysAfterTripEnd === 1 ? "day" : "days";
  return {
    capturedDay,
    daysAfterTripEnd,
    headline:
      `This location was captured ${daysAfterTripEnd} ${dayWord} after the trip ended, so it records `
      + "where the request was filed, not where the trip went. The distance and the location match "
      + "are measured against it. Filing late is not itself a problem — judge this trip on its other "
      + "evidence.",
    tripEndDay,
    verdict: "late",
  };
}
