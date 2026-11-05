/**
 * Phoenix CRM — the words the screens use for a customer, a territory and a month's visits, so every
 * tab says the same thing the same way.
 */

import { dayLabel, dayLabelWithYear, plural, visitMomentText } from "@/components/phoenix-crm/format";
import type { PillTone } from "@/components/phoenix-crm/ui";
import { foldedWordsMatch } from "@/lib/phoenix-crm/name-fold";
import { followUpInWeek, usualDaysOf } from "@/lib/phoenix-crm/plan-insight";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { PHOENIX_CRM_WEEKDAY_SHORT } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { TerritorySummary } from "@/lib/phoenix-crm/view-types";

/**
 * A search over what a row shows: every word typed must appear somewhere in it, in any order, with the
 * Arabic spelling folded on both sides (مستشفى finds مستشفي, احمد finds أحمد).
 */
export function matchesWords(query: string, parts: ReadonlyArray<string | null | undefined>): boolean {
  return foldedWordsMatch(query, parts);
}

/**
 * "AM", "PM" — and nothing else. The owner's rule of 2026-09-23: Phoenix CRM calls a list type by its
 * own name on every screen, never "Doctors" or "Accounts". This function stays even though it returns
 * its argument unchanged, so there is exactly one place the wording is decided.
 */
export function listText(listType: PhoenixCrmListType): string {
  return listType;
}

/** "Faisal · Pedia · Mona Adel" — the territory by its place, line and rep, never its seat code. */
export function territoryLine(territory: TerritorySummary): string {
  return `${territory.name} · ${territory.repName ?? "No rep in this territory"}`;
}

/**
 * "Grade B · Internal Medicine", or "No grade" — who the customer is, without the AM or PM that
 * `customerMetaText` opens with. It is for a row that already prints AM or PM in a column of its
 * own, where saying it twice is noise: the rep's "Your day" panel on his landing page.
 */
export function gradeSpecialityText(customer: { grade: PhoenixCrmGrade | null; speciality: string | null }): string {
  return gradeSpecialityParts(customer).join(" · ");
}

/** The same words as their parts, for a row that isolates each part's direction (an Arabic speciality). */
export function gradeSpecialityParts(customer: { grade: PhoenixCrmGrade | null; speciality: string | null }): string[] {
  return [customer.grade ? `Grade ${customer.grade}` : "No grade", customer.speciality].filter((part): part is string => Boolean(part));
}

/** "PM · Grade B · Internal Medicine". */
export function customerMetaText(customer: { listType: PhoenixCrmListType; grade: PhoenixCrmGrade | null; speciality: string | null }): string {
  return `${listText(customer.listType)} · ${gradeSpecialityText(customer)}`;
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
/** Beside a customer whose third visit before validation the save would refuse (owner, 2026-10-28). */
export const VALIDATE_FIRST_PILL = "Validate first";
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

// ── A row of the day's plan (owner, 2026-10-02; the rules are plan-insight.ts) ──────────────────

/** "Tue 29 Sept" — the year added only when it is not this one, so last February never reads as this. */
function seenDay(isoDay: string, today: string): string {
  return isoDay.slice(0, 4) === today.slice(0, 4) ? dayLabel(isoDay) : dayLabelWithYear(isoDay);
}

/** "Last seen Tue 29 Sept", or "No visit recorded" when neither iReports360 nor Phoenix holds one. */
export function lastSeenText(lastSeenOn: string | null, today: string): string {
  return lastSeenOn ? `Last seen ${seenDay(lastSeenOn, today)}` : "No visit recorded";
}

/** "Usually seen Sun, Tue (iReports360)" — Saturday first, the field week's own order. */
export function usualDaysText(weekdays: readonly number[]): string {
  return `Usually seen ${weekdays.map((weekday) => PHOENIX_CRM_WEEKDAY_SHORT[weekday] ?? "?").join(", ")} (iReports360)`;
}

/** "Follow-up due Tue 6 Oct". */
export function followUpText(dueOn: string): string {
  return `Follow-up due ${dayLabel(dueOn)}`;
}

/** What a customer's row in the day's plan says beyond who he is. A null part is not drawn. */
export type PlannerRowInsight = { lastSeen: string | null; usual: string | null; followUp: string | null };

/**
 * The three lines of a row in the day's plan:
 *   - lastSeen: "Last seen Tue 29 Sept", and for a VALIDATED customer his month beside it, in the module's
 *     one month sentence (`monthVisitsText`: "· 1 of 3 visits this month"). Coverage counts validated
 *     customers only (owner, 2026-10-02), so a customer not validated yet shows the day alone. Null when
 *     the reads behind it did not answer — "No visit recorded" is said only when it was read;
 *   - usual: iReports360's usual days, while he has no days and hours of his own;
 *   - followUp: his latest visit's next step, when it is due inside the week being planned.
 */
export function plannerRowInsight(
  customer: Pick<PlannerCustomer, "insight" | "pending" | "places" | "visitsThisMonth">,
  context: { target: number | null; today: string; weekStart: string; withTime?: boolean },
): PlannerRowInsight {
  const insight = customer.insight ?? null;
  const usual = usualDaysOf(customer);
  const followUp = followUpInWeek(customer, context.weekStart);
  // "Show visit times" on (owner, 2026-11-05): the last visit's day AND its time.
  const seen = !insight
    ? null
    : context.withTime && insight.lastSeenOn
      ? `Last seen ${visitMomentText({ date: insight.lastSeenOn, at: insight.lastVisitAt ?? null }, context.today)}`
      : lastSeenText(insight.lastSeenOn, context.today);
  return {
    lastSeen: seen !== null && !customer.pending ? `${seen} · ${monthVisitsText(customer.visitsThisMonth, context.target)}` : seen,
    usual: usual ? usualDaysText(usual) : null,
    followUp: followUp ? followUpText(followUp) : null,
  };
}
