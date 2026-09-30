import { isRamadanDay, planDayListTypes, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { describeDayWindows } from "@/lib/phoenix-crm/plan-rules";
import { canWriteAsRep, isLocationBlind, readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayActivityOn, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPlannedActivityOn, type PlannedActivityRow } from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlannerReferences, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { windowsForWeekday } from "@/lib/phoenix-crm/timings";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { canEnterVisits, loadVisitRowsForDay, plannedCustomersOn } from "@/lib/phoenix-crm/server/visits";
import {
  buildTodayStops,
  compareTodayStops,
  NO_PLACE_YET,
  planUnsentNote,
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
  /** His week is still a draft: said above the day, never instead of it. */
  unsentNote: string | null;
  /** What he planned the day as, when it was not only calls — a meeting, training, a sales day. */
  plannedActivity: PlannedActivityRow | null;
  /** What he recorded the day as, if anything. A record only: it moves no figure. */
  dayActivity: DayActivityRow | null;
  canSetDayActivity: boolean;
} & TodayBuild;

export async function loadPhoenixCrmToday(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown },
): Promise<TodayView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const date = viewer.visitDay;
  const ramadan = isRamadanDay(date, viewer.config.ramadanOverrides);
  const weekday = weekdayOfIsoDay(date);

  const [{ customers, placesByCustomer }, planned, visitRows, plannedActivity, dayActivity] = await Promise.all([
    loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true }),
    plannedCustomersOn(seat.seatId, isTest, date),
    loadVisitRowsForDay(seat.seatId, isTest, date, { blind: isLocationBlind(viewer, seat) }),
    loadPlannedActivityOn(seat.seatId, isTest, date),
    loadDayActivityOn(seat.seatId, isTest, date),
  ]);

  const byId = new Map(customers.map((row) => [String(row.id), row]));
  // Where the ones not validated yet sit — they have no clinic, and a day he cannot read as a route
  // is not a day he can work. Only the planned ones are looked up.
  const references = await loadPlannerReferences(
    seat.seatId,
    isTest,
    planned.customerIds.map((customerId) => byId.get(customerId)).filter((row): row is NonNullable<typeof row> => Boolean(row)),
  );
  const stops: PlannedStop[] = [];
  for (const customerId of planned.customerIds) {
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
      listType: row.list_type === "AM" ? "AM" : "PM",
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
    });
  }
  // Sorted as a day is DRIVEN, then clustered by brick on the screen — so the clusters come out in
  // the order he meets them rather than alphabetically.
  stops.sort(compareTodayStops);

  const names = await loadPeopleNames(territoryPeople(viewer.org, [seat]));
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
    plannedActivity,
    dayActivity,
    canSetDayActivity: canWriteAsRep(viewer, seat, isTest),
    emptyReason: todayEmptyReason({
      hasPlan: planned.hasPlan,
      isFieldDay: planDayListTypes(date).length > 0,
      stops: build.stops.length,
    }),
    unsentNote: planUnsentNote({ hasPlan: planned.hasPlan, sent: planned.sent, stops: build.stops.length }),
  };
}
