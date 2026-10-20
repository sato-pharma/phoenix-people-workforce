/**
 * Phoenix CRM — the daily plan report's reading (owner, 2026-09-30: "build the daily plan report").
 *
 * One territory's week plans over some days, each planned customer with where he is and whether he
 * was visited that day. The rules — which days, how a day's plan stands, what "visited" means — are
 * pure, in daily-plan-report.ts; this only reads, and reuses the plan board's own reading of a week
 * (`buildDays`), so a customer's hours and standing print here exactly as the rep's planner shows them.
 *
 *   - Scope runs downward only: the viewer's own territories (`scopeTerritories`), narrowed by line
 *     and territory as every report section is. With several and none chosen it answers with no
 *     territory rather than guessing one.
 *   - Test entries are read beside the real ones exactly when every other report reads them
 *     (`reportIncludesTest`), and each test plan is listed after the real one, marked.
 *   - It reads no distance, no flag and no check: the rep reads his own plan here.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { fieldWeekStart, isRamadanDay } from "@/lib/phoenix-crm/calendar";
import {
  buildDailyPlanDays,
  dailyPlanDates,
  lastPlannableDay,
  resolveDailyPlanPeriod,
  type DailyPlanOffPlan,
  type DailyPlanPeriod,
  type DailyPlanReportView,
  type DailyPlanSourceActivity,
  type DailyPlanSourceItem,
  type DailyPlanSourcePlan,
  type DailyPlanSourceStarts,
  type DailyPlanSourceVisit,
} from "@/lib/phoenix-crm/daily-plan-report";
import { leaveDatesFor } from "@/lib/phoenix-crm/plan-leave";
import { territoriesUnderManager, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { reportIncludesTest, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadPlannerReferences } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanActivities } from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlanDayStarts } from "@/lib/phoenix-crm/server/plan-day-starts";
import { buildDays, loadPlanItemRows, PLAN_COLUMNS, statusOf } from "@/lib/phoenix-crm/server/plans";
import type { ReportFilterInput } from "@/lib/phoenix-crm/server/reports";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The plan board's own item reading (`ITEM_COLUMNS`) plus what this report prints that the board does
 * not: the customer's phone, the place's address and area, and the sales master key a customer not
 * validated yet is found by. ONE string literal — the Supabase client reads a select list at the type
 * level.
 *
 * 🔴 The phone is phoenix_crm_customers.phone — what the REP typed (owner, 2026-09-30: "only what the
 * rep types"). iReports360's own phones are never read here, so a customer not validated yet shows none.
 */
const DAILY_PLAN_ITEM_COLUMNS =
  "id, plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note, customer:phoenix_crm_customers!customer_id(name, grade, speciality, status, reference_contact_crm_id, phone), place:phoenix_crm_places!place_id(label, address, brick_name, zone, area_name, lat, lon, timings, status)";

/**
 * The one territory the report reads: the chosen one, or the viewer's only one. Line and territory
 * narrow the viewer's own scope exactly as every other report section does (`chooseTerritories` in
 * reports.ts) — never wider than the viewer, and refused rather than quietly emptied when asked for
 * one outside it.
 */
function chooseTerritory(viewer: PhoenixCrmViewer, raw: ReportFilterInput): OrgSeat | null {
  let seats = viewer.scopeTerritories;
  const lineCode = trimmed(raw.lineCode);
  if (lineCode) {
    seats = seats.filter((seat) => seat.lineCode === lineCode);
    if (seats.length === 0) throw forbiddenError("This line is outside your scope.");
  }
  // The manager filter (owner, 2026-10-20: "when filter by manager u find no manager") — the same narrowing as
  // `chooseTerritories`: the territories under the seats he holds, and refused when he is not one of the viewer's.
  const managerHrId = trimmed(raw.managerHrId);
  if (managerHrId) {
    const under = territoriesUnderManager(viewer.org, viewer.hrId, viewer.basis, managerHrId);
    if (under) seats = seats.filter((seat) => under.has(seat.seatId));
    if (!under || seats.length === 0) throw forbiddenError("This manager is outside your scope.");
  }
  const seatId = trimmed(raw.seatId);
  if (seatId) {
    const seat = seats.find((entry) => entry.seatId === seatId);
    if (!seat) throw forbiddenError("This territory is outside your scope.");
    return seat;
  }
  return seats.length === 1 ? seats[0] : null;
}

async function loadPlans(seatId: string, weekStarts: ReadonlyArray<string>, includeTest: boolean): Promise<Row[]> {
  let query = getSupabaseAdmin().from("phoenix_crm_plans").select(PLAN_COLUMNS).eq("seat_id", seatId).in("week_start", [...weekStarts]);
  if (!includeTest) query = query.eq("is_test", false);
  const { data, error } = await query;
  throwIfError(error);
  return (data ?? []) as unknown as Row[];
}

/** Every status each plan was given, oldest first — how a day that has passed is read. */
async function loadPlanEvents(planIds: ReadonlyArray<string>): Promise<Map<string, DailyPlanSourcePlan["events"]>> {
  const byPlan = new Map<string, Array<{ at: string; toStatus: PhoenixCrmPlanStatus }>>();
  for (const part of chunk([...new Set(planIds)], 50)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_plan_events").select("id, plan_id, to_status, created_at").in("plan_id", part).not("to_status", "is", null),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const at = textOrNull(row.created_at);
      if (!at) continue;
      const planId = String(row.plan_id);
      byPlan.set(planId, [...(byPlan.get(planId) ?? []), { at, toStatus: statusOf(row.to_status) }]);
    }
  }
  return byPlan;
}

function offPlanOf(status: unknown): DailyPlanOffPlan {
  if (status === "admin_pending" || status === "manager_pending" || status === "sfe_pending") return "waiting";
  if (status === "approved" || status === "refused") return status;
  return "recorded";
}

/**
 * The territory's visits over the days — every one of them, from the base table, as plan against
 * actual reads "visited": he was there whatever became of the visit, and an off-plan one says how its
 * approval stands beside it.
 */
async function loadVisits(seatId: string, period: DailyPlanPeriod, includeTest: boolean): Promise<DailyPlanSourceVisit[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () => {
      const query = getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, visit_date, captured_at, is_test, is_unplanned")
        .eq("seat_id", seatId)
        .gte("visit_date", period.from)
        .lte("visit_date", period.to);
      return includeTest ? query : query.eq("is_test", false);
    },
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const offPlanIds = rows.filter((row) => row.is_unplanned === true).map((row) => String(row.id));
  const decisions = new Map<string, unknown>();
  for (const part of chunk(offPlanIds, 150)) {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_unplanned_visits").select("visit_id, status").in("visit_id", part);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) decisions.set(String(row.visit_id), row.status);
  }
  return rows.flatMap((row): DailyPlanSourceVisit[] => {
    const date = textOrNull(row.visit_date);
    const capturedAt = textOrNull(row.captured_at);
    if (!date || !capturedAt) return [];
    return [
      {
        date,
        customerId: String(row.customer_id),
        isTest: row.is_test === true,
        capturedAt,
        offPlan: row.is_unplanned === true ? offPlanOf(decisions.get(String(row.id))) : null,
      },
    ];
  });
}

/** The customers not validated yet among these plan rows, in the shape the sales-master lookup reads. */
function pendingCustomers(itemRows: ReadonlyArray<Row>): Row[] {
  const byId = new Map<string, Row>();
  for (const row of itemRows) {
    const customer = record(row.customer);
    if (customer.status !== "pending") continue;
    byId.set(String(row.customer_id), { id: row.customer_id, status: "pending", reference_contact_crm_id: customer.reference_contact_crm_id });
  }
  return [...byId.values()];
}

export async function loadDailyPlanReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<DailyPlanReportView> {
  const resolved = resolveDailyPlanPeriod({ from: raw.from, to: raw.to, cairoToday: viewer.cairoToday });
  if (!resolved.ok) throw validationError(resolved.error);
  const period = resolved.value;
  const includeTest = reportIncludesTest(viewer, raw.includeTest);
  const view = {
    period,
    cairoToday: viewer.cairoToday,
    visitDay: viewer.visitDay,
    lastPlannableDay: lastPlannableDay(viewer.cairoToday),
    includeTest,
  };
  const seat = chooseTerritory(viewer, raw);
  if (!seat) return { ...view, territory: null, days: [], leaveUnread: false };

  const dates = dailyPlanDates(period);
  const weekStarts = [...new Set(dates.map(fieldWeekStart))];
  const [planRows, visits, names, leave] = await Promise.all([
    weekStarts.length > 0 ? loadPlans(seat.seatId, weekStarts, includeTest) : Promise.resolve([] as Row[]),
    loadVisits(seat.seatId, period, includeTest),
    loadPeopleNames([seat.occupantHrId]),
    // 🔴 A day HR approved his leave reads "On leave", never "Not visited" (owner, 2026-10-01).
    loadSeatLeaveDays([seat], period),
  ]);
  const planIds = planRows.map((row) => String(row.id));

  // One world at a time. The activity and start-time readers key a day by its DATE alone, which is
  // unique only within one world — a territory holds one plan a week, and a test one beside it.
  const worlds = (includeTest ? [false, true] : [false])
    .map((isTest) => {
      const worldPlans = planRows.filter((row) => (row.is_test === true) === isTest);
      return { isTest, worldPlans, worldIds: new Set(worldPlans.map((row) => String(row.id))) };
    })
    .filter((world) => world.worldPlans.length > 0);
  // Each world's activities and start times hang on its plan ids alone, so they are read beside the
  // items and the events rather than after them; only the sales-master references wait for the items,
  // since they are looked up for the customers those items name.
  const [[itemRows, events], worldDays] = await Promise.all([
    Promise.all([loadPlanItemRows(planIds, DAILY_PLAN_ITEM_COLUMNS), loadPlanEvents(planIds)]),
    Promise.all(worlds.map((world) => Promise.all([loadPlanActivities([...world.worldIds]), loadPlanDayStarts([...world.worldIds])]))),
  ]);
  const worldItemsOf = worlds.map((world) => itemRows.filter((row) => world.worldIds.has(String(row.plan_id))));
  const worldReferences = await Promise.all(
    worlds.map((world, index) => loadPlannerReferences(seat.seatId, world.isTest, pendingCustomers(worldItemsOf[index]))),
  );

  const settings = viewer.config.settings;
  const isRamadan = (isoDay: string) => isRamadanDay(isoDay, viewer.config.ramadanOverrides);
  const wanted = new Set(dates);
  const plans: DailyPlanSourcePlan[] = [];
  const items: DailyPlanSourceItem[] = [];
  const activities: DailyPlanSourceActivity[] = [];
  const starts: DailyPlanSourceStarts[] = [];

  for (let index = 0; index < worlds.length; index += 1) {
    const { isTest, worldPlans } = worlds[index];
    const worldItems = worldItemsOf[index];
    const [activitiesByDay, startsByDay] = worldDays[index];
    const references = worldReferences[index];

    for (const planRow of worldPlans) {
      const planId = String(planRow.id);
      const weekStart = String(planRow.week_start);
      plans.push({
        planId,
        weekStart,
        isTest,
        status: statusOf(planRow.status),
        submittedLate: planRow.submitted_late === true,
        events: events.get(planId) ?? [],
      });
      const rows = worldItems.filter((row) => String(row.plan_id) === planId);
      const rowByDayCustomer = new Map(rows.map((row) => [`${String(row.plan_date)}|${String(row.customer_id)}`, row]));
      const days = buildDays({
        weekStart,
        cairoToday: viewer.cairoToday,
        itemRows: rows,
        farApartKm: settings.farApartKm,
        isRamadan,
        activities: activitiesByDay,
        starts: startsByDay,
      });
      for (const day of days) {
        if (!wanted.has(day.date)) continue;
        starts.push({ planId, date: day.date, starts: day.starts });
        for (const activity of day.activities) {
          activities.push({ planId, date: day.date, activityType: activity.activityType, label: activity.activityLabel, halfDay: activity.halfDay, note: activity.note });
        }
        for (const item of day.items) {
          const itemRow = rowByDayCustomer.get(`${day.date}|${item.customerId}`);
          const place = record(itemRow?.place);
          // A validated customer is where his planned place is; one not validated yet has no place, so
          // the sales master's brick and area stand in — the organogram's names, never iReports360's.
          const reference = item.placeId ? null : (references.get(item.customerId) ?? null);
          items.push({
            planId,
            date: day.date,
            listType: item.listType,
            customerId: item.customerId,
            name: item.name,
            grade: item.grade,
            speciality: item.speciality,
            pending: item.pending,
            stale: item.stale,
            phone: textOrNull(record(itemRow?.customer).phone),
            placeLabel: item.placeLabel,
            brick: item.placeId ? item.brickName : (reference?.brick ?? null),
            area: item.placeId ? textOrNull(place.area_name) : (reference?.area ?? null),
            address: item.placeId ? textOrNull(place.address) : (reference?.address ?? null),
            hoursText: item.windowsText,
            exceptionLabel: item.exceptionLabel,
            exceptionNote: item.exceptionNote,
          });
        }
      }
    }
  }

  return {
    ...view,
    territory: {
      seatId: seat.seatId,
      name: territoryName(seat),
      lineName: seat.lineName,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
    },
    days: buildDailyPlanDays({
      period,
      cairoToday: viewer.cairoToday,
      visitDay: viewer.visitDay,
      plans,
      items,
      activities,
      starts,
      visits,
      leaveDays: leaveDatesFor(leave.days, seat.seatId, dates),
    }),
    leaveUnread: leave.unread,
  };
}
