import { isRamadanDay, planDayListTypes, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { directionsUrl } from "@/lib/phoenix-crm/directions";
import { parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { describeDayWindows } from "@/lib/phoenix-crm/plan-rules";
import { canWriteAsRep, locationSight, readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayActivityOn, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPlannedActivitiesOn, type PlannedActivityRow } from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlannerReferences, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { windowsForWeekday } from "@/lib/phoenix-crm/timings";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { canEnterVisits, loadVisitRowsForDay, loadWeekPlanRow, plannedCustomersOn } from "@/lib/phoenix-crm/server/visits";
import { loadWeekProgress } from "@/lib/phoenix-crm/server/week-progress";
import type { WeekProgress } from "@/lib/phoenix-crm/week-progress";
import {
  buildTodayStops,
  compareTodayStops,
  NO_PLACE_YET,
  todayEmptyReason,
  type PlannedStop,
  type TodayBuild,
} from "@/lib/phoenix-crm/today-rules";

/**
 * Phoenix CRM — what a rep sees the moment he opens the app.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opened the app onto
 * a tab bar and navigated; now he opens it onto his day. Today's stops in the order he will drive
 * them, each one done or one tap from being entered.
 *
 * Owner, 2026-09-29: "a dashboard of today's visits, done and not done" — AM and PM apart, the visits
 * off the plan beside it (out of plan and out of list, each with where it has got to), and the day's
 * activity, planned and recorded. "Today" is the VISIT day: until 02:00 it is still the day that just
 * ended (`viewer.visitDay`).
 *
 * Everything on it is HIS OWN WORK — his plan, his day, his targets — which is exactly what the rule
 * keeps visible. There is no distance here, no accuracy, no spread and no count of any of them.
 */

/** The Cairo clock of a capture — the server owns the timezone; the phone never states a time. */
function cairoClockOf(capturedAt: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(capturedAt));
}

export type TodayView = {
  territory: TerritorySummary;
  isTest: boolean;
  date: string;
  /** His targets, apart and never averaged — the call-rate golden rule. */
  target: { am: number; pm: number };
  canAdd: boolean;
  emptyReason: string | null;
  /**
   * Why there is nothing to show, in one sentence — including which state an unapproved plan is in
   * (owner, 2026-09-30). One sentence, never two: `todayEmptyReason` folds the plan's status in.
   */
  /** What he planned the day as, when it was not only calls — a meeting, training, a sales day; one of each kind. */
  plannedActivities: PlannedActivityRow[];
  /** The first of `plannedActivities` — what this field carried while a day held one; kept for a caller one release behind. */
  plannedActivity: PlannedActivityRow | null;
  /** What he recorded the day as, if anything. A record only: it moves no figure. */
  dayActivity: DayActivityRow | null;
  canSetDayActivity: boolean;
  /**
   * His own field week, planned against done (owner, 2026-10-02) — AM, PM and pharmacies apart, read
   * by `src/lib/phoenix-crm/week-progress.ts`. His own work, beside his own day.
   */
  week: WeekProgress;
} & TodayBuild;

export async function loadPhoenixCrmToday(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown },
): Promise<TodayView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const date = viewer.visitDay;
  const ramadan = isRamadanDay(date, viewer.config.ramadanOverrides);
  const weekday = weekdayOfIsoDay(date);

  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page" — this is the rep's day on
  // his landing page as well as here). The territory's names read nothing but the org chart, so they no
  // longer wait for every read below; and the references need only the list and the plan, so they start
  // the moment those two land instead of after the whole first wave. Every answer is the one before.
  //
  // 🔴 ONE PLAN ROW, AND ONLY THE PLANNED CUSTOMERS (2026-10-16 Phoenix CRM performance audit). The
  // day's stops, its planned activities and his week each asked for the same week's plan row; it is now
  // read once and handed to all three. And the stops are the day's APPROVED planned customers and nobody
  // else, so the list is read for those customers alone — not the whole territory and every place in it
  // — the moment the plan says who they are. Same filters, so a planned customer who has left the list
  // is still not a stop.
  const planRowRead = loadWeekPlanRow(seat.seatId, isTest, date);
  const plannedRead = plannedCustomersOn(seat.seatId, isTest, date, { planRow: planRowRead });
  const customersRead = plannedRead.then((planned) =>
    loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true, customerIds: planned.status === "approved" ? planned.customerIds : [] }),
  );
  const plannedStopsRead = Promise.all([customersRead, plannedRead]).then(async ([{ customers }, planned]) => {
    const byId = new Map(customers.map((row) => [String(row.id), row]));
    // 🔴 THE APPROVED PLAN ONLY (owner, 2026-09-30). A plan still waiting on someone shows no stops at
    // all — `planNote` says which state it is in instead. Today is the day he has been cleared to work.
    // The status is TODAY's (plan-rules.ts `planDayStatus`): an approved week a manager returned ONE
    // other day of is still approved today (owner, 2026-10-02, "Still planned").
    const approvedIds = planned.status === "approved" ? planned.customerIds : [];
    // Where the ones not validated yet sit — they have no clinic, and a day he cannot read as a route
    // is not a day he can work. Only the planned ones are looked up.
    const references = await loadPlannerReferences(
      seat.seatId,
      isTest,
      approvedIds.map((customerId) => byId.get(customerId)).filter((row): row is NonNullable<typeof row> => Boolean(row)),
    );
    return { byId, approvedIds, references };
  });
  const [{ placesByCustomer }, planned, visitRows, plannedActivities, dayActivity, { byId, approvedIds, references }, names, week] =
    await Promise.all([
      customersRead,
      plannedRead,
      loadVisitRowsForDay(seat.seatId, isTest, date, { sight: locationSight(viewer, seat), org: viewer.org }),
      loadPlannedActivitiesOn(seat.seatId, isTest, date, { planRow: planRowRead }),
      loadDayActivityOn(seat.seatId, isTest, date),
      plannedStopsRead,
      loadPeopleNames(territoryPeople(viewer.org, [seat])),
      // His own week, planned against done (owner, 2026-10-02) — in the same wave, never after it.
      loadWeekProgress(seat.seatId, isTest, date, { planRow: planRowRead }),
    ]);
  const stops: PlannedStop[] = [];
  for (const customerId of approvedIds) {
    const row = byId.get(customerId);
    // Planned before the customer left the list. He is not a stop any more, and the Plan screen is
    // where that is explained — this screen is only what he is going to do today.
    if (!row) continue;
    const [place] = placesByCustomer.get(customerId) ?? [];
    const reference = place ? null : (references.get(customerId) ?? null);
    // The season is decided HERE, once: in Ramadan these are the Ramadan windows (or the normal ones
    // for a customer with none), and the screen's "Next up" reads them as they are.
    const windows = place ? windowsForWeekday(place.timings, weekday, ramadan).windows : [];
    stops.push({
      customerId,
      name: String(row.name),
      listType: parseListType(row.list_type),
      speciality: textOrNull(row.speciality),
      // A customer not validated yet clusters with his own brick-mates, so the route holds together.
      brick: place?.brickName ?? reference?.brick ?? null,
      placeLabel: place?.label ?? null,
      todayWindows: place ? describeDayWindows(place.timings, date, ramadan) : NO_PLACE_YET,
      startMinute: windows.length > 0 ? windows[0].startMinute : null,
      grade: parseGrade(row.grade),
      windows: windows.map((window) => ({ startMinute: window.startMinute, endMinute: window.endMinute })),
      hoursSaved: Boolean(place && place.timings.length > 0),
      hasPlace: Boolean(place),
      reference,
      // The way to the place the row names (owner, 2026-10-02) — null with no saved place, and then
      // the row carries no link.
      directionsUrl: directionsUrl(place ?? null),
    });
  }
  // Sorted as a day is DRIVEN, then clustered by brick on the screen — so the clusters come out in
  // the order he meets them rather than alphabetically.
  stops.sort(compareTodayStops);

  const build = buildTodayStops({
    planned: stops,
    visitsToday: visitRows.map((row) => ({
      customerId: String(row.customerId),
      name: row.customerName,
      listType: row.listType,
      doneAt: cairoClockOf(row.capturedAt),
      pharmacyName: row.pharmacyName,
      offKind: row.unplannedKind,
      statusLabel: row.outOfList?.label ?? row.unplanned?.statusLabel ?? null,
    })),
  });

  return {
    ...build,
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    date,
    target: { am: viewer.config.settings.callRateAmTarget, pm: viewer.config.settings.callRatePmTarget },
    canAdd: canEnterVisits(viewer, seat.seatId, isTest),
    plannedActivities,
    plannedActivity: plannedActivities[0] ?? null,
    dayActivity,
    canSetDayActivity: canWriteAsRep(viewer, seat, isTest),
    week,
    emptyReason: todayEmptyReason({
      status: planned.status,
      isFieldDay: planDayListTypes(date).length > 0,
      stops: build.stops.length,
    }),
  };
}
