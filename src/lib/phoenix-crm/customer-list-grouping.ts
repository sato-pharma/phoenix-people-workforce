/**
 * Phoenix CRM — grouping and filtering for the List tab's customer parts (To validate, Customers,
 * Left the list). Pure, so it is tested without React: the same brick grouping the board uses, but
 * over the CRM's own `ListCustomer` rather than the iReports360 mirror.
 *
 * Owner, 2026-09-25: the whole List tab reads the same way — bricks in colour, one group per brick,
 * the unmapped localities kept apart and named. This is the half of that a test can hold to.
 */

import type { ListCustomer } from "@/lib/phoenix-crm/view-types";

export const NO_GRADE = "No grade";
export const UNSPECIFIED = "Unspecified";

/** One brick or one unmapped locality, with the customers that fall in it. */
export type CustomerGroup = {
  /** Stable key — the brick id for a mapped brick, else a lowered locality name, else "none". */
  key: string;
  heading: string;
  areaName: string | null;
  /** True when this is a real brick; false for a locality nobody has mapped to one yet. */
  mapped: boolean;
  customers: ListCustomer[];
};

export const gradeOf = (customer: ListCustomer): string => customer.grade?.trim() || NO_GRADE;
export const specialityOf = (customer: ListCustomer): string => customer.speciality?.trim() || UNSPECIFIED;

/**
 * Which group a customer belongs to. His first place decides it — a validated customer has one, and
 * where he has several the first is the one the rep entered first. A customer with no place yet (he
 * is pending) is grouped by the locality iReports360 knows, so he still lands under a heading rather
 * than in one grey run. Nothing left to say → "No location yet", kept last.
 */
export function groupOf(customer: ListCustomer): Omit<CustomerGroup, "customers"> {
  const place = customer.places[0] ?? null;
  if (place?.brickId) {
    return { key: place.brickId, heading: place.brickName ?? place.brickId, areaName: place.areaName, mapped: true };
  }
  const locality = place?.zone ?? place?.brickName ?? customer.reference?.city ?? customer.reference?.zone ?? null;
  if (locality) {
    return { key: `loc:${locality.toLowerCase()}`, heading: locality, areaName: place?.areaName ?? null, mapped: false };
  }
  return { key: "none", heading: "No location yet", areaName: null, mapped: false };
}

/** Accounts (AM) before doctors (PM), then by name — the order a rep's own list keeps. */
export function byTypeThenName(left: ListCustomer, right: ListCustomer): number {
  if (left.listType !== right.listType) return left.listType === "AM" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

/**
 * Build the groups in the order the customers first name them, so a brick's hue never moves as a
 * filter narrows the board — the colour is keyed off this order, not off what is on screen.
 */
export function buildGroups(customers: readonly ListCustomer[]): CustomerGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, CustomerGroup>();
  for (const customer of customers) {
    const g = groupOf(customer);
    let group = byKey.get(g.key);
    if (!group) {
      group = { ...g, customers: [] };
      byKey.set(g.key, group);
      order.push(g.key);
    }
    group.customers.push(customer);
  }
  const groups = order.map((key) => byKey.get(key) as CustomerGroup);
  for (const group of groups) group.customers.sort(byTypeThenName);
  return groups;
}

/** Real bricks first, then unmapped localities, then "No location yet" last — territories before gaps. */
export function displayOrder(groups: readonly CustomerGroup[]): CustomerGroup[] {
  const rank = (group: CustomerGroup): number => (group.key === "none" ? 2 : group.mapped ? 0 : 1);
  return [...groups].sort((left, right) => rank(left) - rank(right) || left.heading.localeCompare(right.heading));
}

/** Distinct filter options, real values first and the placeholders ("No grade", "Unspecified") last. */
export function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>(values);
  return [...seen].sort((left, right) => {
    const placeholder = (value: string) => (value === NO_GRADE || value === UNSPECIFIED ? 1 : 0);
    return placeholder(left) - placeholder(right) || left.localeCompare(right);
  });
}

export function matchesQuery(customer: ListCustomer, needle: string): boolean {
  if (!needle) return true;
  const hay = [
    customer.name,
    customer.speciality,
    customer.grade,
    customer.reference?.address ?? null,
    customer.reference?.city ?? null,
    customer.reference?.zone ?? null,
    ...customer.places.flatMap((place) => [place.label, place.address, place.zone, place.brickName]),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

/** The activity filter's two answers, read off the running month's visits. */
export function matchesActivity(customer: ListCustomer, choice: string): boolean {
  if (!choice) return true;
  if (choice === "unvisited") return customer.visitsThisMonth <= 0;
  return customer.visitsThisMonth > 0;
}
