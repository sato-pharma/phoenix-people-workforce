/**
 * Phoenix CRM — "Copy last month", with no I/O.
 *
 * Owner, 2026-09-25: offer to pre-fill the new month from the rep's own iReports360 plan, editable and
 * never auto-submitted. This turns last month's reference (server/plan-history.ts) into placements on
 * the new month's matching weekdays, which the caller then saves a week at a time through the ordinary
 * weekly save — so caps, timings and versions are enforced by the same proven path a hand-placed day is.
 *
 * The rules kept here, so a test can pin them:
 *   - only a doctor who still maps to a customer on the seat's list is placed (a name-only entry is not);
 *   - he is placed on every EDITABLE day of the month whose weekday he was on last month, on the list
 *     types that day allows, using his first place (or none, for a customer not validated yet);
 *   - a day is filled only up to what its cap still has room for, and never past a doctor already on it,
 *     so a copy onto a week with days already planned adds to them without breaching a limit.
 * Over the grade norm is allowed (owner decision 3), so nothing here caps a doctor's month total.
 */

import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import type { PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/** The last-month reference this replays: a doctor who maps to a native customer and the weekdays he was on. */
export type CopyEntry = {
  nativeCustomerId: string | null;
  listType: PhoenixCrmListType;
  weekdays: number[];
};

/** A field-week's days as the copy reads them — the subset of MonthlyWeekView it needs. */
export type CopyDay = {
  date: string;
  listTypes: PhoenixCrmListType[];
  editable: boolean;
  /** Who is already on the day, so the copy neither doubles them nor breaches the cap. */
  items: ReadonlyArray<{ customerId: string; listType: PhoenixCrmListType }>;
};

export type CopyWeek = { weekStart: string; days: ReadonlyArray<CopyDay> };

type Caps = { amDailyCap: number; pmDailyCap: number };

function capFor(listType: PhoenixCrmListType, caps: Caps): number {
  return listType === "AM" ? caps.amDailyCap : caps.pmDailyCap;
}

/**
 * The placements a "Copy last month" would write, grouped by field-week. Only weeks that gain at least
 * one placement appear, and every draft is a plain placement with no exception — a copied doctor is on
 * a day he receives, or the rep gives the reason when he reviews it.
 */
export function buildCopyPlacements(
  entries: ReadonlyArray<CopyEntry>,
  customers: ReadonlyArray<PlannerCustomer>,
  weeks: ReadonlyArray<CopyWeek>,
  caps: Caps,
): Map<string, PlanItemDraft[]> {
  const byCustomer = new Map(customers.map((customer) => [customer.customerId, customer]));
  // One weekday set per still-on-list customer; a doctor on the list twice in the reference merges.
  const weekdaysByCustomer = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (!entry.nativeCustomerId || !byCustomer.has(entry.nativeCustomerId)) continue;
    const set = weekdaysByCustomer.get(entry.nativeCustomerId) ?? new Set<number>();
    for (const weekday of entry.weekdays) set.add(weekday);
    weekdaysByCustomer.set(entry.nativeCustomerId, set);
  }
  if (weekdaysByCustomer.size === 0) return new Map();

  const placementsByWeek = new Map<string, PlanItemDraft[]>();
  for (const week of weeks) {
    const drafts: PlanItemDraft[] = [];
    for (const day of week.days) {
      if (!day.editable) continue;
      const weekday = weekdayOfIsoDay(day.date);
      const onDay = new Set(day.items.map((item) => item.customerId));
      const room: Record<PhoenixCrmListType, number> = {
        AM: capFor("AM", caps) - day.items.filter((item) => item.listType === "AM").length,
        PM: capFor("PM", caps) - day.items.filter((item) => item.listType === "PM").length,
      };
      // Stable order so the copy is deterministic and a test can assert it.
      const candidates = [...weekdaysByCustomer.entries()]
        .filter(([, weekdays]) => weekdays.has(weekday))
        .map(([customerId]) => byCustomer.get(customerId) as PlannerCustomer)
        .filter((customer): customer is PlannerCustomer => Boolean(customer) && day.listTypes.includes(customer.listType) && !onDay.has(customer.customerId))
        .sort((left, right) => left.listType.localeCompare(right.listType) || left.customerId.localeCompare(right.customerId));
      for (const customer of candidates) {
        if (room[customer.listType] <= 0) continue;
        room[customer.listType] -= 1;
        drafts.push({
          planDate: day.date,
          customerId: customer.customerId,
          placeId: customer.places[0]?.placeId ?? null,
          exceptionType: null,
          exceptionNote: null,
        });
      }
    }
    if (drafts.length > 0) placementsByWeek.set(week.weekStart, drafts);
  }
  return placementsByWeek;
}
