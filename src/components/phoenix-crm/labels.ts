/**
 * Phoenix CRM — the words the screens use for a customer, a territory and a month's visits, so every
 * tab says the same thing the same way.
 */

import { dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import type { PillTone } from "@/components/phoenix-crm/ui";
import { PHOENIX_CRM_LIST_SINGULAR, type PhoenixCrmGrade, type PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { TerritorySummary } from "@/lib/phoenix-crm/view-types";

/** A search over what a row shows: every word typed must appear somewhere in it, in any order. */
export function matchesWords(query: string, parts: ReadonlyArray<string | null | undefined>): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = parts.filter((part): part is string => Boolean(part)).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/** "Doctor · PM", "Account · AM". */
export function listText(listType: PhoenixCrmListType): string {
  return `${PHOENIX_CRM_LIST_SINGULAR[listType]} · ${listType}`;
}

/** "Faisal · Pedia · Mona Adel" — the territory by its place, line and rep, never its seat code. */
export function territoryLine(territory: TerritorySummary): string {
  return `${territory.name} · ${territory.repName ?? "No rep in this territory"}`;
}

/** "Doctor · PM · Grade B · Internal Medicine". */
export function customerMetaText(customer: { listType: PhoenixCrmListType; grade: PhoenixCrmGrade | null; speciality: string | null }): string {
  return [listText(customer.listType), customer.grade ? `Grade ${customer.grade}` : "No grade", customer.speciality]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** A place by what the rep called it, else its part of town or brick, else its order on the customer. */
export function placeName(place: { label: string | null; zone: string | null; brickName: string | null }, index: number): string {
  return place.label ?? place.zone ?? place.brickName ?? `Place ${index + 1}`;
}

/**
 * A customer carried over from iReports360 and not validated yet, said the same way on every screen.
 *
 * Owner, 2026-09-22: he plans him, he visits him, nothing stops him. The one thing that is true and
 * worth saying is what validating buys — so the sentence states a fact with the fix inside it, and
 * never says cannot, must, blocked or missing.
 */
export const PENDING_PILL = "Not validated yet";
export const PENDING_COUNTS_NOTE = "Your visits here start counting once you validate.";

/** "12 customers not validated yet — plan them and visit them as normal." */
export function pendingListNote(count: number): string {
  return `${plural(count, "customer", "customers")} not validated yet — plan them and visit them as normal. Validate each one at the clinic and its visits start counting.`;
}

/** "3 visits saved here, not counting yet" — never "not visited this month", which would be a lie. */
export function pendingVisitsText(visits: number): string {
  if (visits <= 0) return "No visits saved here yet";
  return `${plural(visits, "visit", "visits")} saved here, not counting yet`;
}

/** Where iReports360 says a carried-over customer is — all the rep has to find him by before he validates. */
export function referenceAddressText(reference: { address: string | null; city: string | null; zone: string | null } | null): string | null {
  if (!reference) return null;
  const parts = [reference.address, reference.zone, reference.city].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "14 Sep 2026" — the last visit iReports360 holds on a carried-over customer. */
export function referenceLastVisitText(reference: { lastVisitedOn: string | null } | null): string {
  const day = reference?.lastVisitedOn ?? null;
  return day ? dayLabelWithYear(day) : "None recorded";
}

/** "2 of 3 visits this month"; a customer with no grade has no number to meet. */
export function monthVisitsText(visits: number, target: number | null): string {
  return target === null ? `${plural(visits, "visit", "visits")} this month` : `${visits} of ${target} visits this month`;
}

/**
 * Where a customer stands in the running month against its grade's visits. Owner rules: over-visiting
 * is a deviation too, never shown green; and a running month can still be caught up, so "not visited
 * yet" is not painted as a failure.
 */
export function monthStanding(visits: number, target: number | null): { label: string; tone: PillTone } {
  if (visits <= 0) return { label: "Not visited this month", tone: "neutral" };
  if (target === null) return { label: "Visited this month", tone: "neutral" };
  if (visits < target) return { label: "Behind its grade", tone: "warn" };
  if (visits === target) return { label: "On its grade", tone: "good" };
  return { label: "Over its grade", tone: "warn" };
}
