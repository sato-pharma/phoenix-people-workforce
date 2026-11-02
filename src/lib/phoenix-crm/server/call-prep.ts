/**
 * Phoenix CRM — the read behind tomorrow's call prep (the rules are call-prep.ts).
 *
 * STRICTLY READ-ONLY, and OFF THE PLAN-CHANGE PATH: it reads the plan as it stands through the
 * module's own door (`loadPlannedDay`, which asks `plannedCustomersOn`'s rule — the same one Today and
 * Planned visit use, so the rep and his manager never read two different plans) and writes nothing.
 * There is no transition, no save, no "move this stop" — a sent week changes only through "Ask to edit
 * this week" (owner, 2026-10-01).
 *
 * Four reads, all of them the module's own, none of them new:
 *
 *   - tomorrow's stops — `loadPlannedDay(seat, isTest, tomorrow)` (visits.ts), ONE request since
 *     2 Nov 2026 that answers the DAY's own status (`planDayStatus`), so a week returned for one OTHER
 *     day still stands as sent on this one, and carries the stops' customers with it;
 *   - the names and list types — the customers `loadTerritoryCustomers(..., { onListOnly: true })`
 *     reads, the planner's own customer read, for the day's stops alone — they ride in that same request;
 *   - when he was last seen — `loadPlannerInsights`, the plan board's own insight. It is the read that
 *     folds iReports360's history in beside his Phoenix visits, which matters most for exactly the
 *     customers this screen is for: a carried-over doctor he has not logged in Phoenix yet still has a
 *     last visit, and the Phoenix read alone would print "never seen" over it;
 *   - what was said last time — over the SAME six-month window the visit form uses, carrying products,
 *     the next step and the objection together. It and the insight's own Phoenix visits are ONE read
 *     (`loadPrepVisits`), each cut back to its own window.
 *
 * 🔴 THE GATE IS THE REP'S OWN SEAT (`territoryForRepWrite`), ON A READ — the same boundary, and the
 * same reasoning, as `server/commitments.ts`: Golden rule #1's line is WHOSE WORK IT IS. His plan and
 * what he wrote at his own visits are his; a manager reads the team boards, never a rep's prep notes.
 * No predicate is widened, and the Super Admin reaches it in test mode only.
 *
 * 🔴 AND IT IS THE RAW VISITS TABLE, NOT `phoenix_crm_countable_visits`. A visit waiting on its
 * off-plan approval is still a visit he made, so what the doctor said at it is still what the doctor
 * said. The visit form's own `loadLastVisits` reads the raw table for exactly this reason.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { logError } from "@/lib/observability/log";
import {
  buildCallPrep,
  callPrepEmptyNote,
  nextFieldDayAfter,
  pickLastObjection,
  type CallPrepLine,
  type CallPrepStop,
  type LastObjectionRow,
} from "@/lib/phoenix-crm/call-prep";
import { VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { pickLastVisitProducts, type LastVisitProducts } from "@/lib/phoenix-crm/last-visit-products";
import { LAST_SEEN_WINDOW_DAYS } from "@/lib/phoenix-crm/plan-insight";
import { isPlanSentForReview } from "@/lib/phoenix-crm/plan-rules";
import { readTestFlag, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import type { ListPlace } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlannerInsights } from "@/lib/phoenix-crm/server/plan-insight";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { loadPlannedDay } from "@/lib/phoenix-crm/server/visits";
import { pickLastNextStep, type LastNextStep, type LastNextStepRow, type VisitObjection } from "@/lib/phoenix-crm/visit-outcome";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * How far back "what was said last time" is read: SIX MONTHS, the visit form's own window
 * (`LAST_VISIT_MONTHS` in server/visits.ts). A doctor not seen since last winter is a conversation to
 * have fresh rather than one to reopen with whatever was said then, and the read stays small on a
 * territory that has been running a year. Kept as its own named constant rather than imported,
 * because that one is private to the form — the WINDOW is shared, the declaration is not.
 */
export const CALL_PREP_LAST_VISIT_MONTHS = 6;

/** The first day of the month `months` before this Cairo day. Arithmetic on the parts, so no zone shifts it. */
function monthsBackFrom(isoDay: string, months: number): string {
  const [year, month] = isoDay.split("-").map((part) => Number(part));
  const zeroBased = (year ?? 0) * 12 + (month ?? 1) - 1 - months;
  return `${String(Math.floor(zeroBased / 12)).padStart(4, "0")}-${String((zeroBased % 12) + 1).padStart(2, "0")}-01`;
}

export type CallPrepView = {
  territory: TerritorySummary;
  isTest: boolean;
  /** The VISIT day this was asked from — until 02:00 the day that just ended (owner, 2026-09-29). */
  today: string;
  /** The day being prepared: the next day a plan can hold, so Thursday's "tomorrow" is the Saturday. */
  date: string;
  /** Whether that day stands on a SENT plan (`isPlanDaySent`'s own reading of the day). */
  planSent: boolean;
  lines: CallPrepLine[];
  /** One sentence when there is nothing to prepare, else null. */
  emptyNote: string | null;
};

/**
 * His visits, ONCE, for both things this screen says about them (2026-10-16 Phoenix CRM performance
 * audit — it used to read the same table twice, side by side): "what was said last time" over the
 * six-month window, and "last seen" over `LAST_SEEN_WINDOW_DAYS`. The read starts at the EARLIER of
 * the two first days and has no upper bound, because "last seen" never had one; each consumer cuts its
 * own window back out of these rows (`loadLastSaid` below, `loadPlannerInsights` through its
 * `visitsRead` option), so each answers exactly what its own read answered. The columns are the two
 * selects' together.
 */
function loadPrepVisits(seatId: string, isTest: boolean, today: string): Promise<Row[]> {
  const lastSaidSince = monthsBackFrom(today, CALL_PREP_LAST_VISIT_MONTHS);
  const lastSeenSince = addDaysIso(today, -LAST_SEEN_WINDOW_DAYS);
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, customer_id, visit_date, captured_at, products, next_step, next_step_on, objection")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .gte("visit_date", lastSaidSince < lastSeenSince ? lastSaidSince : lastSeenSince),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

/**
 * What was said at the last visit per customer: the products, the still-open next step and the
 * objection, from ONE read.
 *
 * The three picks are kept APART on purpose and all three are the module's own rules:
 * `pickLastVisitProducts` deliberately drops a customer whose last products have all been retired from
 * the line, and a promise or an objection on that same visit still stands — folding them together
 * would lose both.
 */
async function loadLastSaid(
  today: string,
  visitsRead: Promise<Row[]>,
  lineProductsRead: Promise<readonly string[]>,
): Promise<{
  products: Map<string, LastVisitProducts>;
  nextSteps: Map<string, LastNextStep>;
  objections: Map<string, VisitObjection>;
}> {
  const since = monthsBackFrom(today, CALL_PREP_LAST_VISIT_MONTHS);
  // The six-month window, cut out of the one visits read (`loadPrepVisits`) in the order it came back.
  // An ISO day compares as text exactly as the date column does, and a row with no day is one the
  // date filters would never have returned. `<= today` and not `< today`: this prepares TOMORROW, so
  // today's own visits are the freshest thing he knows about a doctor he is seeing again. (The visit
  // form uses `.lt` because a second visit on the same day must not prefill itself from the first.)
  const rows = (await visitsRead).filter((row) => {
    const day = String(row.visit_date ?? "");
    return day >= since && day <= today;
  });
  const base = rows.map((row) => ({
    customerId: String(row.customer_id ?? ""),
    visitDate: String(row.visit_date ?? ""),
    capturedAt: String(row.captured_at ?? ""),
  }));
  const lineProducts = await lineProductsRead;
  const nextStepRows: LastNextStepRow[] = rows.map((row, index) => ({
    ...base[index],
    nextStep: textOrNull(row.next_step),
    nextStepOn: textOrNull(row.next_step_on),
  }));
  const objectionRows: LastObjectionRow[] = rows.map((row, index) => ({ ...base[index], objection: textOrNull(row.objection) }));
  return {
    products: pickLastVisitProducts(
      rows.map((row, index) => ({
        ...base[index],
        products: Array.isArray(row.products) ? (row.products as unknown[]).map((entry) => String(entry)) : [],
      })),
      lineProducts,
      VISIT_PRODUCTS_MAX,
    ),
    nextSteps: pickLastNextStep(nextStepRows),
    objections: pickLastObjection(objectionRows),
  };
}

export async function loadCallPrep(viewer: PhoenixCrmViewer, raw: { seatId: unknown; test: unknown }): Promise<CallPrepView> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));
  const today = viewer.visitDay;
  const date = nextFieldDayAfter(today);

  // Started together, each the moment it can be: only the insight waits on the customer list, and the
  // product names are handed over as a PROMISE because only the pick below needs them (the visit
  // form's own shape).
  //
  // 🔴 THE CUSTOMER LIST IS READ FOR THE DAY'S STOPS ALONE (2026-10-16 Phoenix CRM performance audit),
  // Today's own shape. Nothing on this screen names anyone else: the stops are looked up by id, and the
  // insight is read only to be read back for them, so reading the whole territory (and iReports360's
  // history behind every customer on it) bought rows nobody saw. Same filters, so a planned customer who
  // has left the list is still not a stop, and a day that is not sent reads nobody — it shows no stops
  // either way. Since 2 Nov 2026 the plan, the day's standing and the stops are ONE request
  // (`loadPlannedDay`, visits.ts), where they were five waves of ~450 ms each.
  const dayRead = loadPlannedDay(seat.seatId, isTest, date);
  const plannedRead = dayRead.then(({ planned }) => planned);
  const customersRead = dayRead.then(({ stops }) => stops);
  const lineProductsRead = lineProductsByFamily(seat.lineName).then((families) => families.map((entry) => entry.family));
  lineProductsRead.catch(() => undefined);
  const visitsRead = loadPrepVisits(seat.seatId, isTest, today);
  visitsRead.catch(() => undefined);

  const [planned, { customers }, lastSaid, insights, names] = await Promise.all([
    plannedRead,
    customersRead,
    loadLastSaid(today, visitsRead, lineProductsRead),
    // A NICETY NEVER TAKES THE SCREEN DOWN: `loadPlannerInsights` logs and answers an empty map rather
    // than throwing, so a failed iReports360 read costs the "last seen" fact and nothing else.
    insightsOrEmpty(seat.seatId, isTest, today, customersRead, visitsRead),
    loadPeopleNames(territoryPeople(viewer.org, [seat])),
  ]);

  const byId = new Map(customers.map((row) => [String(row.id), row]));
  const planSent = isPlanSentForReview(planned.status);
  const stops: CallPrepStop[] = planSent
    ? planned.customerIds
        .map((customerId) => {
          const row = byId.get(customerId);
          // Planned before the customer left the list. He is not a stop any more, and the Plan screen
          // is where that is explained — this screen only prepares the ones he will see.
          return row ? { customerId, customerName: String(row.name ?? ""), listType: row.list_type } : null;
        })
        .filter((stop): stop is CallPrepStop => stop !== null)
    : [];

  const lines = buildCallPrep({
    stops,
    lastSeen: insights,
    products: lastSaid.products,
    openNextSteps: lastSaid.nextSteps,
    objections: lastSaid.objections,
  });

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    today,
    date,
    planSent,
    lines,
    emptyNote: callPrepEmptyNote({ planSent, stops: lines.length }),
  };
}

/** `loadPlannerInsights` already answers an empty map on its own failure; this guards the one path it cannot. */
async function insightsOrEmpty(
  seatId: string,
  isTest: boolean,
  today: string,
  customersRead: Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }>,
  visitsRead: Promise<Row[]>,
): Promise<ReadonlyMap<string, { lastSeenOn: string | null }>> {
  try {
    return await loadPlannerInsights(seatId, isTest, today, customersRead, { visitsRead });
  } catch (error) {
    logError("Phoenix CRM call prep could not read when each customer was last seen", {
      error,
      labels: { event: "phoenix_crm_call_prep_insight_failed" },
    });
    return new Map();
  }
}
