/**
 * Phoenix CRM — "Show visit times" on a manager's plan board (owner, 2026-11-05). What each line means is in
 * `visit-times-rules.ts`; this file only reads.
 *
 * GET for the territories he is planning with (the rep he goes with, or every territory of the area he makes
 * single visits in) and the day he plans: per customer, the days and hours saved on its places, the rep's last
 * visit with its time, and his own last visit. Read only while the toggle is ON — off, nothing asks for it.
 *
 * 🔴 HIS OWN ONLY — gated exactly as the month marks are (`loadManagerCustomerMarks`): `assertManagerPlanWriter`,
 * and every territory asked for must be one he plans in (`managerWriterReach`); one outside it refuses the
 * whole ask.
 *
 * TWO REQUESTS, side by side: `phoenix_crm_customer_last_visits` (20261105210430) returns the newest visit per
 * customer, the visits that name him and the places' hours in one jsonb object — a PostgREST read cannot ask for
 * "the newest row per customer", and an area's twenty-six weeks are ~10,000 visits. His own single visits are
 * read here, by his own id, as the month marks read them: they never go into a database function or a view
 * (`tests/phoenix-crm-manager-plan-source.test.ts`), and twenty-six weeks of his are a few hundred rows.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { isRamadanDay } from "@/lib/phoenix-crm/calendar";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { mapTimings } from "@/lib/phoenix-crm/server/list";
import { parseSeatList } from "@/lib/phoenix-crm/server/manager-customer-marks";
import { assertManagerPlanWriter } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { managerWriterReach } from "@/lib/phoenix-crm/server/manager-plan-writers";
import {
  buildCustomerVisitTimes,
  VISIT_TIMES_WINDOW_DAYS,
  type CustomerVisitTimesView,
  type LastVisitRow,
  type OwnVisitRow,
  type PlaceHoursRow,
} from "@/lib/phoenix-crm/visit-times-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === "object") as Row[]) : [];
}

function visitRow(row: Row): LastVisitRow {
  return {
    customerId: String(row.customer_id ?? ""),
    visitDate: String(row.visit_date ?? ""),
    capturedAt: textOrNull(row.captured_at),
    imported: row.imported === true,
    kind: row.kind,
    managerHrId: row.manager_hr_id,
    seniorHrId: row.senior_hr_id,
    productManagerHrId: row.product_manager_hr_id,
    companionHrIds: Array.isArray(row.companion_hr_ids) ? row.companion_hr_ids : [],
  };
}

async function readOwnVisits(managerHrId: string, isTest: boolean, since: string): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_visits")
        .select("id, customer_id, manager_customer_id, visit_date, captured_at")
        .eq("manager_hr_id", managerHrId)
        .eq("is_test", isTest)
        .gte("visit_date", since),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

/** GET: the visit times for every customer on the asked territories' lists (and, with `own`, Manager's own list). */
export async function loadManagerCustomerVisitTimes(
  viewer: PhoenixCrmViewer,
  raw: { seats: unknown; own: unknown; date: unknown; test: unknown },
): Promise<CustomerVisitTimesView> {
  const writer = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const seatIds = parseSeatList(raw.seats);
  const date = raw.date === null || raw.date === undefined || raw.date === "" ? viewer.cairoToday : raw.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationError("The day must be a date.");
  const reach = await managerWriterReach(viewer, writer);
  const inReach = new Set(reach.map((seat) => seat.seatId));
  if (seatIds.some((seatId) => !inReach.has(seatId))) throw forbiddenError("Choose a rep or an area you plan with.");
  const withOwn = raw.own === "true" || raw.own === true;

  const since = addDaysIso(viewer.cairoToday, -VISIT_TIMES_WINDOW_DAYS);
  const [last, ownRows] = await Promise.all([
    getSupabaseAdmin().rpc("phoenix_crm_customer_last_visits", { p_seat_ids: seatIds, p_is_test: isTest, p_since: since, p_hr_id: writer.hrId }),
    readOwnVisits(writer.hrId, isTest, since),
  ]);
  if (last.error) throw last.error;
  const body = (last.data ?? {}) as Row;

  const own: OwnVisitRow[] = ownRows
    .map((row) => ({
      customerId: textOrNull(row.customer_id),
      managerCustomerId: textOrNull(row.manager_customer_id),
      visitDate: String(row.visit_date ?? ""),
      capturedAt: textOrNull(row.captured_at),
    }))
    // A single visit to a customer of his own list shows only where his own list is on screen.
    .filter((row) => row.customerId !== null || withOwn);
  const hours: PlaceHoursRow[] = rowsOf(body.hours).map((row) => ({
    customerId: String(row.customer_id ?? ""),
    label: textOrNull(row.label),
    timings: mapTimings(row.timings),
  }));

  return {
    since,
    ramadan: isRamadanDay(date, viewer.config.ramadanOverrides),
    customers: buildCustomerVisitTimes({
      plannerHrId: writer.hrId,
      latest: rowsOf(body.latest).map(visitRow),
      named: rowsOf(body.with_person).map(visitRow),
      own,
      hours,
    }),
  };
}
