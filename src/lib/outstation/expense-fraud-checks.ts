/**
 * Claim validation for an outstation expense: does independent evidence corroborate that the
 * person was where the claim says, on the day it says?
 *
 * Owner request (2026-08-08). Four checks, all ADVISORY — the owner's explicit decision is that
 * nothing here withholds money. A finding informs whoever approves; it never blocks payroll.
 *
 * Pure and synchronous on purpose, the same discipline expense-gate.ts uses for the payroll gate.
 * This decides what a reviewer is TOLD about real money, so it must be assertable without a
 * database, a CRM or a network.
 *
 * ── The one rule that matters more than the checks themselves ──────────────────────────────────
 *
 * MISSING DATA IS NEVER A FINDING. Every "no rows" path returns `unverifiable`, never `review`.
 *
 * That is not caution for its own sake — it is measured. Of the 29 GPS-carrying requests since
 * 2026-07-01, ZERO had a check-in by the submitter himself (managers do not check in; their reps
 * do) and only 14 had one from a double-visit partner. Roughly half of all claims have nothing to
 * compare against. If absence rendered as suspicion, this feature would accuse half the company of
 * fraud on its first day.
 *
 * The precedent is expensive: `agent_hr_id` being NULL on 5-9% of CRM rows once produced
 * 14,629.01 EGP of wrong "no CRM activity" deductions against seven real medical reps
 * (the retired iReports360 sync's attribution fix). Absence of evidence is not evidence.
 */

import { hasRealVendorTime } from "@/lib/crm/dates";
import { haversineKm } from "@/lib/sales/normalizer/geo-validate";
import { DEPARTURE_REVIEW_DISTANCE_KM } from "@/lib/outstation/departure-evidence";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

/**
 * How far the captured point may sit from the corroborating check-in before it is worth a look.
 * Re-exported rather than retyped: the departure-photo pair already answers "are these two
 * captures plausibly the same trip" with this number, and two different answers to one question
 * is how thresholds drift apart.
 */
export const CLAIM_PROXIMITY_KM = DEPARTURE_REVIEW_DISTANCE_KM;

/**
 * Beyond this, a nearest-centroid brick match is a neighbouring locality's centre, not the point's
 * own brick. Mirrors brick-geo.ts's own "Weak" band. A weak match must never drive a territory
 * finding — mis-geocoded centroids are a known, documented fact of this dataset.
 */
export const BRICK_WEAK_MATCH_KM = 10;

export type FraudVerdict = "clean" | "review" | "unverifiable";

export type FraudCheckId = "partner" | "location_vs_checkin" | "brick_scope" | "timing";

export type FraudCheckResult = {
  detail: string;
  facts: Array<{ label: string; value: string }>;
  id: FraudCheckId;
  title: string;
  verdict: FraudVerdict;
};

/** One corroborating check-in, borrowed from whoever actually recorded it. */
export type ClaimCheckin = {
  address: string | null;
  /** Vendor wall-clock string. Midnight means "no real time", never 00:00. */
  at: string | null;
  lat: number | null;
  lon: number | null;
  /** Whose check-in this is — the rep's name, for a manager's borrowed route. */
  via: string | null;
};

export type ClaimPartner = {
  hrId: string | null;
  name: string | null;
  /**
   * How the pairing was established. `visit_partner` = the CRM visit row named this manager as
   * the double-visitor. `checkin_via` = recovered from the borrowed check-in's owner when the
   * pair query came back empty (which happens when employees.crm_id is null for the rep).
   */
  source: "visit_partner" | "checkin_via" | "none";
};

export type FraudCheckInput = {
  capturedBrick: { areaCode: string | null; brickName: string | null; distanceKm: number } | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  firstCheckin: ClaimCheckin | null;
  /** `crm_save_date` of the day's first visit — the only vendor field with a real clock. */
  firstVisitSavedAt: string | null;
  /** Every rep the manager was recorded with that day. More than one is normal. */
  partners: readonly ClaimPartner[];
  /** Area codes covering every partner rep. Empty means UNKNOWN, never "wrong". */
  repAreaCodes: readonly string[];
  /** A real instant (timestamptz), unlike the vendor strings above. */
  submittedAt: string | null;
  /** The trip's calendar day in Cairo, YYYY-MM-DD. */
  tripDay: string;
};

export type OutstationClaimValidation = {
  checks: FraudCheckResult[];
  headline: FraudVerdict;
  summary: string;
};

// ── Time helpers ───────────────────────────────────────────────────────────────────────────────
// Two DIFFERENT kinds of timestamp meet in this file and must not be parsed the same way.

/**
 * Minutes past midnight, Cairo, for a REAL instant (e.g. `submitted_at`, a true timestamptz).
 *
 * Formatted through Intl rather than by adding a fixed offset: Egypt observes DST again since
 * 2023, so Cairo is UTC+2 for part of the year and UTC+3 for the rest. A hardcoded offset would
 * mis-read every submission near midnight for half the year.
 */
export function cairoClockMinutes(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).format(date);
  const match = /^(\d{2}):(\d{2})$/.exec(parts.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Minutes past midnight for a VENDOR timestamp — read straight off the string.
 *
 * iReports360 stores Cairo wall-clock with no zone, so `new Date()` would re-interpret it as UTC
 * and shift every value by two or three hours. `hasRealVendorTime` rejects the midnight
 * placeholder that `visit_date_time` carries on ~100% of rows first, so a date-only value can
 * never be mistaken for "captured at 00:00".
 */
export function vendorClockMinutes(value: string | null | undefined): number | null {
  if (!hasRealVendorTime(value)) return null;
  const time = String(value).slice(11, 16);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The Cairo calendar day of a real instant, as YYYY-MM-DD. */
function cairoDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
}

/** "2026-10-01" → "Thu, Oct 01" — a reviewer reads a day, never an ISO key. */
function readableDay(day: string | null): string {
  if (!day) return "an unknown day";
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", timeZone: "UTC", weekday: "short" }).format(date);
}

function clockLabel(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function usableCoordinate(lat: number | null, lon: number | null): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  // 0,0 is the Gulf of Guinea — what a failed browser geolocation writes, never a real capture.
  return !(lat === 0 && lon === 0);
}

// ── The four checks ────────────────────────────────────────────────────────────────────────────

/** Which rep (or reps) corroborate this day at all. */
export function checkDoubleVisitPartner(input: FraudCheckInput): FraudCheckResult {
  const named = input.partners.filter((partner) => partner.source !== "none");

  if (named.length === 0) {
    return {
      detail:
        "No double visit was recorded for this day, so there is no colleague's route to compare against. A manager does not check in themselves — the rep they are with does.",
      facts: [],
      id: "partner",
      title: "Who confirms this day",
      verdict: "unverifiable",
    };
  }

  const label = named
    .map((partner) => partner.name || partner.hrId || "Unnamed")
    .join(", ");

  return {
    detail:
      named.length === 1
        ? `Recorded on a double visit with ${label}, whose check-ins corroborate the day.`
        : `Recorded on double visits with ${named.length} reps that day: ${label}.`,
    facts: named.map((partner) => ({
      label: partner.name || partner.hrId || "Rep",
      value: partner.source === "visit_partner" ? "CRM visit record" : "recovered from check-in",
    })),
    id: "partner",
    title: "Who confirms this day",
    verdict: "clean",
  };
}

/** Captured point versus the first corroborating check-in of the day. */
export function checkLocationVsCheckin(input: FraudCheckInput): FraudCheckResult {
  const title = "Location vs first check-in";

  if (!usableCoordinate(input.capturedLatitude, input.capturedLongitude)) {
    return {
      detail: "The expense carries no usable GPS capture, so there is nothing to compare.",
      facts: [],
      id: "location_vs_checkin",
      title,
      verdict: "unverifiable",
    };
  }

  const checkin = input.firstCheckin;
  if (!checkin || !usableCoordinate(checkin.lat, checkin.lon)) {
    return {
      detail:
        "No check-in with coordinates was recorded for this day, so the captured location cannot be corroborated.",
      facts: [],
      id: "location_vs_checkin",
      title,
      verdict: "unverifiable",
    };
  }

  const km = haversineKm(
    input.capturedLatitude as number,
    input.capturedLongitude as number,
    checkin.lat as number,
    checkin.lon as number,
  );
  const rounded = Number(km.toFixed(2));
  const within = rounded <= CLAIM_PROXIMITY_KM;

  const facts: Array<{ label: string; value: string }> = [
    { label: "Distance apart", value: `${rounded} km` },
    { label: "Allowed", value: `${CLAIM_PROXIMITY_KM} km` },
  ];
  if (checkin.via) facts.push({ label: "Check-in by", value: checkin.via });
  if (checkin.address) facts.push({ label: "Check-in address", value: checkin.address });

  return {
    detail: within
      ? `The expense was captured ${rounded} km from the day's first check-in — consistent with being on the same trip.`
      : `The expense was captured ${rounded} km from the day's first check-in, well beyond the ${CLAIM_PROXIMITY_KM} km the two should be within.`,
    facts,
    id: "location_vs_checkin",
    title,
    verdict: within ? "clean" : "review",
  };
}

/** Does the captured point fall inside the territory of the rep(s) the manager was with? */
export function checkBrickScope(input: FraudCheckInput): FraudCheckResult {
  const title = "Inside the rep's territory";
  const brick = input.capturedBrick;

  if (!brick) {
    return {
      detail: "The captured point could not be matched to a Phoenix brick, so territory cannot be checked.",
      facts: [],
      id: "brick_scope",
      title,
      verdict: "unverifiable",
    };
  }

  // A weak match beats a mismatch. Bricks are stored as single centre points, and mis-geocoded
  // centroids are a documented fact of this dataset — a point 24 km from the nearest centre tells
  // you the centre is wrong, not that the employee was somewhere he should not have been.
  if (brick.distanceKm > BRICK_WEAK_MATCH_KM) {
    return {
      detail: `The nearest brick centre is ${brick.distanceKm.toFixed(0)} km away, too far to identify the territory reliably.`,
      facts: [{ label: "Nearest brick", value: brick.brickName ?? "Unknown" }],
      id: "brick_scope",
      title,
      verdict: "unverifiable",
    };
  }

  if (!brick.areaCode) {
    return {
      detail: "The matched brick carries no area code, so it cannot be compared to a rep's territory.",
      facts: [{ label: "Brick", value: brick.brickName ?? "Unknown" }],
      id: "brick_scope",
      title,
      verdict: "unverifiable",
    };
  }

  if (input.repAreaCodes.length === 0) {
    return {
      detail:
        "The territory covered by the rep on this visit could not be resolved, so there is nothing to compare the brick against.",
      facts: [{ label: "Captured brick", value: brick.brickName ?? brick.areaCode }],
      id: "brick_scope",
      title,
      verdict: "unverifiable",
    };
  }

  const inScope = input.repAreaCodes.some(
    (code) => code.trim().toUpperCase() === brick.areaCode?.trim().toUpperCase(),
  );

  return {
    detail: inScope
      ? "The captured location falls inside the territory covered by the rep on this visit."
      : "The captured location falls outside every area the rep on this visit covers.",
    facts: [
      { label: "Captured brick", value: brick.brickName ?? "Unknown" },
      { label: "Captured area", value: brick.areaCode },
      { label: "Rep covers", value: input.repAreaCodes.join(", ") },
    ],
    id: "brick_scope",
    title,
    verdict: inScope ? "clean" : "review",
  };
}

/**
 * When the expense was filed, against when the day's work actually started.
 *
 * DEVIATION from the original plan, deliberate: the plan called for flagging any submission on a
 * different Cairo day than the trip. That would flag filing an expense the next morning, which is
 * ordinary behaviour, and a check that fires on ordinary behaviour trains people to ignore it.
 * What is actually suspicious is filing a claim BEFORE the work it claims for — so submitting
 * early is a finding, and submitting late is merely noted.
 */
export function checkSubmissionTiming(input: FraudCheckInput): FraudCheckResult {
  const title = "When it was filed";

  const submittedDay = cairoDayOf(input.submittedAt);
  const submittedMinutes = cairoClockMinutes(input.submittedAt);
  if (!submittedDay || submittedMinutes === null) {
    return {
      detail: "The submission time was not recorded, so it cannot be placed against the day's work.",
      facts: [],
      id: "timing",
      title,
      verdict: "unverifiable",
    };
  }

  const tripDay = input.tripDay.slice(0, 10);

  if (submittedDay < tripDay) {
    return {
      detail: `Filed on ${submittedDay}, before the trip on ${tripDay} had happened.`,
      facts: [
        { label: "Filed", value: submittedDay },
        { label: "Trip day", value: tripDay },
      ],
      id: "timing",
      title,
      verdict: "review",
    };
  }

  if (submittedDay > tripDay) {
    return {
      detail: `Filed on ${submittedDay}, after the trip on ${tripDay}. Filing later than the trip is normal.`,
      facts: [
        { label: "Filed", value: submittedDay },
        { label: "Trip day", value: tripDay },
      ],
      id: "timing",
      title,
      verdict: "clean",
    };
  }

  // Same Cairo day — now the clock is meaningful. Take the earliest real anchor the day offers.
  const checkinMinutes = vendorClockMinutes(input.firstCheckin?.at ?? null);
  const visitMinutes = vendorClockMinutes(input.firstVisitSavedAt);
  const anchors = [checkinMinutes, visitMinutes].filter(
    (value): value is number => value !== null,
  );

  if (anchors.length === 0) {
    return {
      detail:
        "No visit or check-in on this day carries a real time, so the submission cannot be placed against the day's work.",
      facts: [{ label: "Filed", value: `${clockLabel(submittedMinutes)} on ${readableDay(submittedDay)}` }],
      id: "timing",
      title,
      verdict: "unverifiable",
    };
  }

  const earliest = Math.min(...anchors);
  const beforeWork = submittedMinutes < earliest;
  const gap = Math.abs(submittedMinutes - earliest);
  const gapLabel = `${Math.floor(gap / 60)}h ${gap % 60}m`;

  const facts: Array<{ label: string; value: string }> = [
    { label: "Filed", value: clockLabel(submittedMinutes) },
    { label: "Day started", value: clockLabel(earliest) },
  ];
  if (checkinMinutes !== null) {
    facts.push({ label: "First check-in", value: clockLabel(checkinMinutes) });
  }
  if (visitMinutes !== null) {
    facts.push({ label: "First visit saved", value: clockLabel(visitMinutes) });
  }

  return {
    detail: beforeWork
      ? `Filed at ${clockLabel(submittedMinutes)}, ${gapLabel} BEFORE the first recorded activity of the day.`
      : `Filed at ${clockLabel(submittedMinutes)}, ${gapLabel} after the day's first recorded activity.`,
    facts,
    id: "timing",
    title,
    verdict: beforeWork ? "review" : "clean",
  };
}

/**
 * Run every check and reduce to one headline.
 *
 * Precedence is deliberate: a single `review` outranks everything, because the point of the panel
 * is to surface the one thing worth a look. `unverifiable` outranks `clean` so a partly-blind
 * result never presents itself as a clean bill of health — saying "verified" on the strength of
 * one check out of four would be worse than saying nothing.
 */
export function evaluateOutstationClaim(input: FraudCheckInput): OutstationClaimValidation {
  const checks = [
    checkDoubleVisitPartner(input),
    checkLocationVsCheckin(input),
    checkBrickScope(input),
    checkSubmissionTiming(input),
  ];

  const reviews = checks.filter((check) => check.verdict === "review");
  const unverifiable = checks.filter((check) => check.verdict === "unverifiable");

  const headline: FraudVerdict =
    reviews.length > 0 ? "review" : unverifiable.length > 0 ? "unverifiable" : "clean";

  const summary =
    reviews.length > 0
      ? `${reviews.length} of ${checks.length} checks need a look: ${reviews.map((check) => check.title.toLowerCase()).join(", ")}.`
      : unverifiable.length === checks.length
        ? "Nothing could be verified for this claim — no corroborating CRM activity was found for the day."
        : unverifiable.length > 0
          ? `${checks.length - unverifiable.length} of ${checks.length} checks passed; the rest could not be verified.`
          : "All checks passed — the claim is corroborated by the day's CRM activity.";

  return { checks, headline, summary };
}
