/**
 * Customer 360 v2 — reading every source a hub is built from. Service role, read-only.
 *
 * 🔴 PAGE EVERY READ. An unbounded PostgREST read stops at 1,000 rows with no error and no marker;
 * Phoenix CRM alone holds thousands of validated customers, the closing map 81,000 shops. Every table
 * read here is keyset-paged, and every id list is chunked well under the ~395-id URL cliff.
 *
 * 🔴 NOTHING HERE WRITES. Customer 360 is a report: the only table it writes is its own
 * `customer_360_pharmacy_matches`, and only through `server/pharmacy-matches.ts`.
 */

import { parseCrmContactCode } from "@/lib/crm/contact-code";
import { readContactVisitMonths } from "@/lib/crm/reads";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { loadActuals, mapRoiRequest } from "@/lib/marketing-requests/roi-report-service";
import { pharmacyNameKey } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { readNamedPharmaciesOnVisits } from "@/lib/phoenix-crm/server/named-pharmacies";
import { RESTRICTED_PRODUCT_CODES } from "@/lib/sales/confidential-products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";

import {
  hubLineCode,
  type Customer360Sources,
  type HubLineCode,
  type SalesPair,
  type SourceDirectOrder,
  type SourceDirectVenue,
  type SourceIdentityLink,
  type SourceMarketingCustomer,
  type SourceMarketingLink,
  type SourceMarketingPharmacy,
  type SourcePhoenixCustomer,
  type SourcePlace,
  type SourceRequest,
} from "../hub";
import { matchItemKey, type MapShopRow, type MatchPair, type StoredDecision } from "../pharmacy-matcher";
import { isCountedDirectOrder, PHOENIX_HUB_LIST_TYPES, PHOENIX_VALIDATED_AT_COLUMN, PHOENIX_VALIDATION_COLUMNS } from "../validated";

/** The first month a hub's visits and sales are read from — the Monthly Closing's own data floor. */
export const CUSTOMER_360_FROM_MONTH = "2026-01";

const IN_CHUNK = 150;

/** Id chunks read at once — the same budget the closing's own customer fan-out holds. */
const PARALLEL_CHUNKS = 4;

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => {
  const out = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return out.length > 0 ? out : null;
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function chunk<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}

async function pageAll<T extends Row>(build: () => unknown, cursorColumn = "id"): Promise<T[]> {
  return fetchAllRowsKeyset<T>(build, { cursorColumn, cursorOf: (row) => (row[cursorColumn] == null ? null : (row[cursorColumn] as string | number)) });
}

async function pageByIds<T extends Row>(
  table: string,
  columns: string,
  idColumn: string,
  ids: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tune?: (query: any) => any,
): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  // A few chunks at once (asyncPool keeps their order and clamps to one in dev): read one after
  // another, the places of 2,250 customers and the closing map of a few hundred bricks took
  // fifteen seconds of a build on 2026-10-18.
  const pages = await asyncPool(PARALLEL_CHUNKS, chunk(unique), (part) =>
    pageAll<T>(() => {
      const base = getSupabaseAdmin().from(table).select(columns).in(idColumn, part);
      return tune ? tune(base) : base;
    }),
  );
  return pages.flat();
}

// ── Phoenix CRM ──────────────────────────────────────────────────────────────────────────────────

async function loadPhoenix(): Promise<SourcePhoenixCustomer[]> {
  const rows = await pageAll<Row>(() =>
    getSupabaseAdmin()
      .from("phoenix_crm_customers")
      .select(`${PHOENIX_VALIDATION_COLUMNS}, name, grade, line_code, seat_id, status_changed_at`)
      .not(PHOENIX_VALIDATED_AT_COLUMN, "is", null)
      .eq("is_test", false)
      .in("list_type", [...PHOENIX_HUB_LIST_TYPES]),
  );
  const places = await pageByIds<Row>(
    "phoenix_crm_places",
    "id, customer_id, status, address, brick_id, brick_name, area_code, area_name, region_name, lat, lon, pin_lat, pin_lon, created_at",
    "customer_id",
    rows.map((row) => String(row.id)),
    (query) => query.eq("is_test", false),
  );
  const placeByCustomer = new Map<string, SourcePlace & { active: boolean; createdAt: string }>();
  for (const place of places) {
    const customerId = String(place.customer_id ?? "");
    const active = text(place.status) === "active";
    const candidate = {
      active,
      address: text(place.address),
      areaCode: text(place.area_code),
      areaName: text(place.area_name),
      brickId: text(place.brick_id),
      brickName: text(place.brick_name),
      createdAt: String(place.created_at ?? ""),
      lat: num(place.pin_lat) ?? num(place.lat),
      lon: num(place.pin_lon) ?? num(place.lon),
      regionName: text(place.region_name),
    };
    const held = placeByCustomer.get(customerId);
    // An active place beats a retired one; among equals the newest wins.
    if (!held || (candidate.active && !held.active) || (candidate.active === held.active && candidate.createdAt > held.createdAt)) {
      placeByCustomer.set(customerId, candidate);
    }
  }
  return rows.map((row) => {
    const place = placeByCustomer.get(String(row.id)) ?? null;
    return {
      grade: text(row.grade),
      id: String(row.id),
      is_test: Boolean(row.is_test),
      line_code: text(row.line_code),
      list_type: text(row.list_type),
      name: text(row.name),
      own_contact_crm_id: num(row.own_contact_crm_id),
      place: place
        ? { address: place.address, areaCode: place.areaCode, areaName: place.areaName, brickId: place.brickId, brickName: place.brickName, lat: place.lat, lon: place.lon, regionName: place.regionName }
        : null,
      reference_contact_crm_id: num(row.reference_contact_crm_id),
      seat_id: text(row.seat_id),
      speciality: text(row.speciality),
      status: text(row.status),
      status_changed_at: text(row.status_changed_at),
      validated_at: text(row.validated_at),
    };
  });
}

// ── Marketing ────────────────────────────────────────────────────────────────────────────────────

async function loadMarketing(): Promise<{
  customers: SourceMarketingCustomer[];
  links: SourceMarketingLink[];
  pharmacies: Map<string, SourceMarketingPharmacy>;
  requests: SourceRequest[];
}> {
  const db = getSupabaseAdmin();
  const [customerRows, contactRows, linkRows, requestRows, typeRows] = await Promise.all([
    pageAll<Row>(() =>
      db
        .from("marketing_customers")
        .select(
          "id, customer_type, display_name, validation_status, active, merged_into_customer_id, region_name, extracted_area_name, captured_address, captured_latitude, captured_longitude",
        ),
    ),
    pageAll<Row>(() => db.from("marketing_customer_contacts").select("id, customer_id, crm_code, active").eq("active", true)),
    pageAll<Row>(() => db.from("marketing_customer_pharmacies").select("id, customer_id, pharmacy_id, distributor_code_id, validation_status, active").eq("active", true)),
    pageAll<Row>(() =>
      db
        .from("marketing_requests")
        .select("id, request_code, requester_hr_id, manager_hr_id, customer_id, status, request_type_id, pay_date, roi_duration_months, estimated_cost, expected_roi_value, required_roi_value"),
    ),
    pageAll<Row>(() => db.from("marketing_request_types").select("id, name")),
  ]);

  const crmCodes = new Map<string, string[]>();
  for (const contact of contactRows) {
    const code = text(contact.crm_code);
    const customerId = text(contact.customer_id);
    if (!code || !customerId) continue;
    const list = crmCodes.get(customerId) ?? [];
    list.push(code);
    crmCodes.set(customerId, list);
  }
  const customers: SourceMarketingCustomer[] = customerRows.map((row) => ({
    active: row.active === null || row.active === undefined ? null : Boolean(row.active),
    captured_address: text(row.captured_address),
    captured_latitude: num(row.captured_latitude),
    captured_longitude: num(row.captured_longitude),
    crmCodes: crmCodes.get(String(row.id)) ?? [],
    customer_type: text(row.customer_type),
    display_name: text(row.display_name),
    extracted_area_name: text(row.extracted_area_name),
    id: String(row.id),
    merged_into_customer_id: text(row.merged_into_customer_id),
    region_name: text(row.region_name),
    validation_status: text(row.validation_status),
  }));

  const links: SourceMarketingLink[] = linkRows
    .filter((row) => text(row.customer_id) && text(row.pharmacy_id))
    .map((row) => ({
      customerId: String(row.customer_id),
      distributorCodeId: text(row.distributor_code_id),
      pharmacyId: String(row.pharmacy_id),
      status: text(row.validation_status),
    }));

  const typeName = new Map(typeRows.map((row) => [String(row.id), text(row.name)]));
  const requestIds = requestRows.map((row) => String(row.id));
  const targetRows = await pageByIds<Row>("marketing_request_pharmacies", "id, request_id, pharmacy_id, distributor_code_id", "request_id", requestIds);
  const targetsByRequest = new Map<string, Array<{ pharmacyId: string; distributorCodeId: string | null }>>();
  for (const row of targetRows) {
    const requestId = text(row.request_id);
    const pharmacyId = text(row.pharmacy_id);
    if (!requestId || !pharmacyId) continue;
    const list = targetsByRequest.get(requestId) ?? [];
    list.push({ distributorCodeId: text(row.distributor_code_id), pharmacyId });
    targetsByRequest.set(requestId, list);
  }

  // The Marketing ROI engine's own actuals, restricted products excluded — the figure the ROI page
  // shows by default to everyone.
  const { byRequest } = await loadActuals(
    getSupabaseAdmin(),
    requestIds,
    RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()),
  );

  const requests: SourceRequest[] = requestRows.map((row) => {
    const mapped = mapRoiRequest(row as unknown as Parameters<typeof mapRoiRequest>[0]);
    const actual = byRequest.get(mapped.id);
    return {
      actualRoi: actual?.value ?? 0,
      code: mapped.requestCode,
      cost: mapped.estimatedCost,
      customerId: mapped.customerId,
      id: mapped.id,
      payDate: mapped.payDate,
      requiredRoi: mapped.requiredRoiValue,
      roiDurationMonths: mapped.roiDurationMonths,
      salesRows: actual?.salesRows ?? 0,
      status: mapped.status,
      targets: targetsByRequest.get(mapped.id) ?? [],
      typeName: typeName.get(String(row.request_type_id ?? "")) ?? null,
    };
  });

  const pharmacyIds = [...new Set([...links.map((link) => link.pharmacyId), ...targetRows.map((row) => String(row.pharmacy_id ?? ""))].filter(Boolean))];
  const [pharmacyRows, codeRows] = await Promise.all([
    pageByIds<Row>(
      "marketing_pharmacies",
      "id, display_name, region_name, extracted_area_name, captured_address, captured_latitude, captured_longitude",
      "id",
      pharmacyIds,
    ),
    pageByIds<Row>(
      "marketing_pharmacy_distributor_codes",
      "id, pharmacy_id, mapped_distributor_code, mapped_customer_code, mapped_brick_id, mapped_area_code, active",
      "pharmacy_id",
      pharmacyIds,
    ),
  ]);
  const pharmacies = new Map<string, SourceMarketingPharmacy>();
  for (const row of pharmacyRows) {
    pharmacies.set(String(row.id), {
      address: text(row.captured_address),
      areaName: text(row.extracted_area_name),
      codes: [],
      id: String(row.id),
      lat: num(row.captured_latitude),
      lon: num(row.captured_longitude),
      name: text(row.display_name) ?? "Unnamed pharmacy",
      regionName: text(row.region_name),
    });
  }
  for (const row of codeRows) {
    if (row.active === false) continue;
    const pharmacy = pharmacies.get(String(row.pharmacy_id ?? ""));
    const distributorCode = text(row.mapped_distributor_code);
    const customerCode = text(row.mapped_customer_code);
    // The master-resolved pair only — an unresolved code is not offered as evidence (customer-identity reads.ts).
    if (!pharmacy || !distributorCode || !customerCode) continue;
    pharmacy.codes.push({
      areaCode: text(row.mapped_area_code),
      codeId: String(row.id),
      pair: { brickId: text(row.mapped_brick_id), customerCode, distributorCode },
    });
  }
  return { customers, links, pharmacies, requests };
}

// ── Direct orders ────────────────────────────────────────────────────────────────────────────────

async function loadDirectOrders(): Promise<{ venues: SourceDirectVenue[]; orders: SourceDirectOrder[] }> {
  const db = getSupabaseAdmin();
  const venueRows = await pageAll<Row>(() =>
    db
      .from("direct_order_pharmacies")
      .select("id, phoenix_pharmacy_code, pharmacy_name, brick_id, area_code, pharmacy_address, doctor_name, crm_contact_id, trust_state, active, merged_into_pharmacy_id"),
  );
  // 🔴 The codes live in the CHILD table — the parent's two distributor columns are empty on every row.
  const codeRows = await pageAll<Row>(() => db.from("direct_order_pharmacy_distributor_codes").select("id, pharmacy_id, distributor_code, customer_code, mapped_brick_id"));
  const pairsByVenue = new Map<string, SalesPair[]>();
  const addPair = (venueId: string, pair: SalesPair) => {
    const list = pairsByVenue.get(venueId) ?? [];
    list.push(pair);
    pairsByVenue.set(venueId, list);
  };
  for (const row of codeRows) {
    const venueId = text(row.pharmacy_id);
    const distributorCode = text(row.distributor_code);
    const customerCode = text(row.customer_code);
    if (venueId && distributorCode && customerCode) addPair(venueId, { brickId: text(row.mapped_brick_id), customerCode, distributorCode });
  }
  // The direct book itself: an approved order reaches the closing under `DirectReq` and the venue's
  // Phoenix code — and a venue merged into another still carries its old code in published batches.
  const survivorOf = new Map<string, string>();
  for (const row of venueRows) {
    if (text(row.merged_into_pharmacy_id)) survivorOf.set(String(row.id), String(row.merged_into_pharmacy_id));
  }
  for (const row of venueRows) {
    const code = text(row.phoenix_pharmacy_code);
    if (!code) continue;
    let owner = String(row.id);
    for (let hops = 0; survivorOf.has(owner) && hops < 5; hops += 1) owner = survivorOf.get(owner) as string;
    addPair(owner, { brickId: null, customerCode: code, distributorCode: "DIRECTREQ" });
    if (owner !== String(row.id)) for (const pair of pairsByVenue.get(String(row.id)) ?? []) addPair(owner, pair);
  }

  const venues: SourceDirectVenue[] = venueRows.map((row) => ({
    active: row.active === null || row.active === undefined ? null : Boolean(row.active),
    address: text(row.pharmacy_address),
    areaCode: text(row.area_code),
    brickId: text(row.brick_id),
    code: text(row.phoenix_pharmacy_code),
    crmContactId: num(row.crm_contact_id),
    doctorName: text(row.doctor_name),
    id: String(row.id),
    merged_into_pharmacy_id: text(row.merged_into_pharmacy_id),
    name: text(row.pharmacy_name) ?? "Unnamed pharmacy",
    pairs: pairsByVenue.get(String(row.id)) ?? [],
    trust_state: text(row.trust_state),
  }));

  const tied = venues.filter((venue) => venue.crmContactId != null).map((venue) => venue.id);
  const orderRows = await pageByIds<Row>(
    "direct_order_requests",
    "id, pharmacy_id, status, sales_value, sales_month, line, reversal_of_request_id, reversed_by_request_id",
    "pharmacy_id",
    tied,
  );
  const orders: SourceDirectOrder[] = orderRows
    .filter((row) =>
      isCountedDirectOrder({
        reversal_of_request_id: text(row.reversal_of_request_id),
        reversed_by_request_id: text(row.reversed_by_request_id),
        status: text(row.status),
      }),
    )
    .map((row) => ({ line: text(row.line), month: text(row.sales_month), pharmacyId: String(row.pharmacy_id), value: num(row.sales_value) ?? 0 }));
  return { orders, venues };
}

// ── Identity, matches, the closing map ───────────────────────────────────────────────────────────

async function loadIdentityLinks(): Promise<SourceIdentityLink[]> {
  const rows = await pageAll<Row>(() => getSupabaseAdmin().from("customer_identity_links").select("id, master_id, source, source_id"));
  return rows.map((row) => ({ masterId: String(row.master_id), source: String(row.source), sourceId: String(row.source_id) }));
}

export async function loadMatchDecisions(): Promise<Map<string, StoredDecision>> {
  const rows = await pageAll<Row>(() =>
    getSupabaseAdmin().from("customer_360_pharmacy_matches").select("id, name_key, brick_id, status, pairs, decided_by_hr_id, decided_at").is("withdrawn_at", null),
  );
  const out = new Map<string, StoredDecision>();
  for (const row of rows) {
    const status = text(row.status);
    if (status !== "auto" && status !== "confirmed" && status !== "rejected") continue;
    const pairs = Array.isArray(row.pairs) ? (row.pairs as Row[]) : [];
    out.set(matchItemKey(String(row.name_key), String(row.brick_id)), {
      decidedAt: text(row.decided_at),
      decidedByHrId: text(row.decided_by_hr_id),
      pairs: pairs
        .map(
          (pair): MatchPair => ({
            brickId: text(pair.brick_id),
            customerCode: text(pair.customer_code) ?? "",
            customerName: text(pair.customer_name) ?? "",
            distributorCode: (text(pair.distributor_code) ?? "").toUpperCase(),
          }),
        )
        .filter((pair) => pair.customerCode && pair.distributorCode),
      status,
    });
  }
  return out;
}

function toShop(row: Row): MapShopRow {
  return {
    address: text(row.address),
    areaCode: text(row.area_code),
    brickId: text(row.brick_id),
    customerCode: text(row.customer_code) ?? "",
    customerName: text(row.customer_name) ?? "",
    distributorCode: text(row.distributor_code) ?? "",
  };
}

async function loadShopsByBrick(brickIds: readonly string[]): Promise<Map<string, MapShopRow[]>> {
  const rows = await pageByIds<Row>(
    "source_of_sales_customer_map",
    "id, distributor_code, customer_code, customer_name, address, brick_id, area_code",
    "brick_id",
    brickIds,
    (query) => query.eq("active", true),
  );
  const out = new Map<string, MapShopRow[]>();
  for (const row of rows) {
    const shop = toShop(row);
    if (!shop.brickId) continue;
    const list = out.get(shop.brickId) ?? [];
    list.push(shop);
    out.set(shop.brickId, list);
  }
  return out;
}

async function loadGeography(): Promise<{ brickNames: Map<string, string>; brickAreas: Map<string, string>; areaNames: Map<string, string>; bricksByArea: Map<string, string[]> }> {
  const db = getSupabaseAdmin();
  const [bricks, areas] = await Promise.all([
    pageAll<Row>(() => db.from("source_of_sales_bricks").select("brick_id, brick_name, area_code"), "brick_id"),
    pageAll<Row>(() => db.from("source_of_sales_areas").select("area_code, area_name"), "area_code"),
  ]);
  const brickNames = new Map<string, string>();
  const brickAreas = new Map<string, string>();
  const bricksByArea = new Map<string, string[]>();
  for (const brick of bricks) {
    const id = text(brick.brick_id);
    if (!id) continue;
    const name = text(brick.brick_name);
    const area = text(brick.area_code);
    if (name) brickNames.set(id, name);
    if (area) {
      brickAreas.set(id, area);
      const list = bricksByArea.get(area) ?? [];
      list.push(id);
      bricksByArea.set(area, list);
    }
  }
  const areaNames = new Map<string, string>();
  for (const area of areas) {
    const code = text(area.area_code);
    const name = text(area.area_name);
    if (code && name) areaNames.set(code, name);
  }
  return { areaNames, brickAreas, brickNames, bricksByArea };
}

/** Names and lines of the reps behind the visits, by canonical HR id. */
async function loadReps(hrIds: Iterable<string | null | undefined>): Promise<{ names: Map<string, string>; lines: Map<string, HubLineCode> }> {
  const keys = [...new Set([...hrIds].flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const names = new Map<string, string>();
  const lines = new Map<string, HubLineCode>();
  if (keys.length === 0) return { lines, names };
  const db = getSupabaseAdmin();
  const lineRows = await pageAll<Row>(() => db.from("lines").select("id, name"));
  const lineName = new Map(lineRows.map((row) => [String(row.id), text(row.name)]));
  for (const part of chunk(keys, 50)) {
    const { data, error } = await db.from("employees").select("hr_id, full_name, nickname, line_id").in("hr_id", part);
    if (error) throw new Error(`customer-360: reading employees failed — ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const key = canonicalHrIdKey(text(row.hr_id));
      if (!key) continue;
      const fullName = text(row.full_name);
      if (fullName) names.set(key, resolveEmployeeDisplayName(fullName, text(row.nickname), text(row.hr_id)));
      const line = hubLineCode(lineName.get(String(row.line_id ?? "")) ?? null);
      if (line) lines.set(key, line);
    }
  }
  return { lines, names };
}

/** Every source, read once. The assembly decides; this only reads. */
export async function loadCustomer360Sources(): Promise<Customer360Sources> {
  const [phoenix, marketing, direct, identityLinks, decisions, geography] = await Promise.all([
    loadPhoenix(),
    loadMarketing(),
    loadDirectOrders(),
    loadIdentityLinks(),
    loadMatchDecisions(),
    loadGeography(),
  ]);

  const phoenixIds = new Set(phoenix.map((row) => row.id));
  // The contacts visits are read for: every validated Phoenix CRM customer's, and the CRM codes on
  // marketing customers' contacts (a validated marketing customer's history, `hub.ts` step 2).
  const contactIds = [
    ...new Set(
      [
        ...phoenix.map((row) => row.reference_contact_crm_id ?? row.own_contact_crm_id),
        ...marketing.customers.flatMap((customer) => customer.crmCodes.map(parseCrmContactCode)),
      ].filter((id): id is number => id != null && Number.isFinite(id)),
    ),
  ];
  const [named, visitMonths] = await Promise.all([
    readNamedPharmaciesOnVisits(phoenixIds),
    readContactVisitMonths(contactIds, `${CUSTOMER_360_FROM_MONTH}-01`),
  ]);

  // The closing map for the bricks names were typed in; their areas' other bricks only for the
  // items whose name the brick itself does not hold.
  const namedBricks = [...new Set(named.map((one) => one.brickId).filter((id): id is string => Boolean(id)))];
  const brickShops = await loadShopsByBrick(namedBricks);
  const needArea = new Set<string>();
  for (const one of named) {
    if (!one.brickId) continue;
    const decided = decisions.get(matchItemKey(one.nameKey, one.brickId));
    if (decided && decided.status !== "auto") continue;
    const shops = brickShops.get(one.brickId) ?? [];
    if (shops.some((shop) => pharmacyNameKey(shop.customerName) === one.nameKey)) continue;
    const area = geography.brickAreas.get(one.brickId) ?? one.areaCode;
    if (area) needArea.add(area);
  }
  const areaBricks = [...needArea].flatMap((area) => geography.bricksByArea.get(area) ?? []).filter((brick) => !brickShops.has(brick));
  const extraShops = await loadShopsByBrick(areaBricks);
  const areaShops = new Map<string, MapShopRow[]>();
  for (const area of needArea) {
    const list: MapShopRow[] = [];
    for (const brick of geography.bricksByArea.get(area) ?? []) list.push(...(brickShops.get(brick) ?? extraShops.get(brick) ?? []));
    areaShops.set(area, list);
  }

  const repHrIds: string[] = [];
  for (const months of visitMonths.values()) for (const entry of months) if (entry.agentHrId) repHrIds.push(entry.agentHrId);
  for (const one of named) if (one.repHrId) repHrIds.push(one.repHrId);
  const reps = await loadReps(repHrIds);

  return {
    areaNames: geography.areaNames,
    areaShops,
    brickAreas: geography.brickAreas,
    brickNames: geography.brickNames,
    brickShops,
    canonicalHrId: (hrId) => canonicalHrIdKey(hrId) ?? null,
    decisions,
    directOrders: direct.orders,
    directVenues: direct.venues,
    identityLinks,
    marketingCustomers: marketing.customers,
    marketingLinks: marketing.links,
    marketingPharmacies: marketing.pharmacies,
    named,
    phoenix,
    repLines: reps.lines,
    repNames: reps.names,
    requests: marketing.requests,
    visitMonths,
  };
}
