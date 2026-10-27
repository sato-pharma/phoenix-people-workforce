/**
 * Phoenix CRM — the single visits a district manager logs himself.
 *
 * Owner, 2026-10-16: "he is submitting single visits if he is alone … with medical rep, the medical rep
 * … submits him." So every planned half-day has an actual: the REP logs the visit naming him when they
 * are together (`phoenix_crm_report_manager_visits`, untouched), and HE logs it here when he is alone —
 * planned (a customer of a single-visit half-day of today) or unplanned (shown apart). Capture location
 * is optional, there is NO photo and no accuracy gate, and the products and the comment are optional.
 *
 * 🔴 EVERY SINGLE VISIT CARRIES THE ADD-A-CUSTOMER PLACE BLOCK (owner, 2026-10-20: the unplanned form
 * "asks for a location or address and there is no place to write the address … it should be as the screen
 * when adding new customer"). Capture location, the address, and the area → brick cascade, on every one of
 * them; whatever he typed, chose or captured is stored on the visit and shown back on its card.
 *
 * 🔴 AND IN A VACANT AREA ONE OF THE TWO IS REQUIRED (owner, 2026-10-19). He picks his customers from a
 * vacant area's list — the previous rep's — and a visit to one of them needs the doctor's address typed by
 * hand OR a captured location, whose address, area and brick are filled in for him: "either this or this".
 * Nobody holds the territory, so this visit is the only record of where its doctor is
 * (`vacantVisitPlaceError`, and the database's `phoenix_crm_manager_visits_vacant_place`). It binds the
 * visit only — adding a customer to Manager's own list stays as it was (his choice, the same day).
 *
 * 🔴 VACANT IS READ OFF THE CUSTOMER'S OWN TERRITORY, WHICHEVER LIST HE CAME FROM — a rep customer's seat,
 * and a Manager's-own-list customer's `area_seat_id`. The own list used to be flatly "not vacant", so the
 * area screen demanded an address for a customer the form then never asked one for (owner, 2026-10-20).
 *
 * 🔴 THESE VISITS COUNT IN HIS OWN REPORT AND NOWHERE ELSE. `phoenix_crm_manager_visits` is a table of its
 * own precisely so that no KPI, coverage, call-rate, frequency or target reader can pick a row of it up —
 * `tests/phoenix-crm-manager-plan.test.ts` pins that no such reader names it. And the old "My own visit"
 * on a rep's seat is closed to a district manager (`saveVisit`), so there is one path for these, not two.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { parseCapturedFix } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { personKey } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { holdsPlannedDoctors, MANAGER_CUSTOMER_ADDRESS_MAX, vacantVisitPlaceError, visitPlaceText, type ManagerPlanWriter } from "@/lib/phoenix-crm/manager-plan-rules";
import { managerVisitDetailEditable, parseManagerVisitDetail } from "@/lib/phoenix-crm/manager-visit-detail-rules";
import { assertManagerPlanWriter } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { managerWriterReach } from "@/lib/phoenix-crm/server/manager-plan-writers";
import {
  areaChoiceSeatOf,
  isVacantTerritory,
  loadManagerCustomerRow,
  loadManagerCustomers,
  locateInReach,
  managerAreaChoices,
  resolveChosenPlace,
  type ManagerAreaChoice,
  type ManagerCustomerView,
} from "@/lib/phoenix-crm/server/manager-customers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { assertSingleVisitLogFits, loadSingleVisitAllowance, type SingleVisitAllowance } from "@/lib/phoenix-crm/server/manager-single-visit-cap";
import { loadManagerSlotCustomers, loadManagerSlotRows, MANAGER_PLAN_COLUMNS, managerPlanRowOf } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { loadManagerVisitCompanionIds } from "@/lib/phoenix-crm/server/visit-companions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** At most this many people go with him on one visit — the companions table's `position` runs 0–11. */
export const MANAGER_VISIT_COMPANIONS_MAX = 12;

/** One person he may say went with him: the people above him and his line's product side (`managerSeniorOffers`). */
export type ManagerCompanionOffer = { hrId: string; name: string; title: string; side: "manager" | "product" };

/**
 * 🔴 WHO MAY GO WITH HIM ON HIS OWN VISIT (owner, 2026-10-27: "Everything is applicable" — a district
 * manager goes with the National Sales Manager, the Training Manager or the Product Manager). The same
 * people his With a manager or product manager half-day offers, from the organogram and his line's product
 * side, each under their own title. Lazily: manager-plans.ts reads this module.
 */
async function loadCompanionOffers(viewer: PhoenixCrmViewer, writer: ManagerPlanWriter): Promise<ManagerCompanionOffer[]> {
  const { managerSeniorOffers } = await import("@/lib/phoenix-crm/server/manager-plans");
  const offers = await managerSeniorOffers(viewer, writer);
  const names = await loadPeopleNames(offers.map((offer) => offer.hrId));
  return offers.map((offer) => ({
    hrId: offer.hrId,
    name: nameOf(names, offer.hrId, offer.title),
    title: offer.title,
    side: offer.role === "product_manager" ? "product" : "manager",
  }));
}

/** The people he ticked, read and checked against his offers; an unknown one is refused, never dropped. */
function companionIdsOf(value: unknown, offers: ReadonlyArray<ManagerCompanionOffer>): ManagerCompanionOffer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError("Who went with you could not be read. Reload the page.");
  const byKey = new Map(offers.map((offer) => [offer.hrId, offer]));
  const out: ManagerCompanionOffer[] = [];
  for (const entry of value) {
    const key = personKey(typeof entry === "string" ? entry : null);
    if (!key) throw validationError("Who went with you could not be read. Reload the page.");
    const offer = byKey.get(key);
    if (!offer) throw validationError("Choose who went with you from the list. Reload the page.");
    if (!out.includes(offer)) out.push(offer);
  }
  if (out.length > MANAGER_VISIT_COMPANIONS_MAX) throw validationError(`Choose at most ${MANAGER_VISIT_COMPANIONS_MAX} people.`);
  return out;
}

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
  /** The longer account he wrote up afterwards (owner, 2026-10-23); null until he writes one. */
  detailComment: string | null;
  /** When that write-up was last saved, for the "Edited" line on his card. */
  detailEditedAt: string | null;
  hasPin: boolean;
  capturedAt: string | null;
  isTest: boolean;
  /** The territory was vacant when he logged it (owner, 2026-10-19). */
  inVacantTerritory: boolean;
  /** Where the visit says its customer is — address, area and brick — or null (`visitPlaceText`). */
  placeText: string | null;
  /** Everyone who went with him, in the order he ticked them (owner, 2026-10-27); empty when he went alone. */
  companionHrIds: string[];
};

const VISIT_COLUMNS =
  "id, manager_hr_id, plan_slot_id, is_unplanned, visit_date, half, customer_id, manager_customer_id, products, comment, detail_comment, detail_edited_at, lat, captured_at, is_test, in_vacant_territory, address, area_name, brick_name";

function visitRowOf(raw: unknown): ManagerVisitRow | null {
  const row = record(raw);
  const id = textOrNull(row.id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const visitDate = textOrNull(row.visit_date)?.slice(0, 10) ?? null;
  if (!id || !managerHrId || !visitDate) return null;
  const hasPin = row.lat !== null && row.lat !== undefined;
  const inVacantTerritory = row.in_vacant_territory === true;
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
    detailComment: textOrNull(row.detail_comment),
    detailEditedAt: textOrNull(row.detail_edited_at),
    hasPin,
    capturedAt: textOrNull(row.captured_at),
    isTest: row.is_test === true,
    inVacantTerritory,
    placeText: visitPlaceText({
      address: textOrNull(row.address),
      areaName: textOrNull(row.area_name),
      brickName: textOrNull(row.brick_name),
      captured: hasPin,
    }),
    companionHrIds: [],
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
  const visits = rows.map(visitRowOf).filter((row): row is ManagerVisitRow => row !== null);
  const companions = await loadManagerVisitCompanionIds(visits.map((visit) => visit.id));
  for (const visit of visits) visit.companionHrIds = companions.get(visit.id) ?? [];
  return visits;
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
  /** A doctor of a vacant territory's list: the visit needs a typed address or a captured location (owner, 2026-10-19). */
  vacant: boolean;
  /** The territory whose list he is on — the hint Capture location reads against; null when it is unknown. */
  seatId: string | null;
  /** The area the place block opens on: the customer's own territory, so its brick list is the right one. */
  areaSeatId: string | null;
  /** The address already on file for a customer of his own list, so the form opens on what the system knows. */
  knownAddress: string | null;
  /** Once logged: the address, area and brick the visit recorded (`visitPlaceText`). */
  place: string | null;
  /** Once logged: the visit itself, which the write-up panel saves against. Null until he logs it. */
  visitId: string | null;
  /** The longer account he wrote up afterwards (owner, 2026-10-23), and when he last saved it. */
  detailComment: string | null;
  detailEditedAt: string | null;
  /**
   * The manager he goes with, by name, when this customer is on a With my manager or product manager half-day (owner,
   * 2026-10-27: "it should count with her manager") — the visit he logs here is a visit with that manager. Null otherwise.
   */
  withSenior: string | null;
  /** Once logged: everyone who went with him, by name and title (owner, 2026-10-27). Empty when he went alone. */
  companions: Array<{ name: string; title: string | null }>;
};

/** A customer of Manager's own list as the Visits tab needs him: with whether his area has a rep today. */
export type ManagerTodayOwnCustomer = ManagerCustomerView & { vacant: boolean };

export type ManagerTodayView = {
  isTest: boolean;
  visitDay: string;
  /** Today's planned single-visit customers, each with whether he has logged it. */
  planned: ManagerTodayCustomer[];
  /** What he logged today that was not planned — shown apart. */
  unplanned: ManagerTodayCustomer[];
  /** His own list, for "Log an unplanned customer" — each with whether its area is vacant today. */
  ownList: ManagerTodayOwnCustomer[];
  /** The areas he plans in, by name — a vacant one marked — to log an unplanned visit from an area's list. */
  areas: ManagerAreaChoice[];
  /** His line's products, by family — what "Products discussed" offers. Optional on every visit. */
  products: string[];
  /** A district manager's single-visit limit for the visit day's week, as the log counts it; null for every other manager. */
  singleVisitLimit: SingleVisitAllowance | null;
  /** Who he may say went with him — the people above him and his line's product side, each by title. */
  companionOffers: ManagerCompanionOffer[];
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
export async function writerProductNames(viewer: Pick<PhoenixCrmViewer, "org">, writer: ManagerPlanWriter): Promise<string[]> {
  const lineNames = writer.seat
    ? [writer.seat.lineName]
    : writer.lineCodes.map((code) => viewer.org.territories.find((seat) => seat.lineCode === code && seat.lineName)?.lineName ?? null);
  const lists = await Promise.all(dedupeIds(lineNames.filter((name): name is string => Boolean(name))).map(lineProductNames));
  return [...new Set(lists.flat())];
}

/** Customer names, and the territory each is on today, for the rep customers of his day. */
async function loadRepCustomerNames(customerIds: ReadonlyArray<string>): Promise<Map<string, { name: string; speciality: string | null; seatId: string | null }>> {
  const ids = dedupeIds(customerIds);
  const out = new Map<string, { name: string; speciality: string | null; seatId: string | null }>();
  if (ids.length === 0) return out;
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, name, speciality, seat_id").in("id", ids),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  for (const row of rows) {
    out.set(String(row.id), { name: textOrNull(row.name) ?? "Customer", speciality: textOrNull(row.speciality), seatId: textOrNull(row.seat_id) });
  }
  return out;
}

/** GET: his visits of the visit day — planned (from today's single-visit and with-my-manager half-days) and unplanned. */
export async function loadManagerToday(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<ManagerTodayView> {
  const writer = assertManagerPlanWriter(viewer);
  const isTest = testModeFor(viewer, raw.test);
  const day = viewer.visitDay;
  const weekStart = fieldWeekStart(day);
  const reach = await managerWriterReach(viewer, writer);
  const [planRows, visits, ownList, products, names, singleVisitLimit, companionOffers] = await Promise.all([
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
    loadPeopleNames(reach.map((seat) => seat.occupantHrId)),
    writer.kind === "dm" ? loadSingleVisitAllowance({ managerHrId: viewer.hrId, weekStart, date: day, isTest }) : Promise.resolve(null),
    loadCompanionOffers(viewer, writer),
  ]);
  // Who went with him on each visit of the day, named under the title his offers carry — or, someone no
  // longer offered (moved seat since), under their name alone.
  const titleOf = new Map(companionOffers.map((offer) => [offer.hrId, offer.title]));
  const companionNames = await loadPeopleNames(visits.flatMap((visit) => visit.companionHrIds));
  const companionsOf = (visit: ManagerVisitRow | undefined): ManagerTodayCustomer["companions"] =>
    (visit?.companionHrIds ?? []).map((hrId) => ({ name: nameOf(companionNames, hrId, "A colleague"), title: titleOf.get(personKey(hrId) ?? "") ?? null }));
  const plan = planRows.length > 0 ? managerPlanRowOf(planRows[0]) : null;
  const slots = plan ? (await loadManagerSlotRows([plan.planId])).filter((slot) => slot.date === day && holdsPlannedDoctors(slot.kind)) : [];
  const seniorOfSlot = new Map(
    slots.flatMap((slot) => (slot.kind === "with_senior" && slot.seniorVisit ? [[slot.slotId, slot.seniorVisit.seniorHrId] as const] : [])),
  );
  const [slotCustomers, seniorNames] = await Promise.all([
    loadManagerSlotCustomers(slots.map((slot) => slot.slotId)),
    loadPeopleNames([...seniorOfSlot.values()]),
  ]);
  const halfOfSlot = new Map(slots.map((slot) => [slot.slotId, slot.half]));
  const visitOf = new Map(visits.map((visit) => [visit.customerId ? `c:${visit.customerId}` : `m:${visit.managerCustomerId}`, visit]));
  const unplannedVisits = visits.filter((visit) => visit.isUnplanned);
  // The territory each rep customer is on TODAY decides whether it is vacant — the same reading the save makes.
  const repCustomers = await loadRepCustomerNames([
    ...slotCustomers.flatMap((row) => (row.customerId && !row.gone ? [row.customerId] : [])),
    ...unplannedVisits.flatMap((visit) => (visit.customerId ? [visit.customerId] : [])),
  ]);
  // The territory a customer is on TODAY decides whether it is vacant — a rep customer's seat, and a
  // customer of his own list's `area_seat_id`. One reading, the same one the save makes: the own list
  // used to be flatly "not vacant", so the area screen asked for an address the form never offered.
  const placeOf = (customerId: string | null, managerCustomerId: string | null): Pick<ManagerTodayCustomer, "vacant" | "seatId" | "areaSeatId" | "knownAddress"> => {
    const own = managerCustomerId ? ownById.get(managerCustomerId) : undefined;
    const seatId = customerId ? (repCustomers.get(customerId)?.seatId ?? null) : (own?.areaSeatId ?? null);
    return {
      vacant: seatId !== null && isVacantTerritory(viewer.org.seats.get(seatId)),
      seatId,
      // The AREA's own seat, not the rep's: the form's area drop-list lists one seat per area.
      areaSeatId: areaChoiceSeatOf(reach, seatId),
      knownAddress: own?.address ?? null,
    };
  };
  const ownById = new Map(ownList.map((customer) => [customer.id, customer]));
  const planned = slotCustomers
    .filter((row) => !row.gone)
    .map((row): ManagerTodayCustomer => {
      const visit = visitOf.get(row.customerId ? `c:${row.customerId}` : `m:${row.managerCustomerId}`);
      return {
        slotId: row.slotId,
        half: halfOfSlot.get(row.slotId) ?? null,
        customerId: row.customerId,
        managerCustomerId: row.managerCustomerId,
        name: row.name,
        speciality: row.speciality,
        own: row.managerCustomerId !== null,
        logged: visit !== undefined,
        ...placeOf(row.customerId, row.managerCustomerId),
        place: visit?.placeText ?? null,
        visitId: visit?.id ?? null,
        detailComment: visit?.detailComment ?? null,
        detailEditedAt: visit?.detailEditedAt ?? null,
        withSenior: seniorOfSlot.has(row.slotId) ? nameOf(seniorNames, seniorOfSlot.get(row.slotId), "your manager") : null,
        companions: companionsOf(visit),
      };
    })
    .sort((left, right) => String(left.half).localeCompare(String(right.half)) || left.name.localeCompare(right.name));

  const unplanned = unplannedVisits.map((visit): ManagerTodayCustomer => {
    const rep = visit.customerId ? repCustomers.get(visit.customerId) : undefined;
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
      ...placeOf(visit.customerId, visit.managerCustomerId),
      // What the visit recorded, never what the territory is today: it was vacant when he logged it.
      vacant: visit.inVacantTerritory,
      place: visit.placeText,
      visitId: visit.id,
      detailComment: visit.detailComment,
      detailEditedAt: visit.detailEditedAt,
      withSenior: null,
      companions: companionsOf(visit),
    };
  });
  return {
    isTest,
    visitDay: day,
    planned,
    unplanned,
    ownList: ownList
      .filter((customer) => customer.status === "active")
      .map((customer) => ({ ...customer, vacant: isVacantTerritory(viewer.org.seats.get(customer.areaSeatId ?? "")) })),
    areas: managerAreaChoices(reach, names),
    products,
    singleVisitLimit,
    companionOffers,
  };
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
 * The single-visit half-day of TODAY his own plan already holds this customer on, or null.
 *
 * "My single visits" knows the slot because it listed the customer from the plan; the TERRITORY's Add
 * visit form does not — it knows nothing about his week. A visit handed over from there with no slot
 * would be filed UNPLANNED, spending one of his unplanned half-days and leaving the planned row "not
 * done" in the actual-versus-planned report. So it is asked here, by the same reading `loadManagerToday`
 * makes, before the visit is handed to `logManagerVisit`.
 */
export async function plannedSingleVisitSlotFor(viewer: PhoenixCrmViewer, customerId: string, isTest: boolean): Promise<string | null> {
  const day = viewer.visitDay;
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
  if (plans.length === 0) return null;
  const slots = (await loadManagerSlotRows(plans.map((plan) => String(plan.id)))).filter((slot) => slot.date === day && holdsPlannedDoctors(slot.kind));
  if (slots.length === 0) return null;
  const held = await loadManagerSlotCustomers(slots.map((slot) => slot.slotId));
  return held.find((row) => !row.gone && row.customerId === customerId)?.slotId ?? null;
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
  // Who went with him (owner, 2026-10-27): only the people his form offers, each checked here.
  const companions = body.companionHrIds === undefined || body.companionHrIds === null ? [] : companionIdsOf(body.companionHrIds, await loadCompanionOffers(viewer, writer));

  // Whose customer: a rep's of a district he plans in, or one of his own list — in his world.
  let customerLineCode: string | null = null;
  let customerSeatId: string | null = null;
  let vacant = false;
  const reach = await managerWriterReach(viewer, writer);
  if (customerId) {
    const district = new Set(reach.map((entry) => entry.seatId));
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
    customerSeatId = String(row.seat_id);
    customerLineCode = viewer.org.seats.get(customerSeatId)?.lineCode ?? null;
    // Nobody holds the territory today: the doctor is on the previous rep's list (owner, 2026-10-19).
    vacant = isVacantTerritory(viewer.org.seats.get(customerSeatId));
  } else if (managerCustomerId) {
    const own = await loadManagerCustomerRow(managerCustomerId);
    if (!own || own.managerHrId !== viewer.hrId || own.isTest !== isTest || own.status === "removed") {
      throw notFoundError("This customer is no longer on Manager's own list. Reload the page.");
    }
    // His own list carries the area the customer is in, so it answers the same vacancy question a rep
    // customer's seat does. Flatly "not vacant" left the area screen asking for an address that the form
    // then never offered him (owner, 2026-10-20).
    customerSeatId = own.areaSeatId;
    customerLineCode = customerSeatId ? (viewer.org.seats.get(customerSeatId)?.lineCode ?? null) : null;
    vacant = customerSeatId !== null && isVacantTerritory(viewer.org.seats.get(customerSeatId));
  }

  // Planned: a single-visit or with-my-manager half-day of TODAY that holds this customer.
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
    const slot = slots.find((entry) => entry.slotId === askedSlot && entry.date === day && holdsPlannedDoctors(entry.kind));
    if (!slot) throw conflictError("This half-day is no longer on today's plan. Reload the page.");
    const held = await loadManagerSlotCustomers([slot.slotId]);
    if (!held.some((entry) => (customerId ? entry.customerId === customerId : entry.managerCustomerId === managerCustomerId))) {
      throw conflictError("This customer is no longer on today's plan. Reload the page.");
    }
    slotId = slot.slotId;
    half = slot.half;
  }

  // An unplanned visit opens a half-day of single visits nobody planned, and a district manager has four of
  // them a week at most (owner, 2026-10-17). A planned one answers a half-day the plan already holds.
  if (slotId === null && writer.kind === "dm") {
    await assertSingleVisitLogFits({ managerHrId: viewer.hrId, weekStart: fieldWeekStart(day), date: day, isTest });
  }

  // 🔴 WHERE THE CUSTOMER IS — the Add-a-customer block, on every single visit (owner, 2026-10-20): the
  // address he typed, the area and brick he chose, and the location he captured. All of it optional, EXCEPT
  // in a vacant area, where the address or the capture is required — one or the other, never neither
  // (owner, 2026-10-19). What he sent is what is stored: the capture only fills what he left empty.
  const orTyped = vacant ? "or type the address" : "or log the visit without it";
  let address: string | null = null;
  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") throw validationError("The address could not be read.");
    address = body.address.trim().replace(/\s+/g, " ") || null;
    if (address && address.length > MANAGER_CUSTOMER_ADDRESS_MAX) throw validationError(`Keep the address under ${MANAGER_CUSTOMER_ADDRESS_MAX} characters.`);
  }
  const chosen = await resolveChosenPlace(writer, reach, body.areaSeatId, body.brickId);

  let pin: Row = {};
  let located: Awaited<ReturnType<typeof locateInReach>> | null = null;
  const rawPin = record(body.pin);
  if (rawPin.lat !== undefined || rawPin.lon !== undefined) {
    const fix = parseCapturedFix(rawPin, `The location could not be read. Press Capture location again, ${orTyped}.`);
    if (!fix.ok) throw validationError(fix.error);
    const { lat, lon, accuracyMeters } = fix.value;
    if (lat < EGYPT.latMin || lat > EGYPT.latMax || lon < EGYPT.lonMin || lon > EGYPT.lonMax) {
      throw validationError(`This location is outside Egypt. Capture it again, ${orTyped}.`);
    }
    pin = { lat, lon, accuracy_meters: accuracyMeters };
    // The same reading the form showed him when he pressed Capture location (`locateInReach`), so what he
    // saw filled in is what is stored — and his own correction of it wins over the capture's.
    located = await locateInReach(reach, { lat, lon, accuracyMeters }, chosen.areaSeatId ?? customerSeatId);
    address = address ?? located.address;
  }
  const place: Row = {
    area_code: chosen.areaCode ?? located?.areaCode ?? null,
    area_name: chosen.areaName ?? located?.areaName ?? null,
    brick_id: chosen.brickId ?? located?.brickId ?? null,
    brick_name: chosen.brickName ?? located?.brickName ?? null,
  };
  const placeError = vacantVisitPlaceError({ vacant, address, captured: pin.lat !== undefined });
  if (placeError) throw validationError(placeError);

  const { data: saved, error } = await getSupabaseAdmin()
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
      in_vacant_territory: vacant,
      // Every single visit keeps what it recorded now, not only a vacant area's (owner, 2026-10-20).
      address,
      ...place,
      client_ref: clientRef,
      entered_by_hr_id: viewer.hrId,
      is_test: isTest,
    })
    .select("id")
    .single();
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
  } else if (companions.length > 0) {
    // 🔴 THE VISIT AND WHO WENT ON IT ARE ONE SAVE: a visit stored without its companions would credit him
    // alone, so a failed list takes the visit back and he is told to log it again.
    const visitId = String(record(saved).id);
    const { error: companionError } = await getSupabaseAdmin()
      .from("phoenix_crm_visit_companions")
      .insert(companions.map((companion, position) => ({ manager_visit_id: visitId, hr_id: companion.hrId, side: companion.side, position })));
    if (companionError) {
      await getSupabaseAdmin().from("phoenix_crm_manager_visits").delete().eq("id", visitId);
      throw companionError;
    }
  }
  return loadManagerToday(viewer, { test: isTest });
}

/**
 * He comes back to a visit he logged and writes up its detail (owner, 2026-10-23).
 *
 * 🔴 IT MOVES ONE COLUMN. The comment he typed while logging, the products, the day, the time, the
 * location and a vacant area's recorded address, area and brick are all left exactly as they were —
 * `detail_comment` is a SECOND, longer account beside the first, and `detail_edited_at` is what the card
 * prints as "Edited · <date time>". `managerVisitDetailEditable` is what decides, read from the visit's
 * OWN row rather than from the request, so a visit id belonging to another manager is refused with a
 * sentence rather than silently ignored.
 *
 * It answers with today's view, the same shape `logManagerVisit` answers with, so the screen refreshes
 * from the save instead of asking again.
 */
export async function saveManagerVisitDetail(viewer: PhoenixCrmViewer, raw: unknown): Promise<ManagerTodayView> {
  assertManagerPlanWriter(viewer);
  const body = record(raw);
  const isTest = testModeFor(viewer, body.test);
  const parsed = parseManagerVisitDetail(body);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_visits").select("id, manager_hr_id, is_test").eq("id", entry.visitId),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const visit = rows[0];
  if (!visit || visit.is_test !== isTest) throw notFoundError("This visit is no longer there. Reload the page.");

  const editable = managerVisitDetailEditable({ managerHrId: textOrNull(visit.manager_hr_id), actorHrId: viewer.hrId });
  if (!editable.editable) throw forbiddenError(editable.reason);

  const { error } = await getSupabaseAdmin()
    .from("phoenix_crm_manager_visits")
    // Cleared on purpose reads as never written: the line is a courtesy, and an "Edited" stamp over an
    // empty box would say a write-up exists where there is none.
    .update({ detail_comment: entry.detailComment, detail_edited_at: entry.detailComment ? new Date().toISOString() : null })
    .eq("id", entry.visitId);
  if (error) throw error;

  return loadManagerToday(viewer, { test: isTest });
}
