/**
 * Phoenix CRM — narrowing the doctor list while planning a day, with no I/O.
 *
 * Owner, 2026-09-25: when the rep places a day he can filter the list by brick, by "receives on this
 * day between X and Y", by AM or PM, and — browsing the whole month as a doctor book — by grade and
 * speciality. These are independent narrowings, each satisfied by ANY of a customer's places (a doctor
 * with a clinic in the brick and another that receives on the day still shows). A customer not validated
 * yet has no brick and no days and hours, so a brick or day filter leaves him out; the AM / PM, grade
 * and speciality filters read his own fields.
 */

import { normalizeArea, type PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { receivesInRange } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";

export type DoctorSessionFilter = "all" | PhoenixCrmListType;

export type DoctorFilter = {
  /** "all", or one list type. */
  session: DoctorSessionFilter;
  /** A normalized brick (normalizeArea), or null for any brick. */
  brick: string | null;
  /** One grade, or null for any grade. */
  grade: PhoenixCrmGrade | null;
  /** One speciality (exact), or null for any speciality. */
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
    filter.grade !== null ||
    filter.speciality !== null ||
    filter.weekday !== null
  );
}

/** The bricks a set of customers cover, for the brick picker: normalized value with a display label. */
export function plannerBricks(customers: ReadonlyArray<PlannerCustomer>): Array<{ value: string; label: string }> {
  const byValue = new Map<string, string>();
  for (const customer of customers) {
    for (const place of customer.places) {
      const value = normalizeArea(place.brick);
      if (place.brick !== null && value !== null && !byValue.has(value)) byValue.set(value, place.brick.trim());
    }
  }
  return [...byValue.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

/** The grades present on a set of customers, in A → B → C order, for the grade picker. */
export function plannerGrades(customers: ReadonlyArray<PlannerCustomer>): PhoenixCrmGrade[] {
  const present = new Set(customers.map((customer) => customer.grade).filter((grade): grade is PhoenixCrmGrade => grade !== null));
  return (["A", "B", "C"] as const).filter((grade) => present.has(grade));
}

/** The specialities present on a set of customers, sorted, for the speciality picker. */
export function plannerSpecialities(customers: ReadonlyArray<PlannerCustomer>): string[] {
  const present = new Set(customers.map((customer) => customer.speciality?.trim()).filter((value): value is string => Boolean(value)));
  return [...present].sort((left, right) => left.localeCompare(right));
}

function matchesBrick(customer: PlannerCustomer, brick: string): boolean {
  return customer.places.some((place) => normalizeArea(place.brick) === brick);
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
    if (filter.grade !== null && customer.grade !== filter.grade) return false;
    if (filter.speciality !== null && (customer.speciality?.trim() ?? null) !== filter.speciality) return false;
    if (!matchesDay(customer, filter)) return false;
    return true;
  });
}
