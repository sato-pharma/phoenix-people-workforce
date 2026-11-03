/**
 * Chained-journey fuel pricing (owner rule, 2026-10-18).
 *
 * Until this rule a car trip was priced as home → destination → home: the road km from the
 * residence to the arrival photo, times two, times the fuel rate. That is only true when the
 * employee goes out and comes back. The owner's case: a District Manager living in Mallawi
 * (Minya) drove to Sinnuris (Fayoum) on 17 Oct 2026, slept there, drove on to Beni Suef the next
 * day and went home from Beni Suef. The old rule has no place for the Beni Suef drive at all.
 *
 * His rule, in his words: Minya → Fayoum "× 1.8", Fayoum → Beni Suef "× 1.8", Beni Suef "or the
 * point he works at" → Minya "× 1.8" — "but only from governorate to governorate", and only when
 * that drive is "more than 40 km". On a second example (Mallawi → Assiut → Dairut → home), where
 * Dairut is inside Assiut, he ruled: "keep as today rule".
 *
 * So a journey is a chain of drives — home → arrival → stop 2 → … → last stop → home — and:
 *
 *   - It is priced as a CHAIN only when at least one drive between two captured places crosses
 *     into another governorate AND is over 40 km. Otherwise (every stop in one governorate, or the
 *     cross drives are short) the trip is priced exactly as before: home → arrival, × 2.
 *   - In a chain, every drive is paid ONCE, one way, at its road km × the fuel rate — but only a
 *     drive that crosses into another governorate and is over 40 km. A drive inside one
 *     governorate pays nothing.
 *   - A trip with no extra stop is priced exactly as before. Nothing about an ordinary trip moves.
 *
 * The anti-abuse half (owner, same evening: "make sure that no one abuses it"). Every distance is
 * Google's road distance between two live photo positions, never a typed number; every
 * governorate is the reverse-geocode of a photo position, never a typed place. The checks below
 * FLAG a journey for the Super Admin and never refuse it — the owner's 2026-08-09 rule that the
 * system flags an expense and a human decides. A journey the system cannot price as a chain (a
 * governorate or a road distance it could not read) keeps the old single-destination price and
 * is flagged: it is never priced on a guess.
 *
 * Pure: no database, no clock, no network. The service resolves positions, governorates and road
 * distances, then hands them here. Pinned by tests/outstation-chained-journey.test.ts.
 */

import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import type { JourneyStopEvidence } from "@/lib/outstation/journey-stop-rules";

/** A drive between two governorates pays only when it is longer than this (owner, 2026-10-18). */
export const CHAINED_LEG_MINIMUM_KM = 40;

/** More paid stop-to-stop drives than this on one Cairo day is flagged — three governorates in a day. */
export const MAX_PAID_STOP_LEGS_PER_DAY = 2;

/**
 * A stop photographed sooner after the previous photo than this share of Google's own drive time
 * was not reached by road. 0.5 leaves room for an empty road and an optimistic estimate.
 */
export const IMPOSSIBLE_SPEED_RATIO = 0.5;

/** A stop photographed within this many minutes of the previous photo evidences no work there. */
export const STOP_MINIMUM_MINUTES_AFTER_PREVIOUS = 10;

/** A chained price more than this multiple of the single-destination price is worth a human look. */
export const CHAIN_REVIEW_MULTIPLE = 2;

/**
 * The most extra stops one trip may carry. Refused beyond this — a capture, not a claim, so the
 * flag-never-reject rule is not in play: nobody's money is refused, a seventh photo is.
 */
export const MAX_JOURNEY_STOPS = 6;

/** Where the drive to a stop is measured FROM — the latest capture before the stop. */
export type JourneyLegOrigin = "arrival" | "departure" | "stop";

/** One extra place on a journey, captured after the first one, by whatever evidence the person owes. */
export type OutstationJourneyStop = {
  /** 2 for the first extra stop — the arrival photo is stop 1. */
  stopNumber: number;
  /** Server time of the capture, never the phone's. */
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Canonical governorate of the photo position (resolveGovernorate output), or null. */
  governorate: string | null;
  locationLabel: string | null;
  /** How it was proved (journey-stop-rules.ts). A stored row with a photo and no kind is a live photo. */
  evidence: JourneyStopEvidence;
  /** The live photo; null for a stop proved by location or by location and ticket. */
  photoPath: string | null;
  /** This leg's ticket, on a trip without a car; 0 when there is none. */
  ticketAmount: number;
  /** The stored files of that ticket — they also sit on the claim's own ticket list. */
  ticketPaths: string[];
  /** The card's key for this capture, so a retry finds the stop it already saved. */
  captureKey?: string;
  /**
   * The photo the drive to this stop is measured from: the stop before it, else the departure
   * photo when it was taken before this stop (it is where he left the first place from — Fayoum
   * city, not Sinnuris, in the owner's example), else the arrival photo.
   */
  legFrom: JourneyLegOrigin;
  legFromCapturedAt: string | null;
  /** Canonical governorate of that origin photo. */
  legFromGovernorate: string | null;
  /** Google road km from that origin photo to this stop. */
  legFromPreviousKm: number | null;
  /** Google's drive time for that leg, in minutes. */
  legFromPreviousMinutes: number | null;
  /** Google road km from this stop back to the residence — the drive home when it is the last stop. */
  returnHomeKm: number | null;
  /** Why a road distance could not be read, when one could not. */
  routeError: string | null;
  /**
   * Set only on a stop a system administrator added after the employee missed it (2026-11-03):
   * there is no live photo, the position and time are the administrator's, and the reason is said
   * on the claim for the person deciding it. Absent on every stop an employee took.
   */
  addedByAdmin?: { by: string; reason: string } | null;
};

/** The photo path a stop added by a system administrator carries: there is no photo to sign. */
export const ADMIN_ADDED_STOP_PHOTO_PATH = "admin-added:no-photo";

/** One sentence per administrator-added stop, kept in the approval reason through later re-pricing. */
export function adminAddedStopNotes(stops: OutstationJourneyStop[]): string[] {
  return stops
    .filter((stop) => stop.addedByAdmin)
    .map(
      (stop) =>
        `Stop ${stop.stopNumber} was added by a system administrator (${stop.addedByAdmin?.by}), with no photo: ${stop.addedByAdmin?.reason}`,
    );
}

export type ChainedJourneyFlag =
  | "chain_unpriceable"
  | "stop_outside_trip_dates"
  | "stop_out_of_order"
  | "stop_too_soon"
  | "impossible_speed"
  | "stop_gps_inaccurate"
  | "revisits_governorate"
  | "stop_in_home_governorate"
  | "another_trip_same_day"
  | "too_many_governorates_in_a_day"
  | "chain_large";

export type JourneyLegReason =
  | "different_governorates"
  | "same_governorate"
  | "under_minimum_km"
  | "distance_unknown"
  | "governorate_unknown"
  /** A drive on a trip without a car that a stop's own ticket answers for. */
  | "ticket_leg"
  /** The first or the last drive of such a trip — the claim's own tickets answer for those. */
  | "ticket_on_claim";

export type JourneyLeg = {
  from: string;
  to: string;
  fromGovernorate: string | null;
  toGovernorate: string | null;
  distanceKm: number | null;
  paid: boolean;
  reason: JourneyLegReason;
  fuelAmount: number;
  /** The ticket attached for this leg; 0 on a car trip, and on a leg with none. */
  ticketAmount: number;
};

export type ChainedJourneyPricing = {
  /** `ticket_journey`: a trip without a car. The drives are listed, no fuel is paid, tickets are. */
  mode: "single_destination" | "chained" | "ticket_journey";
  /** One plain sentence on why the journey is priced the way it is. */
  modeReason: string;
  /** Every drive of the journey, home to home. Empty for a trip with no extra stop. */
  legs: JourneyLeg[];
  paidKm: number;
  fuelAmount: number;
  /** What the old rule (home → arrival, × 2) pays — always computed, for the reviewer to compare. */
  singleDestinationFuelAmount: number;
  flags: ChainedJourneyFlag[];
  /** One sentence per flag, for the person deciding the claim. */
  flagReasons: string[];
};

export type ChainedJourneyInput = {
  residenceGovernorate: string | null;
  arrival: {
    governorate: string | null;
    capturedAt: string | null;
    distanceFromResidenceKm: number | null;
  };
  stops: OutstationJourneyStop[];
  fuelRatePerKm: number;
  tripStartDate: string;
  tripEndDate: string;
  /** The role policy's GPS limit; a stop fix worse than this, or with no accuracy at all, is flagged. */
  gpsAccuracyThresholdMeters?: number | null;
  /** The employee's OTHER live car trips, by Cairo day — a stop on such a day may be paid twice. */
  otherCarTripsByDay?: Record<string, number[]>;
  /** How the person travelled; a trip without a car is listed drive by drive and pays no fuel. */
  travel?: "car" | "ticket";
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundKm(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function instantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function dateOnly(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function home(governorate: string | null): string {
  return governorate ? `Home (${governorate})` : "Home";
}

/** A place on the route reads as its governorate: "Sohag", never "Stop 2 (Sohag)". */
function placeName(governorate: string | null, fallback: string): string {
  return governorate ?? fallback;
}

const FIRST_PLACE = "First place";
const NEXT_PLACE = "Next place";
const LEFT_FROM = "Where you left from";

/** Who a flag sentence is about. */
function stopSubject(stop: Pick<OutstationJourneyStop, "governorate">): string {
  return stop.governorate ? `The stop in ${stop.governorate}` : "An added stop";
}

function stopObject(stop: Pick<OutstationJourneyStop, "governorate">): string {
  return stop.governorate ? `the stop in ${stop.governorate}` : "an added stop";
}

/** Whether one drive pays, and why — the owner's governorate-to-governorate, over-40-km test. */
export function classifyJourneyLeg(input: {
  fromGovernorate: string | null;
  toGovernorate: string | null;
  distanceKm: number | null;
}): { paid: boolean; reason: JourneyLegReason } {
  const distanceKm = finiteOrNull(input.distanceKm);
  if (!input.fromGovernorate || !input.toGovernorate) return { paid: false, reason: "governorate_unknown" };
  // Before the distance: a drive inside one governorate pays nothing however long, so a road
  // distance Google could not give it changes nothing and must not make the chain unpriceable.
  if (input.fromGovernorate === input.toGovernorate) return { paid: false, reason: "same_governorate" };
  if (distanceKm == null) return { paid: false, reason: "distance_unknown" };
  if (distanceKm <= CHAINED_LEG_MINIMUM_KM) return { paid: false, reason: "under_minimum_km" };
  return { paid: true, reason: "different_governorates" };
}

// Worst first: the flag most likely to decide the claim is the one the approver reads first.
const FLAG_ORDER: ChainedJourneyFlag[] = [
  "another_trip_same_day",
  "impossible_speed",
  "stop_out_of_order",
  "stop_outside_trip_dates",
  "stop_in_home_governorate",
  "revisits_governorate",
  "stop_too_soon",
  "too_many_governorates_in_a_day",
  "stop_gps_inaccurate",
  "chain_large",
  "chain_unpriceable",
];

/**
 * Price a journey under the chained rule and list everything about it a reviewer should look at.
 * A trip with no extra stop returns the old single-destination price, no legs and no flags.
 */
export function priceChainedJourney(input: ChainedJourneyInput): ChainedJourneyPricing {
  const ticketTravel = input.travel === "ticket";
  const rate = ticketTravel ? 0 : finiteOrNull(input.fuelRatePerKm) ?? 0;
  const arrivalKm = finiteOrNull(input.arrival.distanceFromResidenceKm);
  const singleDestinationFuelAmount = roundMoney((arrivalKm ?? 0) * 2 * rate);
  const stops = [...input.stops].sort((a, b) => a.stopNumber - b.stopNumber);

  if (stops.length === 0) {
    return {
      fuelAmount: singleDestinationFuelAmount,
      flagReasons: [],
      flags: [],
      legs: [],
      mode: "single_destination",
      modeReason: ticketTravel
        ? "One destination, travelled by ticket: no fuel is paid."
        : "One destination: priced home to destination and back.",
      paidKm: ticketTravel ? 0 : roundKm((arrivalKm ?? 0) * 2),
      singleDestinationFuelAmount,
    };
  }

  const flags = new Set<ChainedJourneyFlag>();
  const reasons = new Map<ChainedJourneyFlag, string>();
  const flag = (name: ChainedJourneyFlag, reason: string) => {
    if (!flags.has(name)) {
      flags.add(name);
      reasons.set(name, reason);
    }
  };

  // ── The drives, home to home ────────────────────────────────────────────────────────────────
  const homeLabel = home(input.residenceGovernorate);
  const arrivalLabel = placeName(input.arrival.governorate, FIRST_PLACE);
  const legs: JourneyLeg[] = [];
  const pushLeg = (
    from: string,
    to: string,
    fromGov: string | null,
    toGov: string | null,
    km: number | null,
    ticket: { amount: number; onStop: boolean } = { amount: 0, onStop: false },
  ) => {
    const distanceKm = finiteOrNull(km);
    if (ticketTravel) {
      legs.push({
        distanceKm,
        from,
        fromGovernorate: fromGov,
        fuelAmount: 0,
        paid: false,
        reason: ticket.onStop ? "ticket_leg" : "ticket_on_claim",
        ticketAmount: roundMoney(ticket.amount),
        to,
        toGovernorate: toGov,
      });
      return;
    }
    const verdict = classifyJourneyLeg({ distanceKm: km, fromGovernorate: fromGov, toGovernorate: toGov });
    legs.push({
      distanceKm,
      fromGovernorate: fromGov,
      from,
      fuelAmount: verdict.paid && distanceKm != null ? roundMoney(distanceKm * rate) : 0,
      paid: verdict.paid,
      reason: verdict.reason,
      ticketAmount: 0,
      to,
      toGovernorate: toGov,
    });
  };

  pushLeg(homeLabel, arrivalLabel, input.residenceGovernorate, input.arrival.governorate, arrivalKm);
  let previousLabel = arrivalLabel;
  let previousGovernorate = input.arrival.governorate;
  const stopLegs: Array<{ leg: JourneyLeg; stop: OutstationJourneyStop }> = [];
  for (const [index, stop] of stops.entries()) {
    const label = placeName(stop.governorate, NEXT_PLACE);
    // Only the FIRST stop can start from the departure photo; every later one starts from the
    // stop before it, whatever a hand-edited row claims.
    const fromDeparture = index === 0 && stop.legFrom === "departure";
    const fromLabel = fromDeparture ? placeName(stop.legFromGovernorate, LEFT_FROM) : previousLabel;
    const fromGovernorate = fromDeparture ? stop.legFromGovernorate : previousGovernorate;
    // A departure photo in ANOTHER governorate than the arrival is a drive between them that nothing
    // measured: it is listed with no road distance, so the journey is flagged and never priced on a guess.
    if (fromDeparture && fromGovernorate && previousGovernorate && fromGovernorate !== previousGovernorate) {
      pushLeg(previousLabel, fromLabel, previousGovernorate, fromGovernorate, null);
    }
    pushLeg(fromLabel, label, fromGovernorate, stop.governorate, stop.legFromPreviousKm, {
      amount: stop.ticketAmount,
      onStop: true,
    });
    stopLegs.push({ leg: legs[legs.length - 1], stop });
    previousLabel = label;
    previousGovernorate = stop.governorate;
  }
  const lastStop = stops[stops.length - 1];
  pushLeg(previousLabel, homeLabel, previousGovernorate, input.residenceGovernorate, lastStop.returnHomeKm);

  // ── The anti-abuse checks — every one a flag, never a refusal ─────────────────────────────
  const firstDay = dateOnly(input.tripStartDate);
  const lastDay = dateOnly(input.tripEndDate);
  let previousAt = instantMs(input.arrival.capturedAt);
  const visited = new Set<string>(input.arrival.governorate ? [input.arrival.governorate] : []);
  let previousStopGovernorate = input.arrival.governorate;
  const paidStopLegsByDay = new Map<string, number>();

  const gpsLimit = finiteOrNull(input.gpsAccuracyThresholdMeters ?? null);
  for (const [index, { leg, stop }] of stopLegs.entries()) {
    const at = instantMs(stop.capturedAt);
    const day = cairoDateOnly(stop.capturedAt);
    // The drive to the first stop may start at the departure photo — time it from there.
    if (index === 0 && stop.legFrom === "departure") {
      previousAt = instantMs(stop.legFromCapturedAt) ?? previousAt;
      // ...and judge a return against where he left from, not only where he arrived.
      if (stop.legFromGovernorate) {
        visited.add(stop.legFromGovernorate);
        previousStopGovernorate = stop.legFromGovernorate;
      }
    }
    if (gpsLimit != null && gpsLimit > 0) {
      const accuracy = finiteOrNull(stop.accuracyMeters);
      if (accuracy == null || accuracy > gpsLimit) {
        flag(
          "stop_gps_inaccurate",
          accuracy == null
            ? `${stopSubject(stop)} reported no GPS accuracy.`
            : `${stopSubject(stop)} had a GPS fix accurate only to ${Math.round(accuracy)} m (the limit is ${Math.round(gpsLimit)} m).`,
        );
      }
    }
    const otherTrips = day ? input.otherCarTripsByDay?.[day] ?? [] : [];
    if (otherTrips.length > 0) {
      flag(
        "another_trip_same_day",
        `Another car trip (${otherTrips.map((id) => `#${id}`).join(", ")}) is also filed for ${day}, the day of ${stopObject(stop)} — the same drive may be paid twice.`,
      );
    }
    if (day && ((firstDay && day < firstDay) || (lastDay && day > lastDay))) {
      flag(
        "stop_outside_trip_dates",
        `${stopSubject(stop)} was captured on ${day}, outside the trip's dates (${firstDay} to ${lastDay}).`,
      );
    }
    if (at != null && previousAt != null) {
      const minutes = (at - previousAt) / 60000;
      if (minutes < 0) {
        flag("stop_out_of_order", `${stopSubject(stop)} was captured before the capture that comes before it.`);
      } else {
        if (minutes < STOP_MINIMUM_MINUTES_AFTER_PREVIOUS) {
          flag(
            "stop_too_soon",
            `${stopSubject(stop)} was captured ${Math.round(minutes)} minutes after the previous capture — no time to work there.`,
          );
        }
        const driveMinutes = finiteOrNull(stop.legFromPreviousMinutes);
        if (driveMinutes != null && driveMinutes > 0 && minutes < driveMinutes * IMPOSSIBLE_SPEED_RATIO) {
          flag(
            "impossible_speed",
            `${stopSubject(stop)} was captured ${Math.round(minutes)} minutes after the previous capture, but Google needs about ${Math.round(driveMinutes)} minutes to drive there.`,
          );
        }
      }
    }
    if (stop.governorate) {
      if (stop.governorate !== previousStopGovernorate && visited.has(stop.governorate)) {
        flag(
          "revisits_governorate",
          `${stopSubject(stop)} goes back to a governorate this journey already visited.`,
        );
      }
      if (input.residenceGovernorate && stop.governorate === input.residenceGovernorate) {
        flag(
          "stop_in_home_governorate",
          `${stopSubject(stop)} is in the employee's home governorate — the journey may have gone home in between.`,
        );
      }
      visited.add(stop.governorate);
    }
    previousStopGovernorate = stop.governorate;
    // On a ticket journey no drive is paid in fuel, so the same check counts the crossings.
    const crosses = ticketTravel
      ? classifyJourneyLeg({
          distanceKm: leg.distanceKm,
          fromGovernorate: leg.fromGovernorate,
          toGovernorate: leg.toGovernorate,
        }).paid
      : leg.paid;
    if (crosses && day) paidStopLegsByDay.set(day, (paidStopLegsByDay.get(day) ?? 0) + 1);
    if (at != null) previousAt = at;
  }
  for (const [day, count] of paidStopLegsByDay) {
    if (count > MAX_PAID_STOP_LEGS_PER_DAY) {
      flag(
        "too_many_governorates_in_a_day",
        `${count} ${ticketTravel ? "moves" : "paid drives"} between governorates on ${day} — more than ${MAX_PAID_STOP_LEGS_PER_DAY} in one day.`,
      );
    }
  }

  // ── Which rule prices it ────────────────────────────────────────────────────────────────────
  const unpriceable = legs.find((leg) => leg.reason === "governorate_unknown" || leg.reason === "distance_unknown");
  const chainQualifies = stopLegs.some(({ leg }) => leg.paid);
  const finish = (pricing: Omit<ChainedJourneyPricing, "flags" | "flagReasons">): ChainedJourneyPricing => {
    const ordered = FLAG_ORDER.filter((name) => flags.has(name));
    return { ...pricing, flagReasons: ordered.map((name) => reasons.get(name) ?? name), flags: ordered };
  };

  // Nothing here turns on a road distance or a governorate: no fuel is paid either way.
  if (ticketTravel) {
    return finish({
      fuelAmount: 0,
      legs,
      mode: "ticket_journey",
      modeReason: "Travelled by ticket, so no fuel is paid. Each leg is paid by its ticket on this claim.",
      paidKm: 0,
      singleDestinationFuelAmount: 0,
    });
  }

  if (unpriceable) {
    flag(
      "chain_unpriceable",
      `The drive ${unpriceable.from} → ${unpriceable.to} has no ${unpriceable.reason === "distance_unknown" ? "road distance" : "governorate"}, so the journey is kept at the single-destination price until someone checks it.`,
    );
    return finish({
      fuelAmount: singleDestinationFuelAmount,
      legs,
      mode: "single_destination",
      modeReason: "The journey could not be priced as a chain, so it keeps the home to destination and back price.",
      paidKm: roundKm((arrivalKm ?? 0) * 2),
      singleDestinationFuelAmount,
    });
  }

  if (!chainQualifies) {
    return finish({
      fuelAmount: singleDestinationFuelAmount,
      legs,
      mode: "single_destination",
      modeReason: `No stop moves to another governorate more than ${CHAINED_LEG_MINIMUM_KM} km away, so the journey is priced home to the first destination and back, as before.`,
      paidKm: roundKm((arrivalKm ?? 0) * 2),
      singleDestinationFuelAmount,
    });
  }

  const paidKm = roundKm(legs.reduce((sum, leg) => sum + (leg.paid ? leg.distanceKm ?? 0 : 0), 0));
  const fuelAmount = roundMoney(paidKm * rate);
  if (singleDestinationFuelAmount > 0 && fuelAmount > singleDestinationFuelAmount * CHAIN_REVIEW_MULTIPLE) {
    flag(
      "chain_large",
      `The chained fuel (${fuelAmount.toFixed(2)}) is more than ${CHAIN_REVIEW_MULTIPLE} times the single-destination fuel (${singleDestinationFuelAmount.toFixed(2)}).`,
    );
  }
  return finish({
    fuelAmount,
    legs,
    mode: "chained",
    modeReason: `The journey moves from governorate to governorate, so each drive between governorates over ${CHAINED_LEG_MINIMUM_KM} km is paid once, one way.`,
    paidKm,
    singleDestinationFuelAmount,
  });
}

export { JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE } from "@/lib/outstation/journey-stop-location";

const JOURNEY_REASON_MARKER = "Journey check:";

/**
 * The request's approval reason with the journey appended as ONE "Journey check:" sentence group —
 * the chain price when it is chained, every flag, and any extra sentence the caller adds — replaced,
 * never stacked, when a later stop re-prices the journey, and removed when the journey no longer has
 * anything to say. The approvals queue renders this column, so the person deciding reads it without
 * opening anything.
 */
export function withJourneyReason(
  base: string | null | undefined,
  pricing: ChainedJourneyPricing | null,
  extra: string[] = [],
): string {
  const current = String(base ?? "");
  const cut = current.indexOf(JOURNEY_REASON_MARKER);
  const head = (cut >= 0 ? current.slice(0, cut) : current).trim();
  const sentences = [
    // A journey priced as a chain ALWAYS says so, flagged or not: the employee's own captures moved
    // the money, so the person deciding must see that it happened without opening anything.
    ...(pricing?.mode === "chained"
      ? [
          `Priced as a chain of drives: ${pricing.paidKm} km paid one way, fuel ${pricing.fuelAmount.toFixed(2)} ` +
            `(home and back would be ${pricing.singleDestinationFuelAmount.toFixed(2)}).`,
        ]
      : []),
    ...(pricing?.mode === "ticket_journey"
      ? [
          `Travelled by ticket through ${pricing.legs.length - 1} places, no fuel paid; ` +
            `tickets for the added places ${pricing.legs.reduce((sum, leg) => sum + leg.ticketAmount, 0).toFixed(2)}.`,
        ]
      : []),
    ...(pricing?.flagReasons ?? []),
    ...extra,
  ];
  if (sentences.length === 0) return head;
  return [head, `${JOURNEY_REASON_MARKER} ${sentences.join(" ")}`].filter(Boolean).join(" ");
}

// ── Reading stored stops back, and the small decisions the service makes around a capture ─────

const LEG_ORIGINS = new Set<JourneyLegOrigin>(["arrival", "departure", "stop"]);

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFieldOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A live-photo stop needs its photo; a stop with no kind is an older row, which only a photo proves. */
function readStopEvidence(kind: unknown, photoPath: string | null): JourneyStopEvidence | null {
  if (kind === "location" || kind === "location_ticket") return kind;
  return photoPath ? "live_photo" : null;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readAddedByAdmin(raw: unknown): { addedByAdmin?: { by: string; reason: string } } {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const by = textOrNull(value.by);
  const reason = textOrNull(value.reason);
  return by && reason ? { addedByAdmin: { by, reason } } : {};
}

/**
 * The stored `journey_stops` column, read defensively: anything that is not an array, and any entry
 * without a stop number, a capture time, its evidence and a real position, is dropped rather than
 * priced. A hand-edited or half-written entry must never become a paid drive. A row from before the
 * evidence kinds has a photo and no kind, and reads as a live photo; no photo and no kind is dropped.
 */
export function readJourneyStops(raw: unknown): OutstationJourneyStop[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  const stops: OutstationJourneyStop[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const stopNumber = Number(row.stopNumber);
    const latitude = numberFieldOrNull(row.latitude);
    const longitude = numberFieldOrNull(row.longitude);
    const capturedAt = textOrNull(row.capturedAt);
    const photoPath = textOrNull(row.photoPath);
    if (!Number.isInteger(stopNumber) || stopNumber < 2) continue;
    if (latitude == null || longitude == null || (latitude === 0 && longitude === 0)) continue;
    if (!capturedAt || instantMs(capturedAt) == null) continue;
    // An administrator's stop stored before the kinds holds a marker in place of a photo.
    const evidence = row.addedByAdmin ? "location" : readStopEvidence(row.evidence, photoPath);
    if (!evidence) continue;
    const legFrom = LEG_ORIGINS.has(row.legFrom as JourneyLegOrigin) ? (row.legFrom as JourneyLegOrigin) : "stop";
    stops.push({
      accuracyMeters: numberFieldOrNull(row.accuracyMeters),
      capturedAt,
      evidence,
      governorate: textOrNull(row.governorate),
      latitude,
      legFrom,
      legFromCapturedAt: textOrNull(row.legFromCapturedAt),
      legFromGovernorate: textOrNull(row.legFromGovernorate),
      legFromPreviousKm: numberFieldOrNull(row.legFromPreviousKm),
      legFromPreviousMinutes: numberFieldOrNull(row.legFromPreviousMinutes),
      locationLabel: textOrNull(row.locationLabel),
      longitude,
      photoPath,
      returnHomeKm: numberFieldOrNull(row.returnHomeKm),
      routeError: textOrNull(row.routeError),
      stopNumber,
      ticketAmount: Math.max(0, numberFieldOrNull(row.ticketAmount) ?? 0),
      ticketPaths: Array.isArray(row.ticketPaths)
        ? row.ticketPaths.filter((path): path is string => typeof path === "string" && path.length > 0)
        : [],
      ...readAddedByAdmin(row.addedByAdmin),
      ...(textOrNull(row.captureKey) ? { captureKey: String(textOrNull(row.captureKey)) } : {}),
    });
  }
  return stops.sort((a, b) => a.stopNumber - b.stopNumber);
}

/** What a place on a stored route was called before places read as their governorate. */
function cleanStoredPlace(label: unknown): string {
  const value = String(label ?? "");
  const named = value.match(/^(?:Arrival|Stop \d+|Departure photo) \((.+)\)$/);
  if (named) return named[1];
  if (value === "Arrival") return FIRST_PLACE;
  if (/^Stop \d+$/.test(value)) return NEXT_PLACE;
  if (value === "Departure photo") return LEFT_FROM;
  return value;
}

function readStoredLeg(leg: JourneyLeg): JourneyLeg {
  return {
    ...leg,
    from: cleanStoredPlace(leg.from),
    ticketAmount: numberFieldOrNull(leg.ticketAmount) ?? 0,
    to: cleanStoredPlace(leg.to),
  };
}

/** The stored `journey_pricing` snapshot, or null when it is missing or not the expected shape. */
export function readJourneyPricing(raw: unknown): ChainedJourneyPricing | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ChainedJourneyPricing>;
  if (row.mode !== "chained" && row.mode !== "single_destination" && row.mode !== "ticket_journey") return null;
  if (!Array.isArray(row.legs) || !Array.isArray(row.flags)) return null;
  return {
    flagReasons: Array.isArray(row.flagReasons) ? row.flagReasons.map(String) : [],
    flags: row.flags,
    fuelAmount: numberFieldOrNull(row.fuelAmount) ?? 0,
    legs: row.legs.map(readStoredLeg),
    mode: row.mode,
    modeReason: String(row.modeReason ?? ""),
    paidKm: numberFieldOrNull(row.paidKm) ?? 0,
    singleDestinationFuelAmount: numberFieldOrNull(row.singleDestinationFuelAmount) ?? 0,
  };
}

type CapturedPoint = { capturedAt: string | null; latitude: number | null; longitude: number | null };

function usablePoint(point: CapturedPoint | null | undefined): point is CapturedPoint & { latitude: number; longitude: number } {
  return Boolean(
    point &&
      point.latitude != null &&
      point.longitude != null &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      !(point.latitude === 0 && point.longitude === 0),
  );
}

/**
 * Where the drive to the NEXT stop starts: the last stop; else the departure photo when it exists
 * and was taken before now (he left the first place from there); else the arrival photo. Null when
 * none of them carries a usable position — the service then refuses the capture.
 */
export function pickJourneyLegOrigin(input: {
  arrival: CapturedPoint;
  departure: CapturedPoint | null;
  stops: OutstationJourneyStop[];
  nowIso: string;
}): (CapturedPoint & { kind: JourneyLegOrigin; latitude: number; longitude: number }) | null {
  const last = [...input.stops].sort((a, b) => a.stopNumber - b.stopNumber).at(-1);
  if (last) {
    return { capturedAt: last.capturedAt, kind: "stop", latitude: last.latitude, longitude: last.longitude };
  }
  const now = instantMs(input.nowIso);
  const departure = input.departure;
  const departureAt = instantMs(departure?.capturedAt ?? null);
  if (usablePoint(departure) && departureAt != null && (now == null || departureAt <= now)) {
    return { ...departure, kind: "departure" };
  }
  const arrival = input.arrival;
  if (usablePoint(arrival)) return { ...arrival, kind: "arrival" };
  return null;
}

/** The Cairo days a journey's stops fall on. */
export function journeyStopDays(stops: OutstationJourneyStop[]): string[] {
  const days = stops.map((stop) => cairoDateOnly(stop.capturedAt)).filter((day): day is string => Boolean(day));
  return [...new Set(days)].sort();
}

/**
 * The hold reason for a NEW car trip filed for a day another journey already reached through a
 * stop — the other half of the double-pay check (the journey side is `another_trip_same_day`).
 * Null when no such journey exists.
 */
export function journeyOverlapHoldReason(input: {
  tripStartDate: string;
  tripEndDate: string;
  journeys: Array<{ id: number; stopDays: string[] }>;
}): string | null {
  const first = dateOnly(input.tripStartDate);
  const last = dateOnly(input.tripEndDate) ?? first;
  if (!first || !last) return null;
  const hits = input.journeys
    .map((journey) => ({ days: journey.stopDays.filter((day) => day >= first && day <= last), id: journey.id }))
    .filter((journey) => journey.days.length > 0);
  if (hits.length === 0) return null;
  const named = hits.map((hit) => `#${hit.id} (${hit.days.join(", ")})`).join(", ");
  return (
    `Trip ${named} already reached this day through an added stop, so this trip's drive may be paid twice. ` +
    "It is held for Super Admin review before it moves to payroll."
  );
}

/**
 * The claim's totals once the fuel changes. The travel cost and the claim each move by exactly the
 * fuel's change, so a ticket, a typed travel cost or a claim figure that differed from the computed
 * one keeps its difference — and fuel + allowance + tickets + meeting + other still equals the
 * claim, which the expense_claims rebuild checks before it will mirror a row.
 */
export function rebaseClaimOnNewFuel(input: {
  fuelAmount: number;
  ticketAmount: number;
  reportTravelCost: number | null;
  expectedTotalAmount: number;
  claimedTotalAmount: number;
  newFuelAmount: number;
  /** The expected total the app's own formula gives for a travel cost (0 for a not-eligible trip). */
  expectedTotalFor: (travelCost: number) => number;
}): { fuelAmount: number; reportTravelCost: number; expectedTotalAmount: number; claimedTotalAmount: number } {
  const fuelDelta = roundMoney(input.newFuelAmount - input.fuelAmount);
  const travelBefore = input.reportTravelCost ?? roundMoney(input.fuelAmount + input.ticketAmount);
  const reportTravelCost = roundMoney(Math.max(0, travelBefore + fuelDelta));
  const expectedTotalAmount = roundMoney(input.expectedTotalFor(reportTravelCost));
  const expectedDelta = roundMoney(expectedTotalAmount - input.expectedTotalAmount);
  const claimedTotalAmount =
    input.claimedTotalAmount > 0
      ? roundMoney(Math.max(0, input.claimedTotalAmount + expectedDelta))
      : expectedTotalAmount;
  return { claimedTotalAmount, expectedTotalAmount, fuelAmount: roundMoney(input.newFuelAmount), reportTravelCost };
}

/**
 * The claim's totals once a stop's ticket joins it — the same arithmetic as an extra ticket, so a
 * trip without a car comes out the same whichever way the ticket arrived. No fuel moves.
 */
export function rebaseClaimOnStopTicket(input: {
  addedTicketAmount: number;
  fuelAmount: number;
  ticketAmount: number;
  reportTravelCost: number | null;
  claimedTotalAmount: number;
  expectedTotalFor: (travelCost: number) => number;
}): { ticketAmount: number; reportTravelCost: number; expectedTotalAmount: number; claimedTotalAmount: number } {
  const added = roundMoney(Math.max(0, input.addedTicketAmount));
  const travelBefore = input.reportTravelCost ?? roundMoney(input.fuelAmount + input.ticketAmount);
  const reportTravelCost = roundMoney(travelBefore + added);
  const expectedTotalAmount = roundMoney(input.expectedTotalFor(reportTravelCost));
  return {
    claimedTotalAmount:
      input.claimedTotalAmount > 0 ? roundMoney(input.claimedTotalAmount + added) : expectedTotalAmount,
    expectedTotalAmount,
    reportTravelCost,
    ticketAmount: roundMoney(input.ticketAmount + added),
  };
}
