/**
 * Phoenix CRM on an outstation trip, read day by day for the approver (owner, 2026-11-07: "I want to
 * wire the Phoenix CRM with the expense module and get most benefit of this integration").
 *
 * The reader (`crm-trip-evidence-reader.ts`) gathers what Phoenix CRM holds for each trip day — the
 * visits with their places, the week plan and its day status, the manager's plan, a planned
 * ride-along, the activities he logged, the next morning's Day Start, the open location warnings,
 * and anyone he visited with who claimed a car for the same day. This module turns that into what
 * an approver reads, and nothing here moves money:
 *
 *   - where he really was: each day's visits measured from home and from the claimed destination
 *     (`whereabouts`), and a day whose visits were all back home on a real outstation trip;
 *   - was it planned: the day's plan status asked DAY BY DAY (the reader uses `planDayStatus`),
 *     the planned places and their area, a planned activity, the manager's planned day;
 *   - the nights: the last visit saved on the evening and the first position the next morning;
 *   - the kilometres: the farthest place he visited, from home, beside the kilometres claimed;
 *   - the days with nothing in Phoenix CRM at all.
 *
 * A visit's saved time is WHEN HE SAVED IT, not when he was at the door (phoenix-crm-boards rule),
 * so it is printed as "saved", never read as an arrival time. Distances are straight lines, so a
 * road claim is only ever "needs a look", never wrong.
 *
 * Pure, so every verdict is pinned on behaviour without a database.
 */

import { haversineKm } from "@/lib/sales/normalizer/geo-validate";

/** Within this of home, a position is "at home" (a town and its edge). */
export const CRM_HOME_RADIUS_KM = 25;
/** Within this of the claimed destination, a position is "at the destination". */
export const CRM_DESTINATION_RADIUS_KM = 40;
/** A trip whose destination is nearer home than this is not far enough for a "back home" day to mean anything. */
export const CRM_OUTSTATION_MIN_KM = 60;
/** A claimed one-way distance is a look when it exceeds the farthest visit × this + `CRM_KM_SLACK`. */
export const CRM_KM_ROAD_FACTOR = 1.5;
export const CRM_KM_SLACK = 30;

export type CrmPoint = { lat: number; lon: number };

export type CrmTripVisit = {
  area: string | null;
  brick: string | null;
  customer: string | null;
  /** Where the visit was captured, else its place's pin. */
  point: CrmPoint | null;
  place: string | null;
  region: string | null;
  /** When he SAVED it (ISO). */
  savedAt: string | null;
  unplanned: boolean;
  /** "far", "no_fix" … as Phoenix CRM stamped the capture; null when it was fine. */
  locationFlag: string | null;
};

export type CrmPlanStatus = "draft" | "submitted" | "approved" | "returned";

export type CrmTripDayInput = {
  date: string;
  visits: CrmTripVisit[];
  /** The rep's week plan for this day; null when he has no plan row for the week. */
  plan: {
    status: CrmPlanStatus | null;
    places: Array<{ area: string | null; brick: string | null; label: string | null }>;
    activities: string[];
  } | null;
  /** A manager's own planned day, as Phoenix CRM words it; null for a rep or with no plan. */
  managerPlan: { sent: boolean; statusLine: string; lines: string[] } | null;
  /** Names of the people a ride-along was planned with that day. */
  rideAlongsPlanned: string[];
  /** Day activities he logged ("Travelling", "Meeting" …). */
  activitiesLogged: string[];
  /** His Day Start that morning. */
  dayStart: { at: string; point: CrmPoint | null } | null;
  /** Someone he visited with that day who ALSO claimed a car trip covering it. */
  sharedCar: Array<{ name: string; requestId: number }>;
};

export type CrmTripInput = {
  claimedKm: number | null;
  destination: CrmPoint | null;
  days: CrmTripDayInput[];
  home: CrmPoint | null;
  /** His Day Start the morning AFTER the trip — read only for the last night, never a trip day. */
  morningAfter?: { at: string; point: CrmPoint | null } | null;
  /**
   * Trip days before this person's team was counted from Phoenix CRM: the old system holds that day's field
   * work (the Field work section), so "nothing in Phoenix CRM" there is no signal at all.
   */
  beforePhoenix?: ReadonlyArray<string>;
  /** Open (unsettled) location warnings on the trip days, already narrowed to what this viewer may read. */
  warnings: Array<{ label: string; strong: boolean }>;
  isCar: boolean;
};

export type CrmWhereabouts = "destination" | "home" | "elsewhere" | "mixed" | "unknown" | "none";

export type CrmNightReading = {
  /** The evening's last saved visit. */
  lastSavedAt: string | null;
  /** The next morning's first position: the Day Start, else the first visit. */
  nextMorningAt: string | null;
  nextMorningKmFromDestination: number | null;
  nextMorningKmFromHome: number | null;
  verdict: "stayed" | "home" | "unknown";
};

export type CrmDayReading = {
  date: string;
  visits: Array<CrmTripVisit & { kmFromDestination: number | null; kmFromHome: number | null }>;
  whereabouts: CrmWhereabouts;
  /** The areas his visits were in, distinct, in order. */
  areas: string[];
  plan: CrmTripDayInput["plan"];
  planned: boolean;
  managerPlan: CrmTripDayInput["managerPlan"];
  rideAlongsPlanned: string[];
  activitiesLogged: string[];
  dayStart: (CrmTripDayInput["dayStart"] & { kmFromDestination: number | null }) | null;
  sharedCar: CrmTripDayInput["sharedCar"];
  /** Before the team was counted from Phoenix CRM — never empty, never unplanned, never a signal. */
  beforePhoenix: boolean;
  /** Nothing at all in Phoenix CRM: no visit, no plan, no activity, no Day Start. */
  nothingInCrm: boolean;
  /** The night after this day, when the trip has one. */
  night: CrmNightReading | null;
};

export type CrmTripReading = {
  days: CrmDayReading[];
  homeDays: string[];
  emptyDays: string[];
  unplannedDays: string[];
  farthestKmFromHome: number | null;
  km: { claimed: number; farthest: number; needsLook: boolean } | null;
  warnings: CrmTripInput["warnings"];
  sharedCarDays: string[];
  signal: { sentence: string; tone: "danger" | "neutral" | "ok" | "warn" };
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function kmBetween(a: CrmPoint | null, b: CrmPoint | null): number | null {
  if (!a || !b) return null;
  return round1(haversineKm(a.lat, a.lon, b.lat, b.lon));
}

function distinct(values: ReadonlyArray<string | null>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = (value ?? "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function whereaboutsOf(
  visits: ReadonlyArray<{ kmFromDestination: number | null; kmFromHome: number | null }>,
): CrmWhereabouts {
  if (visits.length === 0) return "none";
  const kinds = new Set<Exclude<CrmWhereabouts, "mixed" | "none">>();
  for (const visit of visits) {
    if (visit.kmFromDestination !== null && visit.kmFromDestination <= CRM_DESTINATION_RADIUS_KM) kinds.add("destination");
    else if (visit.kmFromHome !== null && visit.kmFromHome <= CRM_HOME_RADIUS_KM) kinds.add("home");
    else if (visit.kmFromDestination === null && visit.kmFromHome === null) kinds.add("unknown");
    else kinds.add("elsewhere");
  }
  kinds.delete("unknown");
  if (kinds.size === 0) return "unknown";
  if (kinds.size > 1) return "mixed";
  return [...kinds][0];
}

function bySaved<T extends { savedAt: string | null }>(visits: ReadonlyArray<T>): T[] {
  return [...visits]
    .filter((visit) => visit.savedAt && Number.isFinite(Date.parse(visit.savedAt)))
    .sort((left, right) => Date.parse(left.savedAt!) - Date.parse(right.savedAt!));
}

export function buildCrmTripEvidence(input: CrmTripInput): CrmTripReading {
  const homeToDestination = kmBetween(input.home, input.destination);
  const realOutstation = homeToDestination !== null && homeToDestination >= CRM_OUTSTATION_MIN_KM;
  const days = [...input.days].sort((left, right) => left.date.localeCompare(right.date));

  const before = new Set(input.beforePhoenix ?? []);
  const readings: CrmDayReading[] = days.map((day) => {
    const beforePhoenix = before.has(day.date);
    const visits = day.visits.map((visit) => ({
      ...visit,
      kmFromDestination: kmBetween(visit.point, input.destination),
      kmFromHome: kmBetween(visit.point, input.home),
    }));
    const planned = Boolean(
      (day.plan && (day.plan.status === "submitted" || day.plan.status === "approved") &&
        (day.plan.places.length > 0 || day.plan.activities.length > 0)) ||
        day.managerPlan?.sent,
    );
    return {
      activitiesLogged: day.activitiesLogged,
      areas: distinct(visits.map((visit) => visit.area)),
      beforePhoenix,
      date: day.date,
      dayStart: day.dayStart ? { ...day.dayStart, kmFromDestination: kmBetween(day.dayStart.point, input.destination) } : null,
      managerPlan: day.managerPlan,
      night: null,
      nothingInCrm:
        !beforePhoenix &&
        day.visits.length === 0 &&
        day.activitiesLogged.length === 0 &&
        !day.dayStart &&
        !(day.plan && (day.plan.places.length > 0 || day.plan.activities.length > 0)) &&
        !day.managerPlan?.sent,
      plan: day.plan,
      planned,
      rideAlongsPlanned: day.rideAlongsPlanned,
      sharedCar: day.sharedCar,
      visits,
      whereabouts: whereaboutsOf(visits),
    };
  });

  // The night after each day: the evening's last saved visit, then the next morning's first
  // position — the Day Start when it was pressed, else the first visit saved. The last day's night
  // is read only when the Day Start of the morning after the trip is known.
  for (let index = 0; index < readings.length; index += 1) {
    const evening = readings[index];
    const morning = readings[index + 1] ?? null;
    if (!morning && !input.morningAfter) continue;
    const lastSaved = bySaved(evening.visits).at(-1)?.savedAt ?? null;
    const firstVisit = morning ? (bySaved(morning.visits)[0] ?? null) : null;
    const morningStart = morning ? morning.dayStart : (input.morningAfter ?? null);
    const morningPoint = morningStart?.point ?? firstVisit?.point ?? null;
    const morningAt = morningStart?.at ?? firstVisit?.savedAt ?? null;
    const fromDestination = kmBetween(morningPoint, input.destination);
    const fromHome = kmBetween(morningPoint, input.home);
    evening.night = {
      lastSavedAt: lastSaved,
      nextMorningAt: morningPoint ? morningAt : null,
      nextMorningKmFromDestination: fromDestination,
      nextMorningKmFromHome: fromHome,
      verdict:
        fromDestination !== null && fromDestination <= CRM_DESTINATION_RADIUS_KM
          ? "stayed"
          : realOutstation && fromHome !== null && fromHome <= CRM_HOME_RADIUS_KM
            ? "home"
            : "unknown",
    };
  }

  const homeDays = realOutstation ? readings.filter((day) => day.whereabouts === "home").map((day) => day.date) : [];
  const emptyDays = readings.filter((day) => day.nothingInCrm).map((day) => day.date);
  const unplannedDays = readings.filter((day) => !day.planned && !day.beforePhoenix).map((day) => day.date);
  const sharedCarDays = input.isCar ? readings.filter((day) => day.sharedCar.length > 0).map((day) => day.date) : [];

  const fromHome = readings.flatMap((day) => [
    ...day.visits.map((visit) => visit.kmFromHome),
    kmBetween(day.dayStart?.point ?? null, input.home),
  ]);
  const farthest = fromHome.reduce<number | null>((max, km) => (km === null ? max : max === null ? km : Math.max(max, km)), null);
  const claimed = Number(input.claimedKm);
  const km =
    farthest !== null && farthest > 0 && Number.isFinite(claimed) && claimed > 0
      ? { claimed, farthest, needsLook: input.isCar && claimed > farthest * CRM_KM_ROAD_FACTOR + CRM_KM_SLACK }
      : null;
  const strongWarnings = input.warnings.filter((warning) => warning.strong).length;
  const nightsHome = readings.filter((day) => day.night?.verdict === "home").length;

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  let signal: CrmTripReading["signal"];
  const allBefore = readings.length > 0 && readings.every((day) => day.beforePhoenix);
  if (allBefore) {
    signal = { sentence: "Before Phoenix CRM · the old system's visits are under Field work", tone: "neutral" };
  } else if (homeDays.length > 0) {
    signal = { sentence: `${plural(homeDays.length, "trip day")} with every visit back home`, tone: "danger" };
  } else if (strongWarnings > 0) {
    signal = { sentence: `${plural(strongWarnings, "strong location warning")} on the trip days`, tone: "danger" };
  } else if (nightsHome > 0) {
    signal = { sentence: `${plural(nightsHome, "night")} with the next morning back home`, tone: "warn" };
  } else if (km?.needsLook) {
    signal = { sentence: `${Math.round(km.claimed)} km claimed · the farthest visit is ${Math.round(km.farthest)} km from home`, tone: "warn" };
  } else if (sharedCarDays.length > 0) {
    signal = { sentence: `A car also claimed by a visit partner on ${plural(sharedCarDays.length, "day")}`, tone: "warn" };
  } else if (emptyDays.length > 0) {
    signal = { sentence: `Nothing in Phoenix CRM on ${plural(emptyDays.length, "trip day")}`, tone: "warn" };
  } else if (input.warnings.length > 0) {
    signal = { sentence: `${plural(input.warnings.length, "location warning")} on the trip days`, tone: "warn" };
  } else if (unplannedDays.length > 0) {
    signal = { sentence: `${plural(unplannedDays.length, "trip day")} not in a sent plan`, tone: "neutral" };
  } else {
    signal = { sentence: "Planned, visited at the destination", tone: "ok" };
  }

  return {
    days: readings,
    emptyDays,
    farthestKmFromHome: farthest,
    homeDays,
    km,
    sharedCarDays,
    signal,
    unplannedDays,
    warnings: input.warnings,
  };
}
