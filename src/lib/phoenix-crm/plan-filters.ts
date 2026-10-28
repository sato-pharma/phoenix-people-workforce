/**
 * Phoenix CRM — narrowing the doctor list while planning a day, with no I/O.
 *
 * Owner, 2026-09-25: when the rep places a day he can filter the list by brick, by "receives on this
 * day between X and Y", by AM or PM, and — browsing the whole month as a doctor book — by grade and
 * speciality. These are independent narrowings, each satisfied by ANY of a customer's places (a doctor
 * with a clinic in the brick and another that receives on the day still shows). A customer not validated
 * yet has no days and hours, so a day filter leaves him out; his brick is iReports360's (the list groups
 * him under it, so the brick filter reads it too — owner walk, 2026-10-28), and the AM / PM, grade and
 * speciality filters read his own fields.
 */

import { foldSearchText } from "@/lib/phoenix-crm/name-fold";
import { normalizeArea, type PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { receivesInRange } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";

export type DoctorSessionFilter = "all" | PhoenixCrmListType;

export type DoctorFilter = {
  /** "all", or one list type. */
  session: DoctorSessionFilter;
  /** A normalized brick (normalizeArea), or null for any brick. */
  brick: string | null;
  /**
   * One polyclinic, centre or hospital outpatient suite (its id), or null for any (owner, 2026-10-10:
   * choosing AM there shows only that building's AM customers). Read off a customer's seated places.
   */
  venue: string | null;
  /** One grade, or null for any grade. */
  grade: PhoenixCrmGrade | null;
  /** One speciality, its spellings folded together (specialityKey), or null for any speciality. */
  speciality: string | null;
  /** 0 = Sunday … 6 = Saturday, or null for any day. */
  weekday: number | null;
  /** Clock minutes after midnight; read only with a weekday. Null = the open end of the range. */
  fromMinute: number | null;
  toMinute: number | null;
  /** Read the Ramadan windows when matching the day. */
  ramadan: boolean;
};

export const EMPTY_DOCTOR_FILTER: DoctorFilter = {
  session: "all",
  brick: null,
  venue: null,
  grade: null,
  speciality: null,
  weekday: null,
  fromMinute: null,
  toMinute: null,
  ramadan: false,
};

/** True when any narrowing is set — the reset control shows only then. */
export function doctorFilterActive(filter: DoctorFilter): boolean {
  return (
    filter.session !== "all" ||
    filter.brick !== null ||
    filter.venue !== null ||
    filter.grade !== null ||
    filter.speciality !== null ||
    filter.weekday !== null
  );
}

/** The bricks a customer is in: his places', and iReports360's while he is not validated yet. */
function customerBricks(customer: PlannerCustomer): Array<string | null> {
  return [...customer.places.map((place) => place.brick), customer.reference?.brick ?? null];
}

/** The bricks a set of customers cover, for the brick picker: normalized value with a display label. */
export function plannerBricks(customers: ReadonlyArray<PlannerCustomer>): Array<{ value: string; label: string }> {
  const byValue = new Map<string, string>();
  for (const customer of customers) {
    for (const brick of customerBricks(customer)) {
      const value = normalizeArea(brick);
      if (brick !== null && value !== null && !byValue.has(value)) byValue.set(value, brick.trim());
    }
  }
  return [...byValue.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

/** The polyclinics and centres customers are seated in, for the building picker. Empty when nobody is. */
export function plannerVenues(customers: ReadonlyArray<PlannerCustomer>): Array<{ value: string; label: string }> {
  const byValue = new Map<string, string>();
  for (const customer of customers) {
    for (const place of customer.places) {
      if (place.sharedPlaceId && !byValue.has(place.sharedPlaceId)) byValue.set(place.sharedPlaceId, place.sharedPlaceName?.trim() || "Polyclinic or centre");
    }
  }
  return [...byValue.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

/** The grades present on a set of customers, in A → B → C order, for the grade picker. */
export function plannerGrades(customers: ReadonlyArray<PlannerCustomer>): PhoenixCrmGrade[] {
  const present = new Set(customers.map((customer) => customer.grade).filter((grade): grade is PhoenixCrmGrade => grade !== null));
  return (["A", "B", "C"] as const).filter((grade) => present.has(grade));
}

const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e]/g;

/**
 * One speciality typed several ways (owner walk, 2026-10-28: "Uro" and "Urology" offered as two). Read on
 * production that day: Uro 43 / Urology 516, IM 103 / Internal Medicine 4,373, GP 71 / General
 * Practitioner 709, Pedia 117 / Pediatrics 2,805, Neuro and Nero / Neurology 2,262 — and "‏GP" with a
 * hidden right-to-left mark. Only plain short forms of ONE speciality; a combined "GP + Pedia" stays apart.
 */
const SPECIALITY_SAME: Readonly<Record<string, string>> = {
  uro: "urology",
  im: "internal medicine",
  gp: "general practitioner",
  ped: "pediatrics",
  pedia: "pediatrics",
  neuro: "neurology",
  nero: "neurology",
  neurologist: "neurology",
  neurological: "neurology",
};

/** The key one speciality's spellings share; null for none. For matching only — never shown. */
export function specialityKey(value: string | null | undefined): string | null {
  const folded = foldSearchText(value).replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim();
  if (!folded) return null;
  return SPECIALITY_SAME[folded] ?? folded;
}

/**
 * The specialities present on a set of customers, sorted, for the speciality picker: one choice per
 * speciality, named by the spelling most of them carry.
 */
export function plannerSpecialities(customers: ReadonlyArray<PlannerCustomer>): string[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const customer of customers) {
    const label = customer.speciality?.replace(BIDI_MARKS, "").trim();
    const key = specialityKey(label);
    if (!label || !key) continue;
    const spellings = byKey.get(key) ?? new Map<string, number>();
    spellings.set(label, (spellings.get(label) ?? 0) + 1);
    byKey.set(key, spellings);
  }
  return [...byKey.values()]
    .map((spellings) => [...spellings.entries()].sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || right.length - left.length || left.localeCompare(right))[0][0])
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The pickers' choices for a set of customers. 🔴 The day screen passes the list ON SCREEN, never the
 * whole list (owner walk, 2026-10-28: Wednesday afternoon's 7 bricks were missing from its Brick filter,
 * and morning specialities were offered there and gave 0).
 */
export function plannerFilterOptions(customers: ReadonlyArray<PlannerCustomer>): {
  bricks: Array<{ value: string; label: string }>;
  grades: PhoenixCrmGrade[];
  specialities: string[];
  venues: Array<{ value: string; label: string }>;
} {
  return {
    bricks: plannerBricks(customers).map((brick) => ({ value: brick.value, label: `Brick ${brick.label}` })),
    grades: plannerGrades(customers),
    specialities: plannerSpecialities(customers),
    venues: plannerVenues(customers),
  };
}

function matchesBrick(customer: PlannerCustomer, brick: string): boolean {
  return customerBricks(customer).some((entry) => normalizeArea(entry) === brick);
}

function matchesVenue(customer: PlannerCustomer, venue: string): boolean {
  return customer.places.some((place) => place.sharedPlaceId === venue);
}

function matchesDay(customer: PlannerCustomer, filter: DoctorFilter): boolean {
  if (filter.weekday === null) return true;
  // A clock range with no real span (missing, or backwards) means "any time that day".
  const from = filter.fromMinute ?? 0;
  const rawTo = filter.toMinute ?? 1440;
  const to = rawTo > from ? rawTo : 1440;
  const fromMinute = rawTo > from ? from : 0;
  return customer.places.some((place) => receivesInRange(place.timings, filter.weekday as number, filter.ramadan, fromMinute, to));
}

export function filterPlannerCustomers(customers: ReadonlyArray<PlannerCustomer>, filter: DoctorFilter): PlannerCustomer[] {
  return customers.filter((customer) => {
    if (filter.session !== "all" && customer.listType !== filter.session) return false;
    if (filter.brick !== null && !matchesBrick(customer, filter.brick)) return false;
    if (filter.venue !== null && !matchesVenue(customer, filter.venue)) return false;
    if (filter.grade !== null && customer.grade !== filter.grade) return false;
    if (filter.speciality !== null && specialityKey(customer.speciality) !== specialityKey(filter.speciality)) return false;
    if (!matchesDay(customer, filter)) return false;
    return true;
  });
}
