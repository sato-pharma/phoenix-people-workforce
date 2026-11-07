/**
 * Phoenix CRM — who to plan on a day, with no I/O.
 *
 * Owner, 2026-09-16: the rep places the doctors; the system only assists. Picking a day shows the
 * customers who receive that day, uncovered first, and helps with "all doctors in a given place" and
 * "all doctors who can fit in the same day". Customers who do not receive that day can still be placed
 * — the planner then asks for an exception reason (plan-rules.ts).
 *
 * Order (decision 2026-09-16): receives that day → uncovered first (not visited this month, then
 * behind its grade) → same brick, then same zone, as the customers already placed that day → the time
 * window fits around the ones already placed → nearest → earliest window → name.
 *
 * Owner, 2026-09-22: a customer carried over from iReports360 and not validated yet has no place and
 * no days and hours, so there is nothing to rank him on. He is offered plainly, once, after the
 * customers who can be ranked — never hidden, never faked a place.
 */

import { coverageTier, gradeTarget, type CoverageTier } from "@/lib/phoenix-crm/coverage";
import { distanceMeters } from "@/lib/phoenix-crm/geo";
import { windowsForWeekday } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType, PhoenixCrmSettings, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

export type PlannerPlace = {
  placeId: string;
  label: string | null;
  /** The clean street address resolved at capture, shown while the rep builds his plan. */
  address: string | null;
  lat: number;
  lon: number;
  brick: string | null;
  zone: string | null;
  timings: PhoenixCrmTiming[];
  /**
   * The polyclinic, centre or hospital outpatient suite a seated place sits in, with its name, and the
   * session (AM or PM) this customer receives in there (owner, 2026-10-10). All null/absent on a clinic
   * of his own, which follows the customer's list.
   */
  sharedPlaceId?: string | null;
  sharedPlaceName?: string | null;
  session?: PhoenixCrmDoctorListType | null;
};

/**
 * The list a customer is PLANNED and COUNTED in (owner, 2026-10-10): the session of the building he is
 * seated in when he has one, otherwise his own list. A customer in a polyclinic is added as AM or PM,
 * and choosing AM on the plan shows only that building's AM customers. A customer with several
 * seatings is read by the first, which is the one the plan sends; the database files each visit under
 * its own place's session, so this only decides where he is SHOWN.
 */
export function effectiveListType(
  listType: PhoenixCrmDoctorListType,
  places: ReadonlyArray<{ session?: PhoenixCrmDoctorListType | null }>,
): PhoenixCrmDoctorListType {
  return places.find((place) => place.session === "AM" || place.session === "PM")?.session ?? listType;
}

/**
 * Where a customer not validated yet sits, shown on the plan board in the place a validated customer's
 * clinic would fill (owner, 2026-09-30: "in their blank put brick and address").
 *
 * 🔴 THE BRICK AND AREA ARE THE ORGANOGRAM'S, NEVER iReports360's (owner, 2026-09-30: "there is a big
 * mismatch between area and region names — audit and follow the organogram"). iReports360 keeps its own
 * vocabulary in `crm_contacts.zone` and `.city`, and it is a DIFFERENT one: measured on production that
 * day, of 18,954 customers on a mapped brick only 729 — 3.8% — carried an area name the organogram
 * agrees with, 9,688 disagreed ("Monofia III" for Menoufia 2, "El Menia II" for Minia 2, "Behira II"
 * for Behira 2, "Delta West" for Delta (1)) and 8,537 had none at all; 37 of 39 areas disagreed. So
 * `zone` and `city` are never shown. The brick and area come from the sales master, which agrees with
 * the organogram on all 40 area names, and `address` is iReports360's town text only.
 */
export type PlannerReference = { brick: string | null; area: string | null; address: string | null };

/**
 * What the plan board tells the rep about a customer beyond his list row (owner, 2026-10-02) — read and
 * used by plan-insight.ts: his last visit on every row, iReports360's usual days while he has no days
 * of his own, and a follow-up his latest visit left due.
 */
export type PlannerInsight = {
  /** The latest of his iReports360 history and his own Phoenix visits. Null when neither holds one. */
  lastSeenOn: string | null;
  /**
   * The real time of that last visit, when it was his own Phoenix visit — never an iReports360 copy, which has
   * no clock. Shown only while "Show visit times" is on (owner, 2026-11-05). Absent or null: the day alone.
   */
  lastVisitAt?: string | null;
  /**
   * The weekdays his iReports360 visits usually fell on (0 = Sunday … 6 = Saturday, Saturday first),
   * read only while he has no saved days and hours. Null once he has them, or when nothing is known.
   */
  usualWeekdays: number[] | null;
  /** The day his LATEST visit's next step is due, when it left something to do with a date. */
  followUpOn: string | null;
};

export type PlannerCustomer = {
  customerId: string;
  name: string;
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  visitsThisMonth: number;
  /** Carried over from iReports360 and not validated yet: no place and no days and hours. */
  pending: boolean;
  /**
   * A clinic doctor he added with one or two names (owner, 2026-11-07, pm-name-rules.ts): shown on
   * the board, never ticked, suggested or copied until he writes the full name.
   */
  needsFullName?: boolean;
  places: PlannerPlace[];
  /** iReports360's brick and address while he is not validated yet; null once he has a place. */
  reference?: PlannerReference | null;
  /**
   * His last visit, his usual days and a follow-up due (plan-insight.ts). Absent or null when the reads
   * behind it did not answer: the row then says nothing about it rather than something untrue.
   */
  insight?: PlannerInsight | null;
};

export type PlacedOnDay = {
  customerId: string;
  /** Null for a customer who is not validated yet. */
  placeId: string | null;
};

export type DaySuggestion = {
  customerId: string;
  /** Null for a customer who is not validated yet: there is no place to plan him at. */
  placeId: string | null;
  pending: boolean;
  placeLabel: string | null;
  /** The place's clean street address, so the rep sees exactly where the visit lands. */
  address: string | null;
  name: string;
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  brick: string | null;
  zone: string | null;
  receives: boolean;
  windows: PhoenixCrmTiming[];
  noRamadanTime: boolean;
  tier: CoverageTier;
  visitsThisMonth: number;
  target: number | null;
  sameBrick: boolean;
  sameZone: boolean;
  fitsTime: boolean;
  nearestPlacedKm: number | null;
  alreadyOnDay: boolean;
};

/** A window counts as fitting when it overlaps the day's planned hours widened by this much. */
const FIT_MARGIN_MINUTES = 90;

/** A brick or zone as compared: case, outer spaces and repeated spaces ignored. Null when empty. */
export function normalizeArea(value: string | null): string | null {
  const text = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return text || null;
}

function windowSpan(windows: PhoenixCrmTiming[]): { start: number; end: number } | null {
  if (windows.length === 0) return null;
  return {
    start: Math.min(...windows.map((window) => window.startMinute)),
    end: Math.max(...windows.map((window) => window.endMinute ?? window.startMinute + 60)),
  };
}

export function suggestForDay(input: {
  weekday: number;
  ramadan: boolean;
  customers: ReadonlyArray<PlannerCustomer>;
  placed: ReadonlyArray<PlacedOnDay>;
  settings: Pick<PhoenixCrmSettings, "gradeTargets">;
}): DaySuggestion[] {
  const placesById = new Map<string, PlannerPlace>();
  for (const customer of input.customers) for (const place of customer.places) placesById.set(place.placeId, place);

  const placedCustomerIds = new Set(input.placed.map((item) => item.customerId));
  const placedPlaces = input.placed
    .map((item) => (item.placeId ? placesById.get(item.placeId) : undefined))
    .filter((place): place is PlannerPlace => Boolean(place));
  const placedBricks = new Set(placedPlaces.map((place) => normalizeArea(place.brick)).filter(Boolean));
  const placedZones = new Set(placedPlaces.map((place) => normalizeArea(place.zone)).filter(Boolean));

  let daySpan: { start: number; end: number } | null = null;
  for (const place of placedPlaces) {
    const span = windowSpan(windowsForWeekday(place.timings, input.weekday, input.ramadan).windows);
    if (!span) continue;
    daySpan = daySpan ? { start: Math.min(daySpan.start, span.start), end: Math.max(daySpan.end, span.end) } : span;
  }

  const suggestions: DaySuggestion[] = [];
  for (const customer of input.customers) {
    if (customer.needsFullName) continue;
    const target = gradeTarget(input.settings, customer.listType, customer.grade);
    const tier = coverageTier(customer.visitsThisMonth, target);
    // A customer who is not validated yet has no place and no days and hours, so there is nothing to
    // rank him on and no day he is off on. He is offered plainly, once, and placed as he is.
    if (customer.pending) {
      suggestions.push({
        customerId: customer.customerId,
        placeId: null,
        pending: true,
        placeLabel: null,
        address: null,
        name: customer.name,
        listType: customer.listType,
        grade: customer.grade,
        speciality: customer.speciality,
        brick: null,
        zone: null,
        receives: true,
        windows: [],
        noRamadanTime: false,
        tier,
        visitsThisMonth: customer.visitsThisMonth,
        target,
        sameBrick: false,
        sameZone: false,
        fitsTime: false,
        nearestPlacedKm: null,
        alreadyOnDay: placedCustomerIds.has(customer.customerId),
      });
      continue;
    }
    if (customer.places.length === 0) continue;
    const receivingPlaces = customer.places.filter(
      (place) => windowsForWeekday(place.timings, input.weekday, input.ramadan).windows.length > 0,
    );
    // One row per place that receives that day; a customer who receives nowhere that day gets one row.
    const candidates = receivingPlaces.length > 0 ? receivingPlaces : customer.places.slice(0, 1);
    for (const place of candidates) {
      const seasonal = windowsForWeekday(place.timings, input.weekday, input.ramadan);
      const span = windowSpan(seasonal.windows);
      const fitsTime =
        span !== null &&
        (daySpan === null || (span.start <= daySpan.end + FIT_MARGIN_MINUTES && span.end >= daySpan.start - FIT_MARGIN_MINUTES));
      let nearestPlacedKm: number | null = null;
      for (const other of placedPlaces) {
        if (other.placeId === place.placeId) continue;
        const km = distanceMeters(place, other) / 1000;
        nearestPlacedKm = nearestPlacedKm === null ? km : Math.min(nearestPlacedKm, km);
      }
      const brick = normalizeArea(place.brick);
      const zone = normalizeArea(place.zone);
      suggestions.push({
        customerId: customer.customerId,
        placeId: place.placeId,
        pending: false,
        placeLabel: place.label,
        address: place.address,
        name: customer.name,
        listType: customer.listType,
        grade: customer.grade,
        speciality: customer.speciality,
        brick: place.brick,
        zone: place.zone,
        receives: seasonal.windows.length > 0,
        windows: seasonal.windows,
        noRamadanTime: seasonal.noRamadanTime,
        tier,
        visitsThisMonth: customer.visitsThisMonth,
        target,
        sameBrick: brick !== null && placedBricks.has(brick),
        sameZone: zone !== null && placedZones.has(zone),
        fitsTime,
        nearestPlacedKm: nearestPlacedKm === null ? null : Math.round(nearestPlacedKm * 10) / 10,
        alreadyOnDay: placedCustomerIds.has(customer.customerId),
      });
    }
  }

  return suggestions.sort(compareSuggestions);
}

function flag(value: boolean): number {
  return value ? 0 : 1;
}

export function compareSuggestions(left: DaySuggestion, right: DaySuggestion): number {
  return (
    flag(!left.alreadyOnDay) - flag(!right.alreadyOnDay) ||
    flag(!left.pending) - flag(!right.pending) ||
    flag(left.receives) - flag(right.receives) ||
    left.tier - right.tier ||
    flag(left.sameBrick) - flag(right.sameBrick) ||
    flag(left.sameZone) - flag(right.sameZone) ||
    flag(left.fitsTime) - flag(right.fitsTime) ||
    (left.nearestPlacedKm ?? Number.POSITIVE_INFINITY) - (right.nearestPlacedKm ?? Number.POSITIVE_INFINITY) ||
    (left.windows[0]?.startMinute ?? 9999) - (right.windows[0]?.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}
