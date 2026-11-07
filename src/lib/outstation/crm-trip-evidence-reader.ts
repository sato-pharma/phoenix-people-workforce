/**
 * Reads what Phoenix CRM holds for each day of one outstation trip, for Expense Approvals (owner,
 * 2026-11-07: "wire the Phoenix CRM with the expense module and get most benefit of this
 * integration"). `crm-trip-evidence.ts` turns it into the approver's reading; this file only reads.
 *
 * Every read goes through Phoenix CRM's own readers where one exists — the plan day status
 * (`loadPlanDayFacts` + `planDayStatus`, asked day by day), the planned activities, the manager's
 * planned day (`loadManagerDayPlans`, the weekly report's own read), the visit partners
 * (`getTripVisitPartnersByDate`) and the open location warnings (`loadIntegrityCasesForWindow`, the
 * board's own reader — never a second reader of `phoenix_crm_location_integrity`). Visits, Day
 * Starts and logged activities are plain reads of the person's own rows.
 *
 * One source failing never blanks the rest: it is named in `unavailable`, and the section says so
 * rather than reading as "nothing there". Read-only; nothing here moves money.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { addDaysIso } from "@/lib/crm/dates";
import { getTripVisitPartnersByDate } from "@/lib/crm/visit-partners";
import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import { getOutstationRequestById } from "@/lib/outstation/service";
import {
  buildCrmTripEvidence,
  type CrmPlanStatus,
  type CrmPoint,
  type CrmTripDayInput,
  type CrmTripReading,
  type CrmTripVisit,
} from "@/lib/outstation/crm-trip-evidence";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, isDayActivity } from "@/lib/phoenix-crm/day-activities";
import { planDayStatus } from "@/lib/phoenix-crm/plan-rules";
import { heldManagerSeats, ownTerritories, personKey } from "@/lib/phoenix-crm/scope";
import { integritySourceLabel, loadIntegrityCasesForWindow } from "@/lib/phoenix-crm/server/integrity-board";
import { loadManagerDayPlans } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanActivities } from "@/lib/phoenix-crm/server/plan-activities";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS } from "@/lib/phoenix-crm/server/plan-day-status";

type Row = Record<string, unknown>;

/** A trip longer than this is read for its first days only — no real outstation trip is longer. */
const MAX_TRIP_DAYS = 31;

export type CrmTripEvidenceResult = {
  found: boolean;
  reading: CrmTripReading | null;
  /** Sources that could not be read; the section names them rather than showing "nothing". */
  unavailable: string[];
};

const text = (value: unknown): string | null => {
  const out = String(value ?? "").trim();
  return out ? out : null;
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

function pointOf(lat: unknown, lon: unknown): CrmPoint | null {
  const la = num(lat);
  const lo = num(lon);
  if (la === null || lo === null || (la === 0 && lo === 0)) return null;
  return { lat: la, lon: lo };
}

function tripDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let day = start; day <= end && dates.length < MAX_TRIP_DAYS; day = addDaysIso(day, 1)) dates.push(day);
  return dates;
}

async function rowsOf(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/** Visits he saved, rode along on, or joined as the senior — three reads, merged by id. */
async function loadTripVisits(hrId: string, start: string, end: string): Promise<Row[]> {
  const columns = "id, visit_date, captured_at, lat, lon, place_id, customer_id, location_flag, is_unplanned";
  const read = (column: "manager_hr_id" | "rep_hr_id" | "senior_hr_id") =>
    rowsOf(
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select(columns)
        .eq("is_test", false)
        .eq(column, hrId)
        .gte("visit_date", start)
        .lte("visit_date", end),
    );
  const byId = new Map<string, Row>();
  for (const rows of await Promise.all([read("rep_hr_id"), read("manager_hr_id"), read("senior_hr_id")])) {
    for (const row of rows) byId.set(String(row.id), row);
  }
  return [...byId.values()];
}

export async function loadCrmTripEvidence(requestId: number): Promise<CrmTripEvidenceResult> {
  const request = await getOutstationRequestById(requestId);
  if (!request) return { found: false, reading: null, unavailable: [] };

  const hrId = personKey(request.employeeHrId);
  const start = cairoDateOnly(request.tripStartDate);
  const end = cairoDateOnly(request.tripEndDate) ?? start;
  if (!hrId || !start || !end) return { found: true, reading: null, unavailable: [] };
  const dates = tripDates(start, end);
  const last = dates[dates.length - 1];
  const unavailable: string[] = [];
  const settle = async <T>(label: string, fallback: T, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      unavailable.push(label);
      return fallback;
    }
  };

  const supabase = getSupabaseAdmin();
  const [visitRows, dayStarts, activities, org, warnings, partners, rideAlongRows] = await Promise.all([
    settle("visits", [] as Row[], () => loadTripVisits(hrId, start, last)),
    // Through the morning AFTER the trip, so the last night has its next morning.
    settle("Day Start", [] as Row[], () =>
      rowsOf(
        supabase
          .from("phoenix_crm_day_starts")
          .select("started_on, started_at, lat, lon")
          .eq("is_test", false)
          .eq("rep_hr_id", hrId)
          .gte("started_on", start)
          .lte("started_on", addDaysIso(last, 1)),
      ),
    ),
    settle("logged activities", [] as Row[], () =>
      rowsOf(
        supabase
          .from("phoenix_crm_day_activities")
          .select("activity_date, activity_type")
          .eq("is_test", false)
          .eq("rep_hr_id", hrId)
          .gte("activity_date", start)
          .lte("activity_date", last),
      ),
    ),
    settle("the organogram", null, () => loadPhoenixCrmOrg()),
    // Open (unsettled) cases only — the board's own reader, for the Super Admin who approves.
    settle("location warnings", [] as Awaited<ReturnType<typeof loadIntegrityCasesForWindow>>, () =>
      loadIntegrityCasesForWindow({ fromIso: start, includeGps: true, toIso: last }),
    ),
    settle("visit partners", {} as Awaited<ReturnType<typeof getTripVisitPartnersByDate>>, () =>
      getTripVisitPartnersByDate({ hops: 1, rootHrIds: [hrId], tripEndDate: last, tripStartDate: start }),
    ),
    settle("ride-along plans", [] as Row[], async () => {
      const read = (column: "manager_hr_id" | "rep_hr_id") =>
        rowsOf(
          supabase
            .from("phoenix_crm_double_visit_plans")
            .select("id, plan_date, manager_hr_id, rep_hr_id")
            .eq("is_test", false)
            .eq(column, hrId)
            .gte("plan_date", start)
            .lte("plan_date", last),
        );
      const byId = new Map<string, Row>();
      for (const rows of await Promise.all([read("manager_hr_id"), read("rep_hr_id")])) {
        for (const row of rows) byId.set(String(row.id), row);
      }
      return [...byId.values()];
    }),
  ]);

  // Places and customers named on the visits.
  const placeIds = [...new Set(visitRows.map((row) => text(row.place_id)).filter((id): id is string => Boolean(id)))];
  const customerIds = [...new Set(visitRows.map((row) => text(row.customer_id)).filter((id): id is string => Boolean(id)))];
  const [places, customers] = await Promise.all([
    settle("places", new Map<string, Row>(), async () =>
      placeIds.length === 0
        ? new Map<string, Row>()
        : new Map(
            (
              await rowsOf(
                supabase
                  .from("phoenix_crm_places")
                  .select("id, label, area_name, region_name, brick_name, lat, lon, pin_lat, pin_lon")
                  .in("id", placeIds),
              )
            ).map((row) => [String(row.id), row]),
          ),
    ),
    settle("customers", new Map<string, string>(), async () =>
      customerIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (await rowsOf(supabase.from("phoenix_crm_customers").select("id, name").in("id", customerIds))).map((row) => [
              String(row.id),
              text(row.name) ?? "",
            ]),
          ),
    ),
  ]);

  // The week plans of his territories, day by day.
  const planByDate = new Map<string, NonNullable<CrmTripDayInput["plan"]>>();
  const managerPlans = new Map<string, NonNullable<CrmTripDayInput["managerPlan"]>>();
  if (org) {
    await settle("the week plan", undefined, async () => {
      for (const [date, plan] of await loadTripPlanDays(org, hrId, dates)) planByDate.set(date, plan);
    });
    if (heldManagerSeats(org, hrId).length > 0) {
      await settle("the manager plan", undefined, async () => {
        const plans = await loadManagerDayPlans({ end: last, managerHrIds: [hrId], start });
        for (const date of dates) {
          const plan = plans.get(`${hrId}|${date}`);
          if (plan) managerPlans.set(date, { lines: plan.halves.map((half) => half.title), sent: plan.sent, statusLine: plan.statusLine });
        }
      });
    }
  }

  // Someone he was out with that day who ALSO claimed a car trip covering it.
  const partnersByDate = (() => {
    const wanted = canonicalHrIdKey(hrId);
    for (const [person, byDate] of Object.entries(partners)) if (canonicalHrIdKey(person) === wanted) return byDate;
    return {} as Record<string, string[]>;
  })();
  const partnerIds = [...new Set(Object.values(partnersByDate).flat().map((id) => personKey(id)).filter((id): id is string => Boolean(id)))];
  const partnerCars = await settle("partner car claims", [] as Row[], async () =>
    partnerIds.length === 0
      ? []
      : rowsOf(
          supabase
            .from("outstation_expense_requests")
            .select("id, employee_hr_id, employee_name, trip_start_date, trip_end_date, transportation_type, status")
            .in("employee_hr_id", partnerIds)
            .eq("transportation_type", "car")
            .neq("id", requestId)
            .lte("trip_start_date", `${last}T23:59:59Z`)
            .gte("trip_end_date", `${addDaysIso(start, -1)}T00:00:00Z`),
        ),
  );

  const names = await settle("names", new Map() as Awaited<ReturnType<typeof loadPeopleNames>>, () =>
    loadPeopleNames([
      ...rideAlongRows.flatMap((row) => [text(row.manager_hr_id), text(row.rep_hr_id)]),
      ...partnerCars.map((row) => text(row.employee_hr_id)),
    ]),
  );

  const days: CrmTripDayInput[] = dates.map((date) => {
    const visits: CrmTripVisit[] = visitRows
      .filter((row) => String(row.visit_date) === date)
      .map((row) => {
        const place = places.get(String(row.place_id ?? "")) ?? null;
        return {
          area: text(place?.area_name),
          brick: text(place?.brick_name),
          customer: customers.get(String(row.customer_id ?? "")) || null,
          locationFlag: text(row.location_flag),
          place: text(place?.label),
          point: pointOf(row.lat, row.lon) ?? pointOf(place?.pin_lat, place?.pin_lon) ?? pointOf(place?.lat, place?.lon),
          region: text(place?.region_name),
          savedAt: text(row.captured_at),
          unplanned: row.is_unplanned === true,
        };
      });
    const start = dayStarts.find((row) => String(row.started_on) === date) ?? null;
    const partnerKeys = new Set((partnersByDate[date] ?? []).map((id) => personKey(id)));
    const sharedCar = partnerCars
      .filter((row) => {
        if (!partnerKeys.has(personKey(text(row.employee_hr_id)))) return false;
        if (/reject/i.test(String(row.status ?? ""))) return false;
        const from = cairoDateOnly(text(row.trip_start_date));
        const to = cairoDateOnly(text(row.trip_end_date)) ?? from;
        return Boolean(from && to && from <= date && date <= to);
      })
      .map((row) => ({
        name: nameOf(names, text(row.employee_hr_id), text(row.employee_name) ?? "Unknown person"),
        requestId: Number(row.id),
      }));
    return {
      activitiesLogged: activities
        .filter((row) => String(row.activity_date) === date && isDayActivity(row.activity_type))
        .map((row) => dayActivityLabel(row.activity_type as Parameters<typeof dayActivityLabel>[0])),
      date,
      dayStart: start ? { at: String(start.started_at ?? ""), point: pointOf(start.lat, start.lon) } : null,
      managerPlan: managerPlans.get(date) ?? null,
      plan: planByDate.get(date) ?? null,
      rideAlongsPlanned: rideAlongRows
        .filter((row) => String(row.plan_date) === date)
        .map((row) => {
          const other = personKey(text(row.manager_hr_id)) === hrId ? text(row.rep_hr_id) : text(row.manager_hr_id);
          return nameOf(names, other);
        }),
      sharedCar,
      visits,
    };
  });

  // The morning after the trip: only its Day Start matters (for the last night).
  const after = addDaysIso(last, 1);
  const afterStart = dayStarts.find((row) => String(row.started_on) === after) ?? null;
  const reading = buildCrmTripEvidence({
    claimedKm: request.distanceFromResidenceKm ?? null,
    days,
    morningAfter: afterStart ? { at: String(afterStart.started_at ?? ""), point: pointOf(afterStart.lat, afterStart.lon) } : null,
    destination: pointOf(request.capturedLatitude, request.capturedLongitude),
    home: pointOf(request.residenceLatitude, request.residenceLongitude),
    isCar: String(request.transportationType ?? "").toLowerCase() === "car",
    warnings: warnings
      .filter((entry) => personKey(entry.repHrId) === hrId)
      .map((entry) => ({
        label: [integritySourceLabel(entry.source), ...entry.reasons].join(" · "),
        strong: entry.strong,
      })),
  });
  return { found: true, reading, unavailable };
}

/**
 * The week plan of each trip day, from the person's own territories: the day's status asked DAY BY
 * DAY (`planDayStatus` — a week returned for one day is still sent on the others), its planned
 * places with their brick and area, and its planned activities. Shared by the approver's reading and
 * the expense wizard's "your plan for these days" line.
 */
export async function loadTripPlanDays(
  org: Awaited<ReturnType<typeof loadPhoenixCrmOrg>>,
  hrId: string,
  dates: ReadonlyArray<string>,
): Promise<Map<string, NonNullable<CrmTripDayInput["plan"]>>> {
  const out = new Map<string, NonNullable<CrmTripDayInput["plan"]>>();
  const seats = ownTerritories(org, hrId).map((seat) => seat.seatId);
  if (seats.length === 0 || dates.length === 0) return out;
  const start = dates[0];
  const last = dates[dates.length - 1];
  const weeks = [...new Set(dates.map((date) => fieldWeekStart(date)))];
  const supabase = getSupabaseAdmin();
  const plans = await rowsOf(
    supabase
      .from("phoenix_crm_plans")
      .select(`id, week_start, ${PLAN_DAY_COLUMNS}`)
      .eq("is_test", false)
      .in("seat_id", seats)
      .in("week_start", weeks),
  );
  if (plans.length === 0) return out;
  const planIds = plans.map((row) => String(row.id));
  const [facts, items, planned] = await Promise.all([
    loadPlanDayFacts(plans, false),
    rowsOf(
      supabase
        .from("phoenix_crm_plan_items")
        .select("plan_id, plan_date, place:phoenix_crm_places!place_id(label, brick_name, area_name)")
        .in("plan_id", planIds)
        .gte("plan_date", start)
        .lte("plan_date", last),
    ),
    loadPlanActivities(planIds),
  ]);
  const planOfWeek = new Map(plans.map((row) => [String(row.week_start), String(row.id)]));
  for (const date of dates) {
    const planId = planOfWeek.get(fieldWeekStart(date));
    if (!planId) continue;
    const fact = facts.get(planId);
    const status = fact ? planDayStatus({ ...fact, date }) : null;
    const places = items
      .filter((row) => String(row.plan_id) === planId && String(row.plan_date) === date)
      .map((row) => {
        const place = (Array.isArray(row.place) ? row.place[0] : row.place) as Row | null;
        return { area: text(place?.area_name), brick: text(place?.brick_name), label: text(place?.label) };
      });
    out.set(date, {
      activities: (planned.get(date) ?? []).map((entry) => entry.activityLabel),
      places,
      status: (status ?? null) as CrmPlanStatus | null,
    });
  }
  return out;
}

/**
 * The expense wizard's line (owner, 2026-11-07: "Wizard suggests destination"): the areas of the
 * person's SENT plan on the trip days. The destination itself stays the live GPS capture — a
 * plan never fills it — so this only tells the rep where the plan says they will be.
 */
export async function loadPlannedTripAreas(
  hrIdRaw: string,
  startDate: string,
  endDate: string,
): Promise<{ areas: Array<{ area: string; places: number }>; plannedDays: number; tripDays: number }> {
  const hrId = personKey(hrIdRaw);
  const dates = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? tripDates(startDate, endDate) : [];
  if (!hrId || dates.length === 0) return { areas: [], plannedDays: 0, tripDays: dates.length };
  const org = await loadPhoenixCrmOrg();
  // Someone who holds no territory plans nothing, so there is nothing to tell them.
  if (ownTerritories(org, hrId).length === 0) return { areas: [], plannedDays: 0, tripDays: 0 };
  const plans = await loadTripPlanDays(org, hrId, dates);
  const counts = new Map<string, number>();
  let plannedDays = 0;
  for (const plan of plans.values()) {
    if (plan.status !== "submitted" && plan.status !== "approved") continue;
    if (plan.places.length > 0) plannedDays += 1;
    for (const place of plan.places) if (place.area) counts.set(place.area, (counts.get(place.area) ?? 0) + 1);
  }
  return {
    areas: [...counts].map(([area, places]) => ({ area, places })).sort((left, right) => right.places - left.places),
    plannedDays,
    tripDays: dates.length,
  };
}
