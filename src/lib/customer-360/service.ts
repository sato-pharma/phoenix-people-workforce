/**
 * Customer 360 — everything this company knows about one pharmacy, on one page.
 *
 * The subject is a pharmacy from one of the two registers (see `subject.ts` for why there is no
 * single master id). What it can honestly show, and what it deliberately does not:
 *
 *  SHOWN, because a real link exists
 *   · identity and territory — the distributor code pair resolved through the SHARED place
 *     resolver, `src/lib/sales/customer-geography.ts`, so this page and the direct-order desk
 *     answer "which area" the same way
 *   · marketing requests raised for it        (marketing_request_pharmacies)
 *   · direct orders placed on it              (direct_order_requests.pharmacy_id)
 *   · the campaign a direct order came from   (direct_order_requests.marketing_request_id)
 *   · its actual sales                        (source_of_sales_channel_customer_rollup)
 *
 *  NOT SHOWN, because the link does not exist — and saying so is the point
 *   · CRM visits. CRM records pharmacies as their own contact type, and the names do not meet
 *     ours: 1 of 330 marketing pharmacy names and 0 of 52 direct-order names match a CRM pharmacy
 *     name (production, 2026-09-03). There is no pharmacy-level CRM join to build, only a
 *     geographic one, so this page reports the territory and does not pretend to report visits.
 *   · Weekly sales. Weekly is depot data with no customer field at all; it reaches an area at
 *     best. A "weekly sales for this pharmacy" figure cannot exist.
 *
 * Money on this page is filtered by `sales-visibility.ts` before it is returned — read the trap
 * documented there before touching any total.
 */

import type { PhoenixRole } from "@/lib/auth/permissions";
import {
  buildCustomerSalesView,
  type CustomerSalesRollupRow,
  type CustomerSalesView,
} from "@/lib/customer-360/sales-visibility";
import {
  customerGeographyKey,
  resolveCustomerGeography,
  type CustomerCodePair,
} from "@/lib/sales/customer-geography";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  encodeCustomerSubjectId,
  type CustomerRegister,
  type CustomerSubjectId,
  type CustomerSubjectRef,
} from "./subject";

export type CustomerCodeLink = {
  readonly areaCode: string | null;
  readonly brickId: string | null;
  readonly customerCode: string;
  readonly distributorCode: string;
  readonly distributorName: string | null;
  /** True when this exact pair is also on record in the OTHER register. */
  readonly alsoInOtherRegister: boolean;
  /** True when the sales customer map knows this pair. */
  readonly knownToSales: boolean;
};

export type CustomerSubjectSummary = {
  /** Area CODE, the one vocabulary both registers share — this is what scoping is applied to. */
  readonly areaCode: string | null;
  readonly areaName: string | null;
  readonly codeCount: number;
  readonly displayName: string;
  readonly id: CustomerSubjectId;
  readonly lineName: string | null;
  readonly ownerName: string | null;
  readonly register: CustomerRegister;
  readonly regionName: string | null;
  readonly validationStatus: string | null;
  readonly venueType: string | null;
};

export type CustomerMarketingRequestRow = {
  readonly estimatedCost: number | null;
  readonly id: string;
  readonly requestCode: string | null;
  readonly requestDate: string | null;
  readonly requesterName: string | null;
  readonly status: string | null;
};

export type CustomerDirectOrderRow = {
  readonly createdAt: string | null;
  readonly fromMarketingRequestId: string | null;
  readonly id: string;
  readonly line: string | null;
  readonly productName: string | null;
  readonly qty: number | null;
  readonly requesterName: string | null;
  readonly salesMonth: string | null;
  readonly salesValue: number | null;
  readonly status: string | null;
};

export type Customer360Profile = {
  readonly address: string | null;
  readonly areaName: string | null;
  readonly codes: CustomerCodeLink[];
  readonly directOrders: CustomerDirectOrderRow[];
  readonly displayName: string;
  readonly id: CustomerSubjectId;
  readonly lineName: string | null;
  readonly managerName: string | null;
  readonly marketingRequests: CustomerMarketingRequestRow[];
  readonly ownerName: string | null;
  readonly register: CustomerRegister;
  readonly regionName: string | null;
  readonly sales: CustomerSalesView;
  readonly validationStatus: string | null;
  readonly venueType: string | null;
};

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
};

const upper = (value: unknown): string => (typeof value === "string" ? value.trim().toUpperCase() : "");

const pairKey = (distributorCode: string, customerCode: string): string =>
  `${upper(distributorCode)}::${upper(customerCode)}`;

/** Name maps for areas, lines and people, so nothing renders as a raw id. */
async function loadNameMaps(): Promise<{
  areas: Map<number, { code: string | null; line: string | null; name: string }>;
  distributors: Map<number, string>;
  employees: Map<string, string>;
  lines: Map<number, string>;
}> {
  const supabase = getSupabaseAdmin();
  const [areaRows, lineRows, employeeRows, distributorRows] = await Promise.all([
    supabase.from("areas").select("id, name, code, line_id"),
    supabase.from("lines").select("id, name"),
    supabase.from("employees").select("hr_id, full_name"),
    supabase.from("marketing_distributors").select("id, display_name, distributor_code"),
  ]);

  const lines = new Map<number, string>();
  for (const row of lineRows.data ?? []) {
    const name = text((row as Record<string, unknown>).name);
    if (name) lines.set(Number((row as Record<string, unknown>).id), name);
  }

  const areas = new Map<number, { code: string | null; line: string | null; name: string }>();
  for (const row of areaRows.data ?? []) {
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const lineId = record.line_id == null ? null : Number(record.line_id);
    areas.set(Number(record.id), {
      code: text(record.code),
      line: lineId == null ? null : lines.get(lineId) ?? null,
      name,
    });
  }

  const employees = new Map<string, string>();
  for (const row of employeeRows.data ?? []) {
    const record = row as Record<string, unknown>;
    const hrId = text(record.hr_id);
    const name = text(record.full_name);
    if (hrId && name) employees.set(hrId.toLowerCase(), name);
  }

  const distributors = new Map<number, string>();
  for (const row of distributorRows.data ?? []) {
    const record = row as Record<string, unknown>;
    const name = text(record.display_name) ?? text(record.distributor_code);
    if (name) distributors.set(Number(record.id), name);
  }

  return { areas, distributors, employees, lines };
}

/**
 * Every pharmacy this company actually engages, from both registers.
 *
 * Merged-away rows are excluded: `merged_into_pharmacy_id` means a human has already said this row
 * is a duplicate of another, so showing it would offer two pages for one pharmacy.
 */
export async function listCustomerSubjects(): Promise<CustomerSubjectSummary[]> {
  const supabase = getSupabaseAdmin();
  const names = await loadNameMaps();

  const [marketingRows, marketingCodes, directRows, directCodes] = await Promise.all([
    fetchAllRowsKeyset<Record<string, unknown>>(
      () =>
        supabase
          .from("marketing_pharmacies")
          .select("id, display_name, area_id, line_id, owner_hr_id, region_name, validation_status, venue_type, active, merged_into_pharmacy_id"),
      { cursorColumn: "id", cursorOf: (row) => row.id as string },
    ),
    fetchAllRowsKeyset<Record<string, unknown>>(
      () => supabase.from("marketing_pharmacy_distributor_codes").select("id, pharmacy_id"),
      { cursorColumn: "id", cursorOf: (row) => row.id as string },
    ),
    fetchAllRowsKeyset<Record<string, unknown>>(
      () =>
        supabase
          .from("direct_order_pharmacies")
          .select("id, pharmacy_name, area_code, region_code, verification_status, venue_type, active, merged_into_pharmacy_id, created_by_hr_id"),
      { cursorColumn: "id", cursorOf: (row) => row.id as string },
    ),
    fetchAllRowsKeyset<Record<string, unknown>>(
      () => supabase.from("direct_order_pharmacy_distributor_codes").select("id, pharmacy_id"),
      { cursorColumn: "id", cursorOf: (row) => row.id as string },
    ),
  ]);

  const countByPharmacy = (rows: Record<string, unknown>[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const id = text(row.pharmacy_id);
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };

  const marketingCodeCounts = countByPharmacy(marketingCodes);
  const directCodeCounts = countByPharmacy(directCodes);
  const subjects: CustomerSubjectSummary[] = [];

  for (const row of marketingRows) {
    if (row.active === false || row.merged_into_pharmacy_id != null) continue;
    const id = text(row.id);
    if (!id) continue;
    const areaId = row.area_id == null ? null : Number(row.area_id);
    const area = areaId == null ? null : names.areas.get(areaId) ?? null;
    const lineId = row.line_id == null ? null : Number(row.line_id);
    subjects.push({
      areaCode: area?.code ?? null,
      areaName: area?.name ?? null,
      codeCount: marketingCodeCounts.get(id) ?? 0,
      displayName: text(row.display_name) ?? "Unnamed pharmacy",
      id: encodeCustomerSubjectId({ recordId: id, register: "marketing" }),
      lineName: (lineId == null ? null : names.lines.get(lineId) ?? null) ?? area?.line ?? null,
      ownerName: names.employees.get((text(row.owner_hr_id) ?? "").toLowerCase()) ?? null,
      register: "marketing",
      regionName: text(row.region_name),
      validationStatus: text(row.validation_status),
      venueType: text(row.venue_type),
    });
  }

  for (const row of directRows) {
    if (row.active === false || row.merged_into_pharmacy_id != null) continue;
    const id = text(row.id);
    if (!id) continue;
    subjects.push({
      areaCode: text(row.area_code),
      areaName: text(row.area_code),
      codeCount: directCodeCounts.get(id) ?? 0,
      displayName: text(row.pharmacy_name) ?? "Unnamed pharmacy",
      id: encodeCustomerSubjectId({ recordId: id, register: "direct-order" }),
      lineName: null,
      ownerName: names.employees.get((text(row.created_by_hr_id) ?? "").toLowerCase()) ?? null,
      register: "direct-order",
      regionName: text(row.region_code),
      validationStatus: text(row.verification_status),
      venueType: text(row.venue_type),
    });
  }

  return subjects.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The pairs recorded for this pharmacy, in whichever register it lives in. */
async function loadSubjectCodePairs(ref: CustomerSubjectRef): Promise<
  Array<CustomerCodePair & { distributorName: string | null }>
> {
  const supabase = getSupabaseAdmin();
  const names = await loadNameMaps();

  if (ref.register === "marketing") {
    const { data } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("distributor_id, mapped_distributor_code, mapped_customer_code, distributor_pharmacy_code")
      .eq("pharmacy_id", ref.recordId);
    const pairs: Array<CustomerCodePair & { distributorName: string | null }> = [];
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const distributorCode = text(row.mapped_distributor_code);
      const customerCode = text(row.mapped_customer_code) ?? text(row.distributor_pharmacy_code);
      if (!distributorCode || !customerCode) continue;
      const distributorId = row.distributor_id == null ? null : Number(row.distributor_id);
      pairs.push({
        customerCode,
        distributorCode,
        distributorName: distributorId == null ? null : names.distributors.get(distributorId) ?? null,
      });
    }
    return pairs;
  }

  const { data } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select("distributor_code, customer_code")
    .eq("pharmacy_id", ref.recordId);
  const pairs: Array<CustomerCodePair & { distributorName: string | null }> = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const distributorCode = text(row.distributor_code);
    const customerCode = text(row.customer_code);
    if (!distributorCode || !customerCode) continue;
    pairs.push({ customerCode, distributorCode, distributorName: null });
  }
  return pairs;
}

/** The same pair, on record in the register this subject does NOT belong to. */
async function loadOtherRegisterPairs(register: CustomerRegister): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const keys = new Set<string>();
  if (register === "marketing") {
    const rows = await fetchAllRowsKeyset<Record<string, unknown>>(
      () => supabase.from("direct_order_pharmacy_distributor_codes").select("id, distributor_code, customer_code"),
      { cursorColumn: "id", cursorOf: (row) => row.id as string },
    );
    for (const row of rows) keys.add(pairKey(String(row.distributor_code ?? ""), String(row.customer_code ?? "")));
    return keys;
  }
  const rows = await fetchAllRowsKeyset<Record<string, unknown>>(
    () =>
      supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("id, mapped_distributor_code, mapped_customer_code"),
    { cursorColumn: "id", cursorOf: (row) => row.id as string },
  );
  for (const row of rows) {
    keys.add(pairKey(String(row.mapped_distributor_code ?? ""), String(row.mapped_customer_code ?? "")));
  }
  return keys;
}

/**
 * This pharmacy's sales, one query per code pair.
 *
 * Deliberately NOT two `.in()` filters. PostgREST applies those independently, so they match the
 * cross-product rather than the pairs — the exact bug the shared place resolver was built to close.
 * A pharmacy holds a handful of pairs, so asking once per pair is both exact and cheap.
 */
async function loadSalesRows(pairs: readonly CustomerCodePair[]): Promise<CustomerSalesRollupRow[]> {
  if (pairs.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const collected: CustomerSalesRollupRow[] = [];
  for (const pair of pairs) {
    const { data } = await supabase
      .from("source_of_sales_channel_customer_rollup")
      .select("official_line, period, units_all, units_restricted, value_all, value_restricted")
      .eq("distributor_code", pair.distributorCode)
      .eq("client_code", pair.customerCode);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      collected.push({
        officialLine: text(row.official_line),
        period: text(row.period),
        unitsAll: row.units_all == null ? null : Number(row.units_all),
        unitsRestricted: row.units_restricted == null ? null : Number(row.units_restricted),
        valueAll: row.value_all == null ? null : Number(row.value_all),
        valueRestricted: row.value_restricted == null ? null : Number(row.value_restricted),
      });
    }
  }
  return collected;
}

export async function getCustomer360Profile(
  ref: CustomerSubjectRef,
  role: PhoenixRole,
): Promise<Customer360Profile | null> {
  const supabase = getSupabaseAdmin();
  const names = await loadNameMaps();

  const table = ref.register === "marketing" ? "marketing_pharmacies" : "direct_order_pharmacies";
  const { data: headRows } = await supabase.from(table).select("*").eq("id", ref.recordId).limit(1);
  const head = (headRows ?? [])[0] as Record<string, unknown> | undefined;
  if (!head) return null;

  const pairs = await loadSubjectCodePairs(ref);
  const otherRegister = await loadOtherRegisterPairs(ref.register);
  const geography = await resolveCustomerGeography(pairs);
  const salesRows = await loadSalesRows(pairs);

  const codes: CustomerCodeLink[] = pairs.map((pair) => {
    const resolved = geography.get(customerGeographyKey(pair.distributorCode, pair.customerCode));
    return {
      alsoInOtherRegister: otherRegister.has(pairKey(pair.distributorCode, pair.customerCode)),
      areaCode: resolved?.areaCode ?? null,
      brickId: resolved?.brickId ?? null,
      customerCode: pair.customerCode,
      distributorCode: pair.distributorCode,
      distributorName: pair.distributorName,
      knownToSales: Boolean(resolved),
    };
  });

  // Marketing requests reach a pharmacy through the join table; direct orders name it directly.
  const marketingRequests: CustomerMarketingRequestRow[] = [];
  if (ref.register === "marketing") {
    const { data: links } = await supabase
      .from("marketing_request_pharmacies")
      .select("request_id")
      .eq("pharmacy_id", ref.recordId);
    const requestIds = Array.from(
      new Set(((links ?? []) as Record<string, unknown>[]).map((row) => text(row.request_id)).filter(Boolean) as string[]),
    );
    if (requestIds.length > 0) {
      const { data: requests } = await supabase
        .from("marketing_requests")
        .select("id, request_code, status, request_date, estimated_cost, requester_hr_id")
        .in("id", requestIds);
      for (const row of (requests ?? []) as Record<string, unknown>[]) {
        marketingRequests.push({
          estimatedCost: row.estimated_cost == null ? null : Number(row.estimated_cost),
          id: String(row.id),
          requestCode: text(row.request_code),
          requestDate: text(row.request_date),
          requesterName: names.employees.get((text(row.requester_hr_id) ?? "").toLowerCase()) ?? null,
          status: text(row.status),
        });
      }
    }
  }

  const directOrders: CustomerDirectOrderRow[] = [];
  if (ref.register === "direct-order") {
    const { data: orders } = await supabase
      .from("direct_order_requests")
      .select("id, status, line, product_name, qty, sales_value, sales_month, created_at, requester_hr_id, marketing_request_id")
      .eq("pharmacy_id", ref.recordId)
      .order("created_at", { ascending: false });
    for (const row of (orders ?? []) as Record<string, unknown>[]) {
      directOrders.push({
        createdAt: text(row.created_at),
        fromMarketingRequestId: text(row.marketing_request_id),
        id: String(row.id),
        line: text(row.line),
        productName: text(row.product_name),
        qty: row.qty == null ? null : Number(row.qty),
        requesterName: names.employees.get((text(row.requester_hr_id) ?? "").toLowerCase()) ?? null,
        salesMonth: text(row.sales_month),
        salesValue: row.sales_value == null ? null : Number(row.sales_value),
        status: text(row.status),
      });
    }
  }

  const areaId = head.area_id == null ? null : Number(head.area_id);
  const area = areaId == null ? null : names.areas.get(areaId) ?? null;
  const lineId = head.line_id == null ? null : Number(head.line_id);
  const areaFromCodes = codes.find((code) => code.areaCode)?.areaCode ?? null;

  return {
    address: text(head.captured_address) ?? text(head.pharmacy_address),
    areaName: area?.name ?? text(head.area_code) ?? areaFromCodes,
    codes,
    directOrders,
    displayName: text(head.display_name) ?? text(head.pharmacy_name) ?? "Unnamed pharmacy",
    id: encodeCustomerSubjectId(ref),
    lineName: (lineId == null ? null : names.lines.get(lineId) ?? null) ?? area?.line ?? null,
    managerName: names.employees.get((text(head.manager_hr_id) ?? "").toLowerCase()) ?? null,
    marketingRequests,
    ownerName:
      names.employees.get((text(head.owner_hr_id) ?? "").toLowerCase()) ??
      names.employees.get((text(head.created_by_hr_id) ?? "").toLowerCase()) ??
      null,
    register: ref.register,
    regionName: text(head.region_name) ?? text(head.region_code),
    sales: buildCustomerSalesView(salesRows, role),
    validationStatus: text(head.validation_status) ?? text(head.verification_status),
    venueType: text(head.venue_type),
  };
}
