import { clusterByBrick } from "@/lib/phoenix-crm/brick-groups";

import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";

/**
 * Phoenix CRM — the rep's day, as one list he can work down.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opens the app
 * twelve times a day and, until now, landed on a tab bar and navigated. This builds the one screen
 * he should land on: today's stops, in the order he will drive them, each one either done or one tap
 * from being entered.
 *
 * Pure. The I/O half is `src/lib/phoenix-crm/server/today.ts`.
 *
 * ## The rule that matters more than the rest
 *
 * A stop he has already visited **keeps its place**. The obvious implementation moves a visited stop
 * to the bottom, and it is wrong: a rep glances at this screen between two doors, and a list that
 * reshuffles under him mid-morning is a list he has to re-read every time. It changes state in
 * place, and nothing moves until tomorrow.
 *
 * ## What is NOT here
 *
 * No distance, no accuracy, no spread, no flag, and no count of any of them. This is his plan, his
 * day and his targets — his own work, which Golden Rule #1 keeps visible — and nothing else.
 */

export type TodayStop = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  speciality: string | null;
  brick: string | null;
  placeLabel: string | null;
  /** Today's receiving hours at his place, or "Does not receive this day". */
  todayWindows: string;
  /** Minutes past midnight of the first window today, for ordering inside one brick. */
  startMinute: number | null;
  done: boolean;
  /** Cairo clock of the visit, when it is done. */
  doneAt: string | null;
};

/** A visit he made today to somebody who was not on the plan. Beside the day, never inside it. */
export type TodayExtra = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  doneAt: string;
};

export type TodayCounts = {
  plannedAm: number;
  plannedPm: number;
  doneAm: number;
  donePm: number;
};

export type TodayBuild = {
  stops: TodayStop[];
  alsoVisited: TodayExtra[];
  counts: TodayCounts;
};

export type PlannedStop = Omit<TodayStop, "done" | "doneAt">;

export type TodayVisit = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  /** Cairo clock, already formatted — the server owns the timezone, never the phone. */
  doneAt: string;
};

/**
 * Today's stops, the visits that were not on the plan, and the four counts.
 *
 * `planned` arrives already ordered by the caller (brick, then the receiving hour, then the name);
 * this keeps that order exactly, marking each stop done or not.
 */
export function buildTodayStops(input: { planned: readonly PlannedStop[]; visitsToday: readonly TodayVisit[] }): TodayBuild {
  const visitByCustomer = new Map(input.visitsToday.map((visit) => [visit.customerId, visit]));
  const plannedIds = new Set(input.planned.map((stop) => stop.customerId));

  const stops: TodayStop[] = input.planned.map((stop) => {
    const visit = visitByCustomer.get(stop.customerId) ?? null;
    return { ...stop, done: visit !== null, doneAt: visit?.doneAt ?? null };
  });

  // Beside the day, never inside it. An off-plan visit is real work and he must see he did it, but
  // dropping it into the middle of his route would make the list he is reading change shape.
  const alsoVisited: TodayExtra[] = input.visitsToday
    .filter((visit) => !plannedIds.has(visit.customerId))
    .map((visit) => ({ customerId: visit.customerId, name: visit.name, listType: visit.listType, doneAt: visit.doneAt }));

  // AM and PM apart, always — the call-rate golden rule. Nothing here ever sums or averages them.
  const counts: TodayCounts = {
    plannedAm: stops.filter((stop) => stop.listType === "AM").length,
    plannedPm: stops.filter((stop) => stop.listType === "PM").length,
    doneAm: input.visitsToday.filter((visit) => visit.listType === "AM").length,
    donePm: input.visitsToday.filter((visit) => visit.listType === "PM").length,
  };

  return { stops, alsoVisited, counts };
}

/** His day in brick clusters, in the order he will drive them. */
export function todayByBrick(stops: readonly TodayStop[]) {
  return clusterByBrick(stops, (stop) => stop.brick, "first-appearance");
}

/**
 * The order a day is driven: AM before PM, then the hour the place opens, then the name.
 *
 * The same shape as the planner's own `compareRows`. Brick clustering is applied AFTER this, so the
 * clusters come out in the order the first stop in each one falls.
 */
export function compareTodayStops(left: PlannedStop, right: PlannedStop): number {
  return (
    left.listType.localeCompare(right.listType) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

/**
 * Why there is nothing to show — a sentence, never an empty screen.
 *
 * Each of these is about HIS OWN WORK, which is what Golden Rule #1 keeps visible: a plan he has not
 * sent, a day the field week does not cover, a day he planned empty.
 */
export function todayEmptyReason(input: { hasPlan: boolean; isFieldDay: boolean; stops: number }): string | null {
  if (!input.isFieldDay) return "Today is not a field day.";
  if (!input.hasPlan) return "No plan has been sent for this week yet. Open Plan to send it.";
  if (input.stops === 0) return "Nobody is planned for today.";
  return null;
}
