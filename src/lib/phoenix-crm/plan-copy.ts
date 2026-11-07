/**
 * Phoenix CRM — "Copy last month", "Copy last week" and "Copy a day", with no I/O.
 *
 * Owner, 2026-09-29: "copy last month, copy last week, and copy last Tuesday — the same day of the
 * week before, or the week before that". Every copy lands in the SAME places a hand-placed day does:
 * editable days only, the list types that day allows, never past a customer already on it, and never
 * past what the day's cap still has room for. Nothing is ever sent for him — a copy is a draft he
 * reviews.
 *
 *   - Copy last month (Phoenix): Week N's Saturday onto Week N's Saturday, Week N's Sunday onto Week
 *     N's Sunday, and so on — never "every Saturday", which would place a doctor he saw once on all
 *     four Saturdays of the new month.
 *   - Copy last week: each day onto the same weekday.
 *   - Copy a day: one day, from the same weekday one or two weeks back.
 *
 * The iReports360 copy below (buildCopyPlacements) stays as the first month's fallback, when there is
 * no Phoenix month to copy yet.
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

import { fieldWeekStart, weekdayOfIsoDay, weekNumberInMonth } from "@/lib/phoenix-crm/calendar";
import type { PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

/** The last-month reference this replays: a doctor who maps to a native customer and the weekdays he was on. */
export type CopyEntry = {
  nativeCustomerId: string | null;
  listType: PhoenixCrmDoctorListType;
  weekdays: number[];
};

/** A field-week's days as the copy reads them — the subset of MonthlyWeekView it needs. */
export type CopyDay = {
  date: string;
  listTypes: PhoenixCrmDoctorListType[];
  editable: boolean;
  /** Who is already on the day, so the copy neither doubles them nor breaches the cap. */
  items: ReadonlyArray<{ customerId: string; listType: PhoenixCrmDoctorListType }>;
};

export type CopyWeek = { weekStart: string; days: ReadonlyArray<CopyDay> };

type Caps = { amDailyCap: number; pmDailyCap: number };

function capFor(listType: PhoenixCrmDoctorListType, caps: Caps): number {
  return listType === "AM" ? caps.amDailyCap : caps.pmDailyCap;
}

/** The customers a copy may place: a doctor waiting for his full name never is (owner, 2026-11-07). */
function plannableById(customers: ReadonlyArray<PlannerCustomer>): Map<string, PlannerCustomer> {
  return new Map(customers.filter((customer) => !customer.needsFullName).map((customer) => [customer.customerId, customer]));
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
  const byCustomer = plannableById(customers);
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
      const room: Record<PhoenixCrmDoctorListType, number> = {
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

// ── Copying Phoenix's own plan ──────────────────────────────────────────────────────────────────

/** One customer on one day of the plan being copied FROM. */
export type CopySourcePlacement = { planDate: string; customerId: string };

/**
 * Fills one day from a list of customer ids, in the order given, with the same rules every copy obeys:
 * the day must be editable, the customer still on the list and of a list type the day allows, not
 * already on it, and the day's cap must have room.
 */
function placeOnDay(
  day: CopyDay,
  customerIds: ReadonlyArray<string>,
  byCustomer: ReadonlyMap<string, PlannerCustomer>,
  caps: Caps,
): PlanItemDraft[] {
  if (!day.editable) return [];
  const onDay = new Set(day.items.map((item) => item.customerId));
  const room: Record<PhoenixCrmDoctorListType, number> = {
    AM: capFor("AM", caps) - day.items.filter((item) => item.listType === "AM").length,
    PM: capFor("PM", caps) - day.items.filter((item) => item.listType === "PM").length,
  };
  const drafts: PlanItemDraft[] = [];
  for (const customerId of customerIds) {
    const customer = byCustomer.get(customerId);
    if (!customer || onDay.has(customerId) || !day.listTypes.includes(customer.listType)) continue;
    if (room[customer.listType] <= 0) continue;
    room[customer.listType] -= 1;
    onDay.add(customerId);
    drafts.push({
      planDate: day.date,
      customerId,
      placeId: customer.places[0]?.placeId ?? null,
      exceptionType: null,
      exceptionNote: null,
    });
  }
  return drafts;
}

function uniqueInOrder(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

/**
 * Copy last month, from Phoenix's own plan: Week N / weekday onto Week N / weekday.
 *
 * A source month with five weeks copied onto one with four drops its fifth week; a target month with
 * five weeks gets nothing on its fifth. Nothing is invented to fill a gap — he plans it himself.
 */
export function buildMonthCopyPlacements(
  source: ReadonlyArray<CopySourcePlacement>,
  customers: ReadonlyArray<PlannerCustomer>,
  weeks: ReadonlyArray<CopyWeek>,
  caps: Caps,
): Map<string, PlanItemDraft[]> {
  const byCustomer = plannableById(customers);
  const bySlot = new Map<string, string[]>();
  for (const placement of source) {
    const slot = `${weekNumberInMonth(fieldWeekStart(placement.planDate))}:${weekdayOfIsoDay(placement.planDate)}`;
    const list = bySlot.get(slot) ?? [];
    list.push(placement.customerId);
    bySlot.set(slot, list);
  }
  const placementsByWeek = new Map<string, PlanItemDraft[]>();
  for (const week of weeks) {
    const weekNumber = weekNumberInMonth(week.weekStart);
    const drafts = week.days.flatMap((day) =>
      placeOnDay(day, uniqueInOrder(bySlot.get(`${weekNumber}:${weekdayOfIsoDay(day.date)}`) ?? []), byCustomer, caps),
    );
    if (drafts.length > 0) placementsByWeek.set(week.weekStart, drafts);
  }
  return placementsByWeek;
}

/** Copy last week: each day of the source week onto the same weekday of the target week. */
export function buildWeekCopyPlacements(
  source: ReadonlyArray<CopySourcePlacement>,
  customers: ReadonlyArray<PlannerCustomer>,
  week: CopyWeek,
  caps: Caps,
): PlanItemDraft[] {
  const byCustomer = plannableById(customers);
  const byWeekday = new Map<number, string[]>();
  for (const placement of source) {
    const weekday = weekdayOfIsoDay(placement.planDate);
    const list = byWeekday.get(weekday) ?? [];
    list.push(placement.customerId);
    byWeekday.set(weekday, list);
  }
  return week.days.flatMap((day) => placeOnDay(day, uniqueInOrder(byWeekday.get(weekdayOfIsoDay(day.date)) ?? []), byCustomer, caps));
}

/** Copy a day: the customers of one source day onto one target day. */
export function buildDayCopyPlacements(
  sourceCustomerIds: ReadonlyArray<string>,
  customers: ReadonlyArray<PlannerCustomer>,
  day: CopyDay,
  caps: Caps,
): PlanItemDraft[] {
  const byCustomer = plannableById(customers);
  return placeOnDay(day, uniqueInOrder(sourceCustomerIds), byCustomer, caps);
}

/** The two days a "Copy a day" may copy FROM: the same weekday one week back, and two. */
export function dayCopySources(targetDay: string): [string, string] {
  const date = new Date(`${targetDay}T12:00:00Z`);
  const back = (days: number) => new Date(date.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return [back(7), back(14)];
}
