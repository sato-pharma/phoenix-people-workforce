/**
 * Phoenix CRM — the single visits a district manager logs himself.
 *
 * Owner, 2026-10-16: "he is submitting single visits if he is alone … with medical rep, the medical rep
 * … submits him." So every planned half-day has an actual: the REP logs the visit naming him when they
 * are together (`phoenix_crm_report_manager_visits`, untouched), and HE logs it here when he is alone —
 * planned (a customer of a single-visit half-day of today) or unplanned (shown apart). Capture location
 * is optional, there is NO photo and no accuracy gate, and the products and the comment are optional.
 *
 * 🔴 THESE VISITS COUNT IN HIS OWN REPORT AND NOWHERE ELSE. `phoenix_crm_manager_visits` is a table of its
 * own precisely so that no KPI, coverage, call-rate, frequency or target reader can pick a row of it up —
 * `tests/phoenix-crm-manager-plan.test.ts` pins that no such reader names it. And the old "My own visit"
 * on a rep's seat is closed to a district manager (`saveVisit`), so there is one path for these, not two.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { parseCapturedFix } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { personKey } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import type { ManagerPlanWriter } from "@/lib/phoenix-crm/manager-plan-rules";
import { assertManagerPlanWriter } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { managerWriterReach } from "@/lib/phoenix-crm/server/manager-plan-writers";
import { loadManagerCustomerRow, loadManagerCustomers, type ManagerCustomerView } from "@/lib/phoenix-crm/server/manager-customers";
import { loadManagerSlotCustomers, loadManagerSlotRows, MANAGER_PLAN_COLUMNS, managerPlanRowOf } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

export const MANAGER_VISIT_COMMENT_MAX = 1000;
export const MANAGER_VISIT_PRODUCTS_MAX = 12;

export type ManagerVisitRow = {
  id: string;
  managerHrId: string;
  planSlotId: string | null;
  isUnplanned: boolean;
  visitDate: string;
  half: "AM" | "PM" | null;
  customerId: string | null;
  managerCustomerId: string | null;
  products: string[];
  comment: string | null;
  hasPin: boolean;
  capturedAt: string | null;
  isTest: boolean;
};

const VISIT_COLUMNS =
  "id, manager_hr_id, plan_slot_id, is_unplanned, visit_date, half, customer_id, manager_customer_id, products, comment, lat, captured_at, is_test";

function visitRowOf(raw: unknown): ManagerVisitRow | null {
  const row = record(raw);
  const id = textOrNull(row.id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const visitDate = textOrNull(row.visit_date)?.slice(0, 10) ?? null;
  if (!id || !managerHrId || !visitDate) return null;
  return {
    id,
    managerHrId,
    planSlotId: textOrNull(row.plan_slot_id),
    isUnplanned: row.is_unplanned === true,
    visitDate,
    half: row.half === "AM" || row.half === "PM" ? row.half : null,
    customerId: textOrNull(row.customer_id),
    managerCustomerId: textOrNull(row.manager_customer_id),
    products: Array.isArray(row.products) ? row.products.map(String) : [],
    comment: textOrNull(row.comment),
    hasPin: row.lat !== null && row.lat !== undefined,
    capturedAt: textOrNull(row.captured_at),
    isTest: row.is_test === true,
  };
}

/** These managers' own visits between two days, in one world. */
export async function loadManagerVisits(managerHrIds: ReadonlyArray<string>, window: { from: string; to: string }, isTest: boolean): Promise<ManagerVisitRow[]> {
  const ids = dedupeIds(managerHrIds);
  if (ids.length === 0) return [];
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_visits")
        .select(VISIT_COLUMNS)
        .in("manager_hr_id", ids)
        .eq("is_test", isTest)
        .gte("visit_date", window.from)
        .lte("visit_date", window.to),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.map(visitRowOf).filter((row): row is ManagerVisitRow => row !== null);
}

// ── Today, on his Visits tab ────────────────────────────────────────────────────────────────────

export type ManagerTodayCustomer = {
  /** The planned half-day this customer is on; null for an unplanned visit. */
  slotId: string | null;
  half: "AM" | "PM" | null;
  customerId: string | null;
  managerCustomerId: string | null;
  name: string;
  speciality: string | null;
  own: boolean;
  logged: boolean;
};

export type ManagerTodayView = {
  isTest: boolean;
  visitDay: string;
  /** Today's planned single-visit customers, each with whether he has logged it. */
  planned: ManagerTodayCustomer[];
  /** What he logged today that was not planned — shown apart. */
  unplanned: ManagerTodayCustomer[];
  /** His own list, for "Log an unplanned customer". */
  ownList: ManagerCustomerView[];
  /** His line's products, by family — what "Products discussed" offers. Optional on every visit. */
  products: string[];
};

/** His line's product families, or none when the line has none on file. */
async function lineProductNames(lineName: string | null | undefined): Promise<string[]> {
  if (!lineName) return [];
  return (await lineProductsByFamily(lineName)).map((entry) => entry.family);
}

/**
 * The product families a planner may name: his seat's line, or — a product manager, who sits on no seat —
 * every line he plans in (Pedia and Anti Infective).
 */
async function writerProductNames(viewer: Pick<PhoenixCrmViewer, "org">, writer: ManagerPlanWriter): Promise<string[]> {
  const lineNames = writer.seat
    ? [writer.seat.lineName]
    : writer.lineCodes.map((code) => viewer.org.territories.find((seat) => seat.lineCode === code && seat.lineName)?.lineName ?? null);
  const lists = await Promise.all(dedupeIds(lineNames.filter((name): name is string => Boolean(name))).map(lineProductNames));
  return [...new Set(lists.flat())];
}

/** Customer names for the visits he logged on rep customers. */
async function loadRepCustomerNames(customerIds: ReadonlyArray<string>): Promise<Map<string, { name: string; speciality: string | null }>> {
  const ids = dedupeIds(customerIds);
  const out = new Map<string, { name: string; speciality: string | null }>();
  if (ids.length === 0) return out;
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, speciality").in("id", ids),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  for (const row of rows) out.set(String(row.id), { name: textOrNull(row.name) ?? "Customer", speciality: textOrNull(row.speciality) });
  return out;
}

/** GET: his single visits of the visit day — planned (from today's single-visit half-days) and unplanned. */
export async function loadManagerToday(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<ManagerTodayView> {
  const writer = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const day = viewer.visitDay;
  const weekStart = fieldWeekStart(day);
  const [planRows, visits, ownList, products] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .eq("manager_hr_id", viewer.hrId)
          .eq("week_start", weekStart)
          .eq("is_test", isTest),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    loadManagerVisits([viewer.hrId], { from: day, to: day }, isTest),
    loadManagerCustomers(viewer.hrId, isTest),
    writerProductNames(viewer, writer),
  ]);
  const plan = planRows.length > 0 ? managerPlanRowOf(planRows[0]) : null;
  const slots = plan ? (await loadManagerSlotRows([plan.planId])).filter((slot) => slot.date === day && slot.kind === "single_visit") : [];
  const slotCustomers = await loadManagerSlotCustomers(slots.map((slot) => slot.slotId));
  const halfOfSlot = new Map(slots.map((slot) => [slot.slotId, slot.half]));
  const loggedKey = new Set(visits.map((visit) => (visit.customerId ? `c:${visit.customerId}` : `m:${visit.managerCustomerId}`)));
  const planned = slotCustomers
    .filter((row) => !row.gone)
    .map((row): ManagerTodayCustomer => ({
      slotId: row.slotId,
      half: halfOfSlot.get(row.slotId) ?? null,
      customerId: row.customerId,
      managerCustomerId: row.managerCustomerId,
      name: row.name,
      speciality: row.speciality,
      own: row.managerCustomerId !== null,
      logged: loggedKey.has(row.customerId ? `c:${row.customerId}` : `m:${row.managerCustomerId}`),
    }))
    .sort((left, right) => String(left.half).localeCompare(String(right.half)) || left.name.localeCompare(right.name));

  const unplannedVisits = visits.filter((visit) => visit.isUnplanned);
  const repNames = await loadRepCustomerNames(unplannedVisits.flatMap((visit) => (visit.customerId ? [visit.customerId] : [])));
  const ownById = new Map(ownList.map((customer) => [customer.id, customer]));
  const unplanned = unplannedVisits.map((visit): ManagerTodayCustomer => {
    const rep = visit.customerId ? repNames.get(visit.customerId) : undefined;
    const own = visit.managerCustomerId ? ownById.get(visit.managerCustomerId) : undefined;
    return {
      slotId: null,
      half: visit.half,
      customerId: visit.customerId,
      managerCustomerId: visit.managerCustomerId,
      name: rep?.name ?? own?.name ?? "Customer",
      speciality: rep?.speciality ?? own?.speciality ?? null,
      own: visit.managerCustomerId !== null,
      logged: true,
    };
  });
  return { isTest, visitDay: day, planned, unplanned, ownList: ownList.filter((customer) => customer.status === "active"), products };
}

// ── Logging one ─────────────────────────────────────────────────────────────────────────────────

const EGYPT = { latMin: 21.5, latMax: 32, lonMin: 24, lonMax: 37.5 };

function productsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError("The products could not be read. Reload the page.");
  const products = [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
  if (products.length > MANAGER_VISIT_PRODUCTS_MAX) throw validationError(`Choose at most ${MANAGER_VISIT_PRODUCTS_MAX} products.`);
  return products;
}

/**
 * POST: one single visit he logs himself, on the visit day. Planned when it names a single-visit half-day
 * of today that holds the customer; unplanned otherwise — a customer of his district's rep lists or of his
 * own list. One visit per customer and day: a second save answers that it is already logged.
 */
export async function logManagerVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerTodayView> {
  const writer = assertManagerPlanWriter(viewer);
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.trim() : "";
  if (clientRef.length < 8 || clientRef.length > 100) throw validationError("This visit could not be read. Reload the page.");
  const customerId = textOrNull(body.customerId);
  const managerCustomerId = textOrNull(body.managerCustomerId);
  if ((customerId === null) === (managerCustomerId === null)) throw validationError("Choose the customer you visited.");
  if (!isUuid(customerId ?? managerCustomerId)) throw validationError("This customer could not be read. Reload the page.");
  const comment = typeof body.comment === "string" ? body.comment.trim().replace(/\s+/g, " ") || null : null;
  if (comment && comment.length > MANAGER_VISIT_COMMENT_MAX) throw validationError(`Keep the comment under ${MANAGER_VISIT_COMMENT_MAX} characters.`);
  const products = productsOf(body.products);
  if (products.length > 0) {
    const allowed = new Set(await writerProductNames(viewer, writer));
    if (products.some((product) => !allowed.has(product))) throw validationError("Choose the products from your line's products. Reload the page.");
  }
  const day = viewer.visitDay;

  // Whose customer: a rep's of a district he plans in, or one of his own list — in his world.
  let customerLineCode: string | null = null;
  if (customerId) {
    const district = new Set((await managerWriterReach(viewer, writer)).map((entry) => entry.seatId));
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, status, is_test").eq("id", customerId),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    const row = rows[0];
    if (!row || row.is_test !== isTest || (row.status !== "active" && row.status !== "pending")) {
      throw notFoundError("This customer is no longer on the list. Reload the page.");
    }
    if (!district.has(String(row.seat_id ?? ""))) {
      throw forbiddenError(writer.kind === "dm" ? "Log a visit to a customer of your own district." : "Log a visit to a customer of a district you plan in.");
    }
    customerLineCode = viewer.org.seats.get(String(row.seat_id))?.lineCode ?? null;
  } else if (managerCustomerId) {
    const own = await loadManagerCustomerRow(managerCustomerId);
    if (!own || own.managerHrId !== viewer.hrId || own.isTest !== isTest || own.status === "removed") {
      throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
    }
  }

  // Planned: a single-visit half-day of TODAY that holds this customer.
  let slotId: string | null = null;
  let half: "AM" | "PM" | null = null;
  const askedSlot = textOrNull(body.slotId);
  if (askedSlot) {
    const plans = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select("id")
          .eq("manager_hr_id", viewer.hrId)
          .eq("week_start", fieldWeekStart(day))
          .eq("is_test", isTest),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    const slots = plans.length > 0 ? await loadManagerSlotRows([String(plans[0].id)]) : [];
    const slot = slots.find((entry) => entry.slotId === askedSlot && entry.date === day && entry.kind === "single_visit");
    if (!slot) throw conflictError("This half-day is no longer on today's plan. Reload the page.");
    const held = await loadManagerSlotCustomers([slot.slotId]);
    if (!held.some((entry) => (customerId ? entry.customerId === customerId : entry.managerCustomerId === managerCustomerId))) {
      throw conflictError("This customer is no longer on today's plan. Reload the page.");
    }
    slotId = slot.slotId;
    half = slot.half;
  }

  let pin: Row = {};
  const rawPin = record(body.pin);
  if (rawPin.lat !== undefined || rawPin.lon !== undefined) {
    const fix = parseCapturedFix(rawPin, "The location could not be read. Press Capture location again, or log the visit without it.");
    if (!fix.ok) throw validationError(fix.error);
    const { lat, lon, accuracyMeters } = fix.value;
    if (lat < EGYPT.latMin || lat > EGYPT.latMax || lon < EGYPT.lonMin || lon > EGYPT.lonMax) {
      throw validationError("This location is outside Egypt. Capture it again, or log the visit without it.");
    }
    pin = { lat, lon, accuracy_meters: accuracyMeters };
  }

  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_visits")
    .insert({
      manager_hr_id: viewer.hrId,
      // A product manager sits on no seat: his visit carries the line of the customer's territory.
      manager_seat_id: writer.seat?.seatId ?? null,
      line_code: writer.seat?.lineCode ?? customerLineCode,
      plan_slot_id: slotId,
      is_unplanned: slotId === null,
      visit_date: day,
      half,
      customer_id: customerId,
      manager_customer_id: managerCustomerId,
      products,
      comment,
      ...pin,
      client_ref: clientRef,
      entered_by_hr_id: viewer.hrId,
      is_test: isTest,
    });
  if (error) {
    if ((error as { code?: unknown }).code === "23505") {
      // The same save sent twice (its client ref) answers as saved; a second visit to the customer today is refused.
      const again = await fetchAllRowsKeyset<Row>(
        () => getSupabaseAdmin().from("phoenix_crm_manager_visits").select("id").eq("client_ref", clientRef),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      );
      if (again.length === 0) throw conflictError("You already logged a visit to this customer today.");
    } else {
      throw error;
    }
  }
  return loadManagerToday(viewer, { test: isTest });
}

/** The first day of the window the report reads: the week's Saturday. Kept here so both readers agree. */
export function managerVisitWindow(weekStart: string): { from: string; to: string } {
  return { from: weekStart, to: addDaysIso(weekStart, 5) };
}
