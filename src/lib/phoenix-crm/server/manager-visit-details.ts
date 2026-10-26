import { countsAsManagersDoubleVisit } from "@/lib/phoenix-crm/double-visit-plan-rules";
import {
  managerVisitKind,
  MANAGER_VISIT_KIND_LABELS,
  sortManagerDayVisits,
  type ManagerDayVisit,
  type ManagerVisitPlaceSource,
} from "@/lib/phoenix-crm/manager-visit-detail";
import { planCustomerKey } from "@/lib/phoenix-crm/manager-day-plan";
import { isManagerVisitEnteredForHim } from "@/lib/phoenix-crm/missed-records";
import { countsAsPlannersVisitWithRep, singleVisitHalfOfHour } from "@/lib/phoenix-crm/manager-plan-rules";
import { parseListType, PHARMACY_LIST_TYPE } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { cairoHourOf } from "@/lib/phoenix-crm/server/manager-single-visit-cap";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM — the visits a manager made, in full (owner, 2026-10-20: "name, address, brick, type, AM/PM,
 * when, single, double — every single detail").
 *
 * `manager-plan-readers.ts` answers "did he work, and how many?" with a count. This answers "what exactly did
 * he do?" and is re-exported from that same adapter, so a screen outside the module still reads his visits
 * through the one door. Two sources, kept apart on every row (`ManagerDayVisit.source`):
 *
 * 🔴 HIS OWN SINGLE VISITS come from `phoenix_crm_manager_visits`, a table no KPI, coverage, call-rate or
 *    target reader may name (`tests/phoenix-crm-manager-plan.test.ts`). This file is one of the few that may —
 *    it is named `manager-*.ts` for exactly that reason — and it feeds no figure of any rep or territory.
 *
 * 🔴 A RIDE-ALONG is a double or chain visit a rep logged that names him, judged by
 *    `countsAsManagersDoubleVisit` — the rule the manager report and the team calendar already share — and
 *    read from `phoenix_crm_countable_visits` like every calendar row, so an unapproved off-plan visit waits
 *    exactly as it waits on the rep's own row.
 *
 * 🔴 A REP'S OWN VISIT (owner, 2026-10-21: "make everyone's visits appear in details … exactly as Mina Farouk") is
 *    the same countable row read from his side — every visit he logged, single or with a manager — and comes out
 *    as the same record (`source: "rep"`), so his day and a manager's are drawn by one table and one card.
 *
 * 🔴 NOTHING HERE DECIDES WHO MAY READ. The callers do: the team calendar's manager day resolves the viewer
 *    through `managersInScope`, and the private calendar passes only the employees its own access already
 *    reaches. `territorySeatIds` narrows the rides to the territories the caller already reads.
 *
 * Read-only. A failed read throws — each caller decides whether that is a degraded screen or a refusal.
 */

type Row = Record<string, unknown>;

const OWN_COLUMNS =
  "id, manager_hr_id, is_unplanned, visit_date, half, customer_id, manager_customer_id, products, comment, lat, captured_at, created_at, in_vacant_territory, address, area_name, brick_name, entered_by_hr_id";

const RIDE_COLUMNS =
  "id, seat_id, visit_date, captured_at, created_at, customer_id, place_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, product_manager_hr_id, products, comment, pharmacy_name, is_unplanned, lat, customer_validated";

type CustomerFacts = { name: string; speciality: string | null; grade: string | null; listType: string | null; seatId: string | null };
type PlaceFacts = { label: string | null; address: string | null; brickName: string | null; areaName: string | null };
type OwnCustomerFacts = { name: string; speciality: string | null; grade: string | null; areaName: string | null; address: string | null; brickName: string | null };

function cleanDay(value: unknown): string | null {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function productsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function loggedHalfOf(iso: string | null): "AM" | "PM" | null {
  return iso ? singleVisitHalfOfHour(cairoHourOf(iso)) : null;
}

/**
 * The chunks of one lookup, read side by side rather than one after another: a team's month on the private calendar
 * names thousands of customers, and each chunk is an independent read of one table by id.
 */
async function readChunks(ids: string[], read: (part: string[]) => Promise<Row[]>): Promise<Row[]> {
  return (await Promise.all(chunk(dedupeIds(ids), 100).map((part) => read(part)))).flat();
}

async function loadCustomers(ids: string[]): Promise<Map<string, CustomerFacts>> {
  const out = new Map<string, CustomerFacts>();
  const rows = await readChunks(ids, (part) =>
    fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_customers").select("id, seat_id, list_type, name, speciality, grade").in("id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const row of rows) {
    out.set(String(row.id), {
      grade: textOrNull(row.grade),
      listType: textOrNull(row.list_type),
      name: textOrNull(row.name) ?? "Customer",
      seatId: textOrNull(row.seat_id),
      speciality: textOrNull(row.speciality),
    });
  }
  return out;
}

/** The place a visit names, or — for a visit that names none — the customer's first active place. */
async function loadPlaces(placeIds: string[], customerIds: string[]): Promise<{ byId: Map<string, PlaceFacts>; byCustomer: Map<string, PlaceFacts> }> {
  const byId = new Map<string, PlaceFacts>();
  const byCustomer = new Map<string, PlaceFacts>();
  const factsOf = (row: Row): PlaceFacts => ({
    address: textOrNull(row.address),
    areaName: textOrNull(row.area_name),
    brickName: textOrNull(row.brick_name),
    label: textOrNull(row.label),
  });
  const [named, active] = await Promise.all([
    readChunks(placeIds, (part) =>
      fetchAllRowsKeyset<Row>(
        () => getSupabaseAdmin().from("phoenix_crm_places").select("id, label, address, brick_name, area_name").in("id", part),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
    readChunks(customerIds, (part) =>
      fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_places")
            .select("id, customer_id, label, address, brick_name, area_name")
            .in("customer_id", part)
            .eq("status", "active"),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  ]);
  for (const row of named) byId.set(String(row.id), factsOf(row));
  // The customer's FIRST active place, as before: the keyset walk returns each chunk in id order, and the chunks are
  // concatenated in the order they were asked.
  for (const row of active) {
    const customerId = String(row.customer_id);
    if (!byCustomer.has(customerId)) byCustomer.set(customerId, factsOf(row));
  }
  return { byCustomer, byId };
}

async function loadOwnListCustomers(ids: string[]): Promise<Map<string, OwnCustomerFacts>> {
  const out = new Map<string, OwnCustomerFacts>();
  for (const part of chunk(dedupeIds(ids), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_customers")
          .select("id, name, speciality, grade, area_name, pin_address, pin_brick_name")
          .in("id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      out.set(String(row.id), {
        address: textOrNull(row.pin_address),
        areaName: textOrNull(row.area_name),
        brickName: textOrNull(row.pin_brick_name),
        grade: textOrNull(row.grade),
        name: textOrNull(row.name) ?? "Customer",
        speciality: textOrNull(row.speciality),
      });
    }
  }
  return out;
}

export type ManagerVisitDetailInput = {
  managerHrIds: ReadonlyArray<string>;
  start: string;
  end: string;
  isTest?: boolean;
  /** Names a territory seat for the "which doctor's territory" line; omit to print none. */
  territoryNameOf?: (seatId: string) => string | null;
};

/** The single visits these managers logged alone, one row each, with the customer and the place filled in. */
export async function loadManagerOwnVisitDetails(input: ManagerVisitDetailInput): Promise<ManagerDayVisit[]> {
  if (input.end < input.start) return [];
  const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
  if (keys.length === 0) return [];
  const isTest = input.isTest ?? false;

  const rows: Row[] = [];
  for (const part of chunk(keys, 100)) {
    rows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_manager_visits")
            .select(OWN_COLUMNS)
            .in("manager_hr_id", part)
            .eq("is_test", isTest)
            .gte("visit_date", input.start)
            .lte("visit_date", input.end),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  if (rows.length === 0) return [];

  const customerIds = rows.map((row) => textOrNull(row.customer_id)).filter((id): id is string => Boolean(id));
  const [customers, places, ownList] = await Promise.all([
    loadCustomers(customerIds),
    loadPlaces([], customerIds),
    loadOwnListCustomers(rows.map((row) => textOrNull(row.manager_customer_id)).filter((id): id is string => Boolean(id))),
  ]);

  const out: ManagerDayVisit[] = [];
  for (const row of rows) {
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    const date = cleanDay(row.visit_date);
    if (!managerHrId || !date) continue;
    const loggedAt = textOrNull(row.created_at) ?? textOrNull(row.captured_at);
    const loggedHalf = loggedHalfOf(loggedAt);
    const bucket: "AM" | "PM" = row.half === "AM" || row.half === "PM" ? row.half : (loggedHalf ?? "AM");

    const customer = customers.get(textOrNull(row.customer_id) ?? "");
    const own = ownList.get(textOrNull(row.manager_customer_id) ?? "");
    const place = places.byCustomer.get(textOrNull(row.customer_id) ?? "");
    const visitAddress = textOrNull(row.address);
    const visitArea = textOrNull(row.area_name);
    const visitBrick = textOrNull(row.brick_name);
    const typedOnVisit = Boolean(visitAddress || visitArea || visitBrick);
    const address = visitAddress ?? place?.address ?? own?.address ?? null;
    const areaName = visitArea ?? place?.areaName ?? own?.areaName ?? null;
    const brickName = visitBrick ?? place?.brickName ?? own?.brickName ?? null;
    const placeSource: ManagerVisitPlaceSource = typedOnVisit ? "on_the_visit" : address || areaName || brickName ? "saved_place" : "none";

    const customerListType = customer?.listType ? parseListType(customer.listType) : null;
    out.push({
      address,
      areaName,
      awaitingValidation: false,
      brickName,
      bucket,
      comment: textOrNull(row.comment),
      customerKey: planCustomerKey(row.customer_id, row.manager_customer_id),
      customerName: customer?.name ?? own?.name ?? "Customer",
      date,
      enteredByAdmin: isManagerVisitEnteredForHim({ enteredBy: row.entered_by_hr_id, manager: row.manager_hr_id }),
      grade: customer?.grade ?? own?.grade ?? null,
      hasPin: row.lat !== null && row.lat !== undefined,
      id: `own:${String(row.id)}`,
      inVacantTerritory: row.in_vacant_territory === true,
      kind: "single",
      kindLabel: MANAGER_VISIT_KIND_LABELS.single,
      listType: customerListType,
      loggedAt,
      loggedHalf,
      managerHrId,
      pharmacyName: customerListType === PHARMACY_LIST_TYPE ? (customer?.name ?? null) : null,
      placeLabel: place?.label && place.label !== customer?.name ? place.label : null,
      placeSource,
      planned: row.is_unplanned !== true,
      products: productsOf(row.products),
      source: "own",
      speciality: customer?.speciality ?? own?.speciality ?? null,
      territoryName: customer?.seatId && input.territoryNameOf ? input.territoryNameOf(customer.seatId) : null,
      withPeople: [],
    });
  }
  return sortManagerDayVisits(out);
}

/**
 * The double and chain visits that name these managers (`countsAsManagersDoubleVisit`), one row per
 * (visit, manager) so a chain visit that names two managers is on both their days.
 */
export async function loadManagerRideAlongDetails(
  input: ManagerVisitDetailInput & {
    territorySeatIds?: ReadonlySet<string> | null;
    /** Also the visits naming these people as the PRODUCT MANAGER, judged by his own rule. Off by default. */
    productManagerSlot?: boolean;
  },
): Promise<ManagerDayVisit[]> {
  if (input.end < input.start) return [];
  const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
  if (keys.length === 0) return [];
  const isTest = input.isTest ?? false;
  const wanted = new Set(keys);

  const byId = new Map<string, Row>();
  for (const part of chunk(keys, 100)) {
    const columns = input.productManagerSlot ? (["manager_hr_id", "senior_hr_id", "product_manager_hr_id"] as const) : (["manager_hr_id", "senior_hr_id"] as const);
    for (const column of columns) {
      const rows = await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_countable_visits")
            .select(RIDE_COLUMNS)
            .eq("is_test", isTest)
            .gte("visit_date", input.start)
            .lte("visit_date", input.end)
            .in(column, part),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      );
      for (const row of rows) {
        if (input.territorySeatIds && !input.territorySeatIds.has(String(row.seat_id ?? ""))) continue;
        byId.set(String(row.id), row);
      }
    }
  }
  if (byId.size === 0) return [];

  const rows = [...byId.values()];
  const facts = await loadCountableVisitFacts(rows);

  const out: ManagerDayVisit[] = [];
  for (const row of rows) {
    const visit = { kind: row.kind, managerHrId: row.manager_hr_id, productManagerHrId: row.product_manager_hr_id, seniorHrId: row.senior_hr_id };
    const named = [row.manager_hr_id, row.senior_hr_id, ...(input.productManagerSlot ? [row.product_manager_hr_id] : [])];
    for (const hrId of new Set(named.map((value) => personKey(String(value ?? ""))))) {
      if (!hrId || !wanted.has(hrId)) continue;
      // A seat manager rode it by the rule the manager report judges by; a product manager, named in his own slot,
      // by the rule his own plan report judges by. `countsAsPlannersVisitWithRep` answers the first two slots
      // exactly as `countsAsManagersDoubleVisit` does, so asking it when the third slot is read changes nothing for them.
      const rode = input.productManagerSlot ? countsAsPlannersVisitWithRep(visit, hrId) : countsAsManagersDoubleVisit(visit, hrId);
      if (!rode) continue;
      const record = countableVisitRecord(row, hrId, "ride_along", facts, input.territoryNameOf);
      if (record) out.push(record);
    }
  }
  return sortManagerDayVisits(out);
}

type CountableVisitFacts = {
  customers: Map<string, CustomerFacts>;
  places: { byId: Map<string, PlaceFacts>; byCustomer: Map<string, PlaceFacts> };
  names: PeopleNames;
};

/** The customers, places and names a set of countable rows needs, read once for all of them. */
async function loadCountableVisitFacts(rows: readonly Row[]): Promise<CountableVisitFacts> {
  const customerIds = rows.map((row) => textOrNull(row.customer_id)).filter((id): id is string => Boolean(id));
  const placeIds = rows.map((row) => textOrNull(row.place_id)).filter((id): id is string => Boolean(id));
  const [customers, places, names] = await Promise.all([
    loadCustomers(customerIds),
    loadPlaces(placeIds, customerIds),
    loadPeopleNames(
      rows.flatMap((row) => [textOrNull(row.rep_hr_id), textOrNull(row.manager_hr_id), textOrNull(row.senior_hr_id), textOrNull(row.product_manager_hr_id)]),
    ),
  ]);
  return { customers, names, places };
}

/**
 * One countable visit as the record a screen prints, for the person whose day it is: a manager who rode it
 * (`ride_along`) or the rep who logged it (`rep`). One mapping for both, so a visit reads the same on the rep's day
 * as on his manager's.
 */
function countableVisitRecord(
  row: Row,
  personHrId: string,
  source: "ride_along" | "rep",
  facts: CountableVisitFacts,
  territoryNameOf: ((seatId: string) => string | null) | undefined,
): ManagerDayVisit | null {
  const date = cleanDay(row.visit_date);
  if (!date) return null;
  const loggedAt = textOrNull(row.captured_at) ?? textOrNull(row.created_at);
  const customerId = textOrNull(row.customer_id) ?? "";
  const customer = facts.customers.get(customerId);
  const place = facts.places.byId.get(textOrNull(row.place_id) ?? "") ?? facts.places.byCustomer.get(customerId);
  const listType = parseListType(row.list_type);
  const kind = managerVisitKind(row.kind);
  return {
    address: place?.address ?? null,
    areaName: place?.areaName ?? null,
    awaitingValidation: row.customer_validated !== true,
    brickName: place?.brickName ?? null,
    bucket: listType,
    comment: textOrNull(row.comment),
    customerKey: planCustomerKey(row.customer_id, null),
    customerName: customer?.name ?? "Customer",
    date,
    grade: customer?.grade ?? null,
    hasPin: row.lat !== null && row.lat !== undefined,
    id: source === "rep" ? `rep:${String(row.id)}` : `ride:${String(row.id)}:${personHrId}`,
    inVacantTerritory: false,
    kind,
    kindLabel: MANAGER_VISIT_KIND_LABELS[kind],
    listType,
    loggedAt,
    loggedHalf: loggedHalfOf(loggedAt),
    managerHrId: personHrId,
    pharmacyName: textOrNull(row.pharmacy_name),
    placeLabel: place?.label && place.label !== customer?.name ? place.label : null,
    placeSource: place?.address || place?.areaName || place?.brickName ? "saved_place" : "none",
    planned: row.is_unplanned !== true,
    products: productsOf(row.products),
    source,
    speciality: customer?.speciality ?? null,
    territoryName: territoryNameOf ? territoryNameOf(String(row.seat_id ?? "")) : null,
    withPeople: participantsOf(row, personHrId, facts.names),
  };
}

export type RepVisitDetailInput = {
  /** The reps whose days these are: every visit each of them logged. */
  repHrIds?: ReadonlyArray<string>;
  /** Or the territories whose days these are: every visit logged on each, whoever held it. */
  seatIds?: ReadonlyArray<string>;
  start: string;
  end: string;
  isTest?: boolean;
  /**
   * Also list the visits that were not on the plan and are still waiting for their approvals, marked `awaitingApproval`.
   * They are read from the visits table — the countable view holds them out until approved — so they join no figure.
   */
  includeWaiting?: boolean;
  territoryNameOf?: (seatId: string) => string | null;
};

/**
 * Every visit these reps logged themselves (single, double, chain or with a product manager), one record each, from
 * the countable view every calendar reads, so a visit to a customer nobody has validated is listed and marked "not
 * scored yet" exactly as the calendar cell holds it out. Keyed to the rep who logged it: on a `rep` record
 * `managerHrId` holds HIM.
 */
export async function loadRepVisitDetails(input: RepVisitDetailInput): Promise<ManagerDayVisit[]> {
  if (input.end < input.start) return [];
  const isTest = input.isTest ?? false;
  const reps = dedupeIds((input.repHrIds ?? []).map((hrId) => personKey(hrId)));
  const seats = dedupeIds([...(input.seatIds ?? [])]);
  if (reps.length === 0 && seats.length === 0) return [];

  const byId = new Map<string, Row>();
  const reads: Array<{ column: "rep_hr_id" | "seat_id"; keys: string[] }> = [
    { column: "rep_hr_id", keys: reps },
    { column: "seat_id", keys: seats },
  ];
  for (const { column, keys } of reads) {
    for (const part of chunk(keys, 100)) {
      const rows = await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_countable_visits")
            .select(RIDE_COLUMNS)
            .eq("is_test", isTest)
            .gte("visit_date", input.start)
            .lte("visit_date", input.end)
            .in(column, part),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      );
      for (const row of rows) byId.set(String(row.id), row);
    }
  }
  const waiting = input.includeWaiting ? await loadWaitingOffPlanRows({ end: input.end, isTest, repKeys: reps, seatKeys: seats, start: input.start }) : [];
  if (byId.size === 0 && waiting.length === 0) return [];

  const rows = [...byId.values()];
  const facts = await loadCountableVisitFacts([...rows, ...waiting]);
  const out: ManagerDayVisit[] = [];
  for (const row of rows) {
    const rep = personKey(textOrNull(row.rep_hr_id));
    if (!rep) continue;
    const record = countableVisitRecord(row, rep, "rep", facts, input.territoryNameOf);
    if (record) out.push(record);
  }
  for (const row of waiting) {
    if (byId.has(String(row.id))) continue;
    const rep = personKey(textOrNull(row.rep_hr_id));
    if (!rep) continue;
    const record = countableVisitRecord(row, rep, "rep", facts, input.territoryNameOf);
    // Held out of every figure until approved; what it waits on is the approval, never the customer's validation.
    if (record) out.push({ ...record, awaitingApproval: true, awaitingValidation: false });
  }
  return sortManagerDayVisits(out);
}

/** The visits table has no `customer_validated` (the countable view's own column); a waiting visit does not wait on it. */
const WAITING_COLUMNS =
  "id, seat_id, visit_date, captured_at, created_at, customer_id, place_id, list_type, kind, rep_hr_id, manager_hr_id, senior_hr_id, product_manager_hr_id, products, comment, pharmacy_name, is_unplanned, lat";

const WAITING_STATUSES = ["admin_pending", "manager_pending", "sfe_pending"];

/**
 * The off-plan visits of these reps or territories that are still waiting for their approvals — exactly what the
 * countable view holds out. Found through the approval table's own status, then read by id, so an approved or a
 * refused one is never listed here.
 */
async function loadWaitingOffPlanRows(input: { start: string; end: string; isTest: boolean; repKeys: string[]; seatKeys: string[] }): Promise<Row[]> {
  const ids = new Set<string>();
  const reads: Array<{ column: "rep_hr_id" | "seat_id"; keys: string[] }> = [
    { column: "rep_hr_id", keys: input.repKeys },
    { column: "seat_id", keys: input.seatKeys },
  ];
  for (const { column, keys } of reads) {
    for (const part of chunk(keys, 100)) {
      const found = await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_unplanned_visits")
            .select("visit_id")
            .eq("is_test", input.isTest)
            .in("status", WAITING_STATUSES)
            .gte("visit_date", input.start)
            .lte("visit_date", input.end)
            .in(column, part),
        { cursorColumn: "visit_id", cursorOf: (row) => String(row.visit_id) },
      );
      for (const row of found) ids.add(String(row.visit_id));
    }
  }
  const out: Row[] = [];
  for (const part of chunk([...ids], 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_visits").select(WAITING_COLUMNS).in("id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    out.push(...rows);
  }
  return out;
}

/** Who was on a ride-along beside the manager whose day it is: the rep first, then the others, each with their part. */
function participantsOf(row: Row, managerHrId: string, names: PeopleNames): Array<{ hrId: string; name: string; role: string }> {
  const out: Array<{ hrId: string; name: string; role: string }> = [];
  const seen = new Set<string>([managerHrId]);
  for (const [column, role] of [
    ["rep_hr_id", "Medical rep"],
    ["manager_hr_id", "Manager"],
    ["senior_hr_id", "Senior manager"],
    // The Training Manager rides in this column too (owner, 2026-10-24).
    ["product_manager_hr_id", "Product or training manager"],
  ] as const) {
    const hrId = personKey(textOrNull(row[column]));
    if (!hrId || seen.has(hrId)) continue;
    seen.add(hrId);
    out.push({ hrId, name: nameOf(names, hrId), role });
  }
  return out;
}

/** Both kinds together — one manager's days in full, earliest visit first. */
export async function loadManagerVisitDetails(
  input: ManagerVisitDetailInput & { territorySeatIds?: ReadonlySet<string> | null; productManagerSlot?: boolean },
): Promise<ManagerDayVisit[]> {
  const [own, rides] = await Promise.all([loadManagerOwnVisitDetails(input), loadManagerRideAlongDetails(input)]);
  return sortManagerDayVisits([...own, ...rides]);
}
