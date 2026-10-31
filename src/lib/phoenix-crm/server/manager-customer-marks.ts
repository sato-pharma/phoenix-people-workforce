/**
 * Phoenix CRM — the customer marks on a manager's plan board (owner, 2026-10-23). The rules and what each
 * mark means are in `manager-customer-marks-rules.ts`; this file only reads.
 *
 * GET for a set of his reps' territories (the rep he goes with, or every territory of the area he makes
 * single visits in) and the day he is planning: per customer, the grade and its monthly number, the rep's
 * visits that month, his own visits with that rep and alone, and a live marketing request.
 *
 * 🔴 HIS OWN ONLY — `assertManagerPlanWriter`, and every territory asked for must be one he plans in
 * (`managerWriterReach`), exactly as the area list (`loadAreaCustomers`) is gated. A territory outside it is
 * refused whole, never quietly dropped.
 *
 * 🔴 THE REP'S VISITS ARE `phoenix_crm_countable_visits`, READ THE WAY THE REP'S OWN LIST READS THEM
 * (`loadMonthVisitCounts`) — an off-plan visit nobody approved counts nowhere, here included.
 *
 * 🔴 THE MARKETING LINK IS `marketing_customers.phoenix_crm_customer_id` FIRST (written since 2026-10-23,
 * when Customer Validation began picking the customer from a rep's list). A customer validated before that
 * carries no link, so a request is also matched by NAME — but only on the list of the rep who raised it (or
 * any list in reach when the manager raised it himself), and only when exactly ONE customer there carries
 * that name. Namesakes are real; an ambiguous name is shown nowhere rather than on the wrong customer, and a
 * name match says so on the chip.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { marketingRequestStatusLabel } from "@/lib/marketing-requests/roi-labels";
import { monthEndOf, monthStartOf } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import {
  LIVE_MARKETING_STATUSES,
  ownInsightKey,
  type CustomerInsight,
  type CustomerInsightView,
  type CustomerMarketingMark,
} from "@/lib/phoenix-crm/manager-customer-marks-rules";
import { countsAsPlannersVisitWithRep } from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadManagerCustomers } from "@/lib/phoenix-crm/server/manager-customers";
import { assertManagerPlanWriter } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { managerWriterReach } from "@/lib/phoenix-crm/server/manager-plan-writers";
import { loadVisitCompanionIds } from "@/lib/phoenix-crm/server/visit-companions";
import { loadPhoenixCrmConfig } from "@/lib/phoenix-crm/server/settings";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** An area holds a handful of territories; more than this in one ask is not a screen of his. */
const SEATS_MAX = 40;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function gradeOf(value: unknown): PhoenixCrmGrade | null {
  return value === "A" || value === "B" || value === "C" ? value : null;
}

function listTypeOf(value: unknown): PhoenixCrmDoctorListType | null {
  return value === "AM" || value === "PM" ? value : null;
}

function isoDay(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validationError("The day must be a date.");
  return value;
}

export function parseSeatList(value: unknown): string[] {
  const seats = dedupeIds(typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : []);
  if (seats.length === 0) throw validationError("Choose a rep or an area first.");
  if (seats.length > SEATS_MAX) throw validationError(`Ask for ${SEATS_MAX} territories at most.`);
  return seats;
}

async function readCustomers(seatIds: ReadonlyArray<string>, isTest: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk(seatIds, 50)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_customers")
            .select("id, seat_id, name, grade, list_type, primary_pharmacy_name")
            .in("seat_id", part)
            .eq("is_test", isTest)
            .in("status", ["active", "pending"])
            .in("list_type", ["AM", "PM"]),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

async function readRepVisits(seatIds: ReadonlyArray<string>, isTest: boolean, from: string, through: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk(seatIds, 50)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_countable_visits_with_history")
            .select("id, customer_id, visit_date, kind, manager_hr_id, senior_hr_id, product_manager_hr_id")
            .in("seat_id", part)
            .eq("is_test", isTest)
            .gte("visit_date", from)
            .lte("visit_date", through),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  return rows;
}

async function readOwnVisits(managerHrId: string, isTest: boolean, from: string, through: string): Promise<Row[]> {
  return fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_visits")
        .select("id, customer_id, manager_customer_id")
        .eq("manager_hr_id", managerHrId)
        .eq("is_test", isTest)
        .gte("visit_date", from)
        .lte("visit_date", through),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

/** `live`: a request in a live status only. `current`: a marketing customer still active and not merged away. */
type SelectFilter = "live" | "current" | null;

async function selectIn(table: string, columns: string, column: string, values: ReadonlyArray<string>, filter: SelectFilter = null): Promise<Row[]> {
  const rows: Row[] = [];
  for (const part of chunk(values, 150)) {
    const base = getSupabaseAdmin().from(table).select(columns).in(column, part);
    const result = await (filter === "live" ? base.in("status", [...LIVE_MARKETING_STATUSES]) : filter === "current" ? base.eq("active", true).is("merged_into_customer_id", null) : base);
    if (result.error) throw result.error;
    rows.push(...((result.data ?? []) as unknown as Row[]));
  }
  return rows;
}

type MarketingInput = {
  customers: ReadonlyArray<{ id: string; seatId: string; name: string }>;
  occupantBySeat: ReadonlyMap<string, string>;
  managerHrId: string;
};

/** Live marketing requests per rep-list customer id — the stored link first, then a unique name on the requester's own list. */
async function readMarketing(input: MarketingInput): Promise<Map<string, CustomerMarketingMark[]>> {
  const marks = new Map<string, CustomerMarketingMark[]>();
  if (input.customers.length === 0) return marks;
  const customerIds = input.customers.map((customer) => customer.id);
  const requesters = dedupeIds([...input.occupantBySeat.values(), input.managerHrId]);

  const [linked, byRequester] = await Promise.all([
    selectIn("marketing_customers", "id", "phoenix_crm_customer_id", customerIds, "current"),
    selectIn("marketing_requests", "id", "requester_hr_id", requesters, "live"),
  ]);
  const linkedRequests = linked.length
    ? await selectIn("marketing_requests", "id", "customer_id", dedupeIds(linked.map((row) => textOrNull(row.id))), "live")
    : [];
  const requestIds = dedupeIds([...linkedRequests, ...byRequester].map((row) => textOrNull(row.id)));
  if (requestIds.length === 0) return marks;

  const requests = await selectIn(
    "marketing_requests",
    "id, request_code, requester_hr_id, customer_id, status, request_type_id, other_request_type",
    "id",
    requestIds,
  );
  const [marketingCustomers, types] = await Promise.all([
    selectIn("marketing_customers", "id, display_name, phoenix_crm_customer_id, active, merged_into_customer_id", "id", dedupeIds(requests.map((row) => textOrNull(row.customer_id)))),
    selectIn("marketing_request_types", "id, name", "id", dedupeIds(requests.map((row) => textOrNull(row.request_type_id)))),
  ]);
  const customerById = new Map(marketingCustomers.map((row) => [String(row.id), row]));
  const typeName = new Map(types.map((row) => [String(row.id), textOrNull(row.name)]));

  const known = new Set(customerIds);
  // Folded names per territory, and over every territory in reach, for the name match.
  const foldedBySeat = new Map<string, Map<string, string[]>>();
  const foldedAll = new Map<string, string[]>();
  for (const customer of input.customers) {
    const folded = normalizeContactName(customer.name);
    if (!folded) continue;
    const seatMap = foldedBySeat.get(customer.seatId) ?? new Map<string, string[]>();
    seatMap.set(folded, [...(seatMap.get(folded) ?? []), customer.id]);
    foldedBySeat.set(customer.seatId, seatMap);
    foldedAll.set(folded, [...(foldedAll.get(folded) ?? []), customer.id]);
  }
  const seatsOf = new Map<string, string[]>();
  for (const [seatId, hrId] of input.occupantBySeat) seatsOf.set(hrId, [...(seatsOf.get(hrId) ?? []), seatId]);

  for (const request of requests) {
    const marketingCustomer = customerById.get(String(request.customer_id ?? ""));
    if (!marketingCustomer || marketingCustomer.active === false || textOrNull(marketingCustomer.merged_into_customer_id)) continue;
    let target: string | null = null;
    let byName = false;
    const stored = textOrNull(marketingCustomer.phoenix_crm_customer_id);
    if (stored) {
      target = known.has(stored) ? stored : null;
    } else {
      const folded = normalizeContactName(textOrNull(marketingCustomer.display_name));
      const requester = personKey(textOrNull(request.requester_hr_id));
      if (folded && requester) {
        const ownSeats = seatsOf.get(requester);
        const hits = ownSeats
          ? ownSeats.flatMap((seatId) => foldedBySeat.get(seatId)?.get(folded) ?? [])
          : requester === personKey(input.managerHrId)
            ? (foldedAll.get(folded) ?? [])
            : [];
        if (hits.length === 1) {
          target = hits[0];
          byName = true;
        }
      }
    }
    if (!target) continue;
    const status = String(request.status ?? "");
    const mark: CustomerMarketingMark = {
      requestId: String(request.id),
      code: textOrNull(request.request_code) ?? "Request",
      status,
      statusLabel: marketingRequestStatusLabel(status),
      typeName: typeName.get(String(request.request_type_id ?? "")) ?? textOrNull(request.other_request_type),
      byName,
    };
    marks.set(target, [...(marks.get(target) ?? []), mark]);
  }
  return marks;
}

/**
 * GET: the marks for every customer on the asked territories' lists (and, with `own`, on Manager's own list),
 * for the month of the day he plans.
 */
export async function loadManagerCustomerMarks(
  viewer: PhoenixCrmViewer,
  raw: { seats: unknown; own: unknown; date: unknown; test: unknown },
): Promise<CustomerInsightView> {
  const writer = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const seatIds = parseSeatList(raw.seats);
  const day = isoDay(raw.date, viewer.cairoToday);
  const reach = await managerWriterReach(viewer, writer);
  const reachById = new Map(reach.map((seat) => [seat.seatId, seat]));
  if (seatIds.some((seatId) => !reachById.has(seatId))) throw forbiddenError("Choose a rep or an area you plan with.");

  const monthStart = monthStartOf(day);
  const monthEnd = monthEndOf(day);
  const through = monthEnd < viewer.cairoToday ? monthEnd : viewer.cairoToday;
  const monthAhead = through < monthStart;
  const withOwn = raw.own === "true" || raw.own === true;

  const [customers, config, repVisits, ownVisits, ownList] = await Promise.all([
    readCustomers(seatIds, isTest),
    loadPhoenixCrmConfig(),
    monthAhead ? Promise.resolve([] as Row[]) : readRepVisits(seatIds, isTest, monthStart, through),
    monthAhead ? Promise.resolve([] as Row[]) : readOwnVisits(writer.hrId, isTest, monthStart, through),
    withOwn ? loadManagerCustomers(writer.hrId, isTest) : Promise.resolve([]),
  ]);

  // Everyone a chain or product-manager visit lists past its fixed places (owner, 2026-10-27: "Everything
  // is applicable") — only those two kinds can carry more than the fixed places, so only they are read.
  const companionsByVisit = await loadVisitCompanionIds(
    repVisits.filter((visit) => visit.kind === "chain" || visit.kind === "product_manager").map((visit) => String(visit.id)),
  );

  const occupantBySeat = new Map<string, string>();
  for (const seatId of seatIds) {
    const occupant = personKey(reachById.get(seatId)?.occupantHrId);
    if (occupant) occupantBySeat.set(seatId, occupant);
  }
  const listed = customers.flatMap((row) => {
    const id = textOrNull(row.id);
    const seatId = textOrNull(row.seat_id);
    return id && seatId ? [{ id, seatId, name: textOrNull(row.name) ?? "", row }] : [];
  });
  const marketing = await readMarketing({ customers: listed, occupantBySeat, managerHrId: writer.hrId });

  const insights: Record<string, CustomerInsight> = {};
  for (const { id, row } of listed) {
    const grade = gradeOf(row.grade);
    const listType = listTypeOf(row.list_type);
    insights[id] = {
      grade,
      listType,
      target: listType ? gradeTarget(config.settings, listType, grade) : null,
      repVisits: 0,
      lastRepVisit: null,
      withYou: 0,
      yourOwn: 0,
      pharmacy: textOrNull(row.primary_pharmacy_name),
      marketing: marketing.get(id) ?? [],
    };
  }
  for (const visit of repVisits) {
    const insight = insights[String(visit.customer_id ?? "")];
    if (!insight) continue;
    insight.repVisits += 1;
    const date = textOrNull(visit.visit_date);
    if (date && (!insight.lastRepVisit || date > insight.lastRepVisit)) insight.lastRepVisit = date;
    const withPlanner = countsAsPlannersVisitWithRep(
      {
        kind: visit.kind,
        managerHrId: visit.manager_hr_id,
        seniorHrId: visit.senior_hr_id,
        productManagerHrId: visit.product_manager_hr_id,
        companionHrIds: companionsByVisit.get(String(visit.id)),
      },
      writer.hrId,
    );
    if (withPlanner) insight.withYou += 1;
  }
  for (const customer of ownList) {
    if (customer.status !== "active") continue;
    insights[ownInsightKey(customer.id)] = {
      grade: gradeOf(customer.grade),
      listType: null,
      target: null,
      repVisits: 0,
      lastRepVisit: null,
      withYou: 0,
      yourOwn: 0,
      pharmacy: null,
      marketing: [],
    };
  }
  for (const visit of ownVisits) {
    const customerId = textOrNull(visit.customer_id);
    const managerCustomerId = textOrNull(visit.manager_customer_id);
    const insight = customerId ? insights[customerId] : managerCustomerId ? insights[ownInsightKey(managerCustomerId)] : undefined;
    if (insight) insight.yourOwn += 1;
  }

  return { month: day.slice(0, 7), monthName: MONTH_NAMES[Number(day.slice(5, 7)) - 1] ?? day.slice(0, 7), monthAhead, insights };
}
