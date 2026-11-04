import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isDirectOrderOnRepLine, lineHasDirectOrders } from "@/lib/direct-orders/line-scope";
import { forbiddenError } from "@/lib/http/api-errors";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { expandAreaCodesForLine, foldAreaCodeForLine, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import { closingRegionsAsOfDate } from "@/lib/sales/closing-organogram-regions";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleased, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { resolveAuLineCode } from "@/lib/sales/territory/skeleton";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// "Direct Orders in my area" — the Medical Rep's VIEW-ONLY window onto the direct
// orders that landed in their own territory (owner instruction, 2026-09-24).
//
// A rep never RAISES a direct order — that is DIRECT_ORDER_REQUESTER_ROLES, District
// Manager upward. This tab lets them SEE the orders their District Manager booked on
// pharmacies that sit in the rep's own area(s): who it was for, when it was collected,
// and the sales month Finance counted it in.
//
// Deliberately narrow and read-only:
//   · the SYSTEM direct-request path only (`direct_order_requests`), never the legacy
//     July 2026 XLSX overlay (`july-2026-direct-orders.ts`);
//   · only orders already COUNTED TO SALES — `status = 'approved'` AND a Finance-booked
//     `sales_month` (owner, 2026-09-24: "only counted orders"), from 2026-07 onward;
//   · scoped to the rep's own area(s) via the pharmacy's `area_code`, the same territory
//     idea as the ROI Tracker's area route;
//   · AND to the rep's own LINE via the order's `line` (owner, 2026-10-29). An area is shared by
//     every line, so the area alone showed Pedia reps 40 Anti Infective orders and Anti Infective
//     reps 20 Pedia ones; a CNS rep — whose line runs no direct orders — saw 87 and now sees none.
//
// WHICH areas are "the rep's own" (owner, 2026-09-25 — "all the rep's areas", matching Sales vs
// Target): their `employees.area_id`, PLUS every area their own organogram REP seat covers, with
// any merged area expanded to both halves via `expandAreaCodesForLine` — all resolved for the
// order's COUNTED month. Before this, one `employees.area_id` was the whole scope, so the rep of
// Anti Infective's "Ismailia and Suez" (OT2 + OT9, one area from 2026-09) saw only one half, and a
// rep whose seat covers two areas saw one — while Sales vs Target counted both.
//
// The GOLDEN RULE this honours: a direct order counts in the month FINANCE books it
// (`sales_month`), never the month it was raised — so a null `sales_month` is "not yet
// counted" and is deliberately excluded here. The area scope is dated by that same month.
// ─────────────────────────────────────────────────────────────────────────────

/** The system direct-request path is counted to sales from this month onward (owner: "from July"). */
export const AREA_DIRECT_ORDERS_FROM_MONTH = "2026-07";

/** Shown where an area or product has no name on record — never a raw code. */
export const UNNAMED_AREA = "Unnamed area";
export const UNNAMED_PRODUCT = "Unnamed product";

export type RepAreaDirectOrderRow = {
  requestId: string;
  /** To whom — the pharmacy the order was booked on. */
  pharmacyName: string;
  areaName: string;
  productName: string;
  units: number;
  salesValue: number;
  /**
   * When the order was PLACED — `created_at` (the rep raising it), falling back to the decision
   * then the collection stamp. NOT the collection date: an order raised and approved in August but
   * collected in September still counts in August, and sourcing this from `collection_date` made
   * such a row read as "ordered September, counted August" (owner, 2026-09-24).
   */
  orderDate: string | null;
  /** Which month Finance counted it to sales (YYYY-MM). */
  salesMonth: string;
};

export type RepAreaDirectOrdersReport = {
  rows: RepAreaDirectOrderRow[];
  /** True when the rep's line runs no direct orders (CNS) — the page sends him home. */
  lineRunsNoDirectOrders?: boolean;
  /** The viewer's own area name(s), for the header. */
  areaNames: string[];
  totalUnits: number;
  totalValue: number;
};

/** Only a Medical Rep (or a system-scoped caller) may read this area window. */
export function assertAreaDirectOrdersAccess(access: AccessContext): void {
  if (access.scope === "system") return;
  if (access.role !== "Medical Rep") {
    throw forbiddenError(`Forbidden: ${access.role} cannot view area direct orders.`);
  }
}

// ── The rep's area scope, per counted month (pure) ─────────────────────────────────────────

/** One area the rep's own organogram REP seat covers, dated as the seat map dates it. */
export type RepSeatArea = {
  lineCode: string;
  areaCode: string;
  /** `YYYY-MM-DD`, inclusive; null = always. */
  effectiveFrom: string | null;
  /** `YYYY-MM-DD`, EXCLUSIVE (the day the successor row opens); null = still in force. */
  effectiveTo: string | null;
};

export type RepAreaScopeInput = {
  /** The rep's organogram line code (`anti_infective`, `cns`, `pedia`), or null when it has none. */
  lineCode: string | null;
  /** The code of the rep's own `employees.area_id`, or null when it is unset. */
  homeAreaCode: string | null;
  /** Every area row of every REP seat the rep occupies. */
  seatAreas: readonly RepSeatArea[];
};

const up = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/**
 * Every real area code the rep covers in one counted month, UPPER-cased.
 *
 * A seat row counts when it is in force on the LAST day of that month — the closing's own as-of
 * date (`closingRegionsAsOfDate`), so a territory move dated the 1st of a later month never reaches
 * back into an earlier one. Each code is then expanded through `expandAreaCodesForLine` for that
 * month, so a merged area brings its folded half with it only from the month the merge starts
 * (Ismailia and Suez from 2026-09; August keeps Suez alone). Never wider than the rep's own seat
 * and home area: a rep with no line and no seat keeps exactly their home area.
 */
export function repAreaCodesForMonth(input: RepAreaScopeInput, salesMonth: string): Set<string> {
  const month = salesMonth.slice(0, 7);
  const asOf = closingRegionsAsOfDate(month);
  const codesByLine = new Map<string, Set<string>>();
  const add = (lineCode: string | null, areaCode: string | null) => {
    const code = up(areaCode);
    if (!code) return;
    const key = String(lineCode ?? "").trim();
    const bucket = codesByLine.get(key) ?? new Set<string>();
    bucket.add(code);
    codesByLine.set(key, bucket);
  };

  add(input.lineCode, input.homeAreaCode);
  for (const seat of input.seatAreas) {
    const from = String(seat.effectiveFrom ?? "");
    const to = String(seat.effectiveTo ?? "");
    if (from && from > asOf) continue;
    if (to && to <= asOf) continue;
    add(seat.lineCode, seat.areaCode);
  }

  const out = new Set<string>();
  for (const [lineCode, codes] of codesByLine) {
    for (const code of expandAreaCodesForLine(lineCode || null, codes, month)) out.add(up(code));
  }
  return out;
}

/** Every `YYYY-MM` from `from` to `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);
  if (![year, month, endYear, endMonth].every(Number.isFinite)) return out;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * The name an area shows under for one line and month: the merged name when that code is folded
 * ("Ismailia and Suez"), else its own name, else "Unnamed area" — never a raw code.
 */
export function repAreaDisplayName(
  lineCode: string | null,
  areaCode: string,
  month: string,
  nameByCode: ReadonlyMap<string, string>,
): string {
  const keep = foldAreaCodeForLine(lineCode, areaCode, month);
  return getMergedAreaName(lineCode, keep, month) ?? nameByCode.get(up(areaCode)) ?? UNNAMED_AREA;
}

function chunk<T>(items: T[], size = 300): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Chunks read at once — the figure every other fan-out on the rep's pages uses. */
const CHUNK_CONCURRENCY = 4;

function toNum(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const EMPTY: RepAreaDirectOrdersReport = { rows: [], areaNames: [], totalUnits: 0, totalValue: 0 };

type RequestRow = {
  id: string;
  pharmacy_id: string;
  sales_month: string | null;
  collection_date: string | null;
  decided_at: string | null;
  created_at: string | null;
  line: string | null;
  product_code: string | null;
  product_name: string | null;
  qty: number | string | null;
  sales_value: number | string | null;
};

type ItemRow = {
  request_id: string;
  product_code: string | null;
  product_name: string | null;
  qty: number | string | null;
  sales_value: number | string | null;
};

/** The REP seats the viewer occupies, and every area row those seats carry. */
async function loadRepSeatAreas(viewerKey: string): Promise<RepSeatArea[]> {
  const supabase = getSupabaseAdmin();
  const { data: seatRows, error: seatError } = await supabase
    .from("au_v_org_tree")
    .select("seat_id, seat_tier, occupant_hr_id")
    .eq("seat_tier", "REP");
  if (seatError) throw seatError;
  const seatIds = ((seatRows ?? []) as Array<{ seat_id: string | null; occupant_hr_id: string | null }>)
    .filter((row) => row.seat_id && canonicalHrIdKey(row.occupant_hr_id) === viewerKey)
    .map((row) => String(row.seat_id));
  if (seatIds.length === 0) return [];

  const { data, error } = await supabase
    .from("au_v_line_area_map_all")
    .select("line_code, area_code, effective_from, effective_to")
    .in("rep_seat_id", seatIds);
  if (error) throw error;
  return ((data ?? []) as Array<{
    line_code: string | null;
    area_code: string | null;
    effective_from: string | null;
    effective_to: string | null;
  }>)
    .filter((row) => up(row.area_code))
    .map((row) => ({
      lineCode: String(row.line_code ?? "").trim(),
      areaCode: up(row.area_code),
      effectiveFrom: row.effective_from ?? null,
      effectiveTo: row.effective_to ?? null,
    }));
}

/**
 * The counted direct orders in the calling Medical Rep's own area(s), one row per product line.
 *
 * Access is enforced here (throws for any non-rep, non-system caller); the page's redirect is UX
 * only. The area bound is the rep's own `employees.area_id` plus their own REP seat's areas, each
 * expanded for the order's counted month, so this can never reach a sibling rep's territory.
 */
export async function getRepAreaDirectOrders(access: AccessContext): Promise<RepAreaDirectOrdersReport> {
  assertAreaDirectOrdersAccess(access);

  const viewerKey = canonicalHrIdKey(access.hrId);
  if (!viewerKey) return EMPTY;

  const supabase = getSupabaseAdmin();

  // Steps 1–2 and step 3 share nothing — the seat map is keyed on the viewer's HR id alone — so they
  // run together (2026-10-01, "slow to transfer between page and page") instead of one after the
  // other. Either failing still fails the page, exactly as before.
  const homeLoad = (async () => {
    // 1) the viewer's own home area and line, from the employee directory.
    const employeeRows = await getEmployeeDirectoryRows({ includeInactive: true });
    const viewerRow = employeeRows.find((row) => canonicalHrIdKey(row.hrId) === viewerKey);
    const areaIds = new Set<number>();
    const rawAreaId = viewerRow?.areaId;
    if (rawAreaId !== null && rawAreaId !== undefined && Number.isFinite(Number(rawAreaId))) {
      areaIds.add(Number(rawAreaId));
    }

    // 2) resolve that numeric area id to its text code. A direct order carries its area on the
    //    pharmacy as `area_code` (text); `employees.area_id` is the numeric `areas.id`.
    let home: string | null = null;
    if (areaIds.size > 0) {
      const { data: homeRows, error: homeError } = await supabase
        .from("areas")
        .select("id, code, name")
        .in("id", Array.from(areaIds));
      if (homeError) throw homeError;
      home = up((homeRows ?? [])[0]?.code as string | null | undefined) || null;
    }
    return { viewer: viewerRow, homeAreaCode: home };
  })();

  // 3) the rep's own REP seat areas — a seat can cover more than one area (the Ismailia and Suez
  //    seat carries both OT2 and OT9), which one `employees.area_id` can never say.
  const [{ viewer, homeAreaCode }, seatAreas] = await Promise.all([homeLoad, loadRepSeatAreas(viewerKey)]);
  const seatLine = seatAreas.find((seat) => seat.lineCode)?.lineCode ?? null;
  const scope: RepAreaScopeInput = {
    lineCode: seatLine ?? (viewer?.lineName ? resolveAuLineCode(viewer.lineName) : null),
    homeAreaCode,
    seatAreas,
  };

  // The rep's own line bounds what he sees (owner, 2026-10-29). A line that runs no direct orders
  // (CNS) sees nothing and is sent home; a rep with no line on record sees nothing rather than
  // every line's orders in his area — fail closed.
  const repLine = scope.lineCode ?? viewer?.lineName ?? null;
  if (!lineHasDirectOrders(repLine)) {
    return { ...EMPTY, lineRunsNoDirectOrders: Boolean(String(repLine ?? "").trim()) };
  }

  // Every code the rep could cover in any month this window shows; each order is then checked
  // against its OWN counted month below, so a merge never reaches back before it starts.
  const { year, month } = currentCairoDateParts();
  const currentMonth = `${year}-${String(month).padStart(2, "0")}`;
  const windowMonths = monthsBetween(AREA_DIRECT_ORDERS_FROM_MONTH, currentMonth);
  const scopeByMonth = new Map<string, Set<string>>();
  const scopeFor = (salesMonth: string) => {
    const key = salesMonth.slice(0, 7);
    let codes = scopeByMonth.get(key);
    if (!codes) {
      codes = repAreaCodesForMonth(scope, key);
      scopeByMonth.set(key, codes);
    }
    return codes;
  };
  const candidateCodes = new Set<string>();
  for (const windowMonth of windowMonths) for (const code of scopeFor(windowMonth)) candidateCodes.add(code);
  const codes = Array.from(candidateCodes);
  if (codes.length === 0) return EMPTY;

  // 4) the names those codes show under, and 5) the pharmacies sitting in those areas — both keyed
  //    on `codes` alone, so they are read together (2026-10-01, speed), each pharmacy chunk alongside
  //    the others. The chunks' rows are taken back in CHUNK order below, exactly as the serial walk
  //    took them, so every map is built in the same order.
  const [areaResult, pharmacyParts] = await Promise.all([
    supabase.from("areas").select("code, name").in("code", codes),
    // Four chunks at a time, like every other fan-out on these pages; results come back in chunk order.
    mapWithConcurrency(chunk(codes), CHUNK_CONCURRENCY, async (part) => {
      const { data, error } = await supabase
        .from("direct_order_pharmacies")
        .select("id, pharmacy_name, area_code")
        .in("area_code", part);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; pharmacy_name: string | null; area_code: string | null }>;
    }),
  ]);

  // 4) A code with no name reads "Unnamed area", never itself.
  const nameByCode = new Map<string, string>();
  const { data: areaRows, error: areaError } = areaResult;
  if (areaError) throw areaError;
  for (const row of (areaRows ?? []) as Array<{ code: string | null; name: string | null }>) {
    const name = (row.name ?? "").trim();
    if (up(row.code) && name) nameByCode.set(up(row.code), name);
  }
  const lineByCode = new Map<string, string | null>();
  for (const seat of seatAreas) if (!lineByCode.has(seat.areaCode)) lineByCode.set(seat.areaCode, seat.lineCode || null);
  const lineOf = (code: string) => lineByCode.get(code) ?? scope.lineCode;

  // The header names the rep's areas as they stand this month, a merged pair once.
  const areaNames: string[] = [];
  for (const code of Array.from(scopeFor(currentMonth)).sort()) {
    const name = repAreaDisplayName(lineOf(code), code, currentMonth, nameByCode);
    if (!areaNames.includes(name)) areaNames.push(name);
  }

  // 5) pharmacies sitting in those areas ("to whom"), read above.
  const pharmacyById = new Map<string, { name: string; areaCode: string }>();
  for (const part of pharmacyParts) {
    for (const row of part) {
      pharmacyById.set(row.id, {
        name: (row.pharmacy_name ?? "").trim() || "—",
        areaCode: up(row.area_code),
      });
    }
  }
  const pharmacyIds = Array.from(pharmacyById.keys());
  if (pharmacyIds.length === 0) return { ...EMPTY, areaNames };

  // 6) counted orders on those pharmacies — approved AND a Finance-booked sales month, 2026-07+,
  //    excluding superseded (reversed) and duplicate rows so nothing is double-shown. The chunks run
  //    together and are joined in chunk order, so `fetched` is the list the serial walk produced.
  const fetched: RequestRow[] = (
    await mapWithConcurrency(chunk(pharmacyIds), CHUNK_CONCURRENCY, async (part) => {
      const { data, error } = await supabase
        .from("direct_order_requests")
        .select(
          "id, pharmacy_id, sales_month, collection_date, decided_at, created_at, line, product_code, product_name, qty, sales_value",
        )
        .eq("status", "approved")
        .not("sales_month", "is", null)
        .gte("sales_month", AREA_DIRECT_ORDERS_FROM_MONTH)
        .is("reversed_by_request_id", null)
        .is("duplicate_of_request_id", null)
        .in("pharmacy_id", part);
      if (error) throw error;
      return (data ?? []) as RequestRow[];
    })
  ).flat();
  // Each order stays only if it is the rep's own LINE and its pharmacy's area was the rep's in the
  // month it was COUNTED. Without the line test another line's orders in the same area leak in.
  //
  // And only once that month is published for the rep's line (owner, 2026-11-04). The Direct Orders
  // workflow screens stay a work record; this one reports what the rep's AREA sold, so it is a sales
  // figure and waits for the closing like every other.
  const publishedKeys = await loadSalesReleaseKeys();
  const repLineCode = resolveTargetLineCode(repLine);
  const requests = fetched.filter((request) => {
    if (!isDirectOrderOnRepLine(request.line, repLine)) return false;
    if (!request.sales_month || !isSalesPeriodReleased(request.sales_month, repLineCode, publishedKeys)) return false;
    const pharmacy = pharmacyById.get(request.pharmacy_id);
    return Boolean(pharmacy && request.sales_month && scopeFor(request.sales_month).has(pharmacy.areaCode));
  });
  if (requests.length === 0) return { ...EMPTY, areaNames };

  const requestById = new Map(requests.map((request) => [request.id, request] as const));
  const requestIds = requests.map((request) => request.id);

  // 7) product lines. Since baskets (2026-08-12) one request can carry several products, one row
  //    each; a legacy single-product request with no item rows falls back to the header snapshot,
  //    so an order is never silently dropped. Chunks together, joined in chunk order.
  const items: ItemRow[] = (
    await Promise.all(
      chunk(requestIds).map(async (part) => {
        const { data, error } = await supabase
          .from("direct_order_request_items")
          .select("request_id, product_code, product_name, qty, sales_value")
          .in("request_id", part);
        if (error) throw error;
        return (data ?? []) as ItemRow[];
      }),
    )
  ).flat();

  const rows: RepAreaDirectOrderRow[] = [];
  const requestsWithItems = new Set<string>();
  const push = (
    request: RequestRow,
    line: { productName: string | null; qty: unknown; salesValue: unknown },
  ) => {
    const pharmacy = pharmacyById.get(request.pharmacy_id);
    const salesMonth = request.sales_month ?? "";
    rows.push({
      requestId: request.id,
      pharmacyName: pharmacy?.name ?? "—",
      areaName: pharmacy?.areaCode
        ? repAreaDisplayName(lineOf(pharmacy.areaCode), pharmacy.areaCode, salesMonth.slice(0, 7), nameByCode)
        : UNNAMED_AREA,
      productName: (line.productName ?? "").trim() || UNNAMED_PRODUCT,
      units: toNum(line.qty),
      salesValue: toNum(line.salesValue),
      orderDate: request.created_at ?? request.decided_at ?? request.collection_date ?? null,
      salesMonth,
    });
  };

  for (const item of items) {
    const request = requestById.get(item.request_id);
    if (!request) continue;
    requestsWithItems.add(item.request_id);
    push(request, {
      productName: item.product_name,
      qty: item.qty,
      salesValue: item.sales_value,
    });
  }
  for (const request of requests) {
    if (requestsWithItems.has(request.id)) continue;
    push(request, {
      productName: request.product_name,
      qty: request.qty,
      salesValue: request.sales_value,
    });
  }

  // Newest counted month first, then the most recent order, then a stable name order.
  rows.sort(
    (left, right) =>
      right.salesMonth.localeCompare(left.salesMonth) ||
      (right.orderDate ?? "").localeCompare(left.orderDate ?? "") ||
      left.pharmacyName.localeCompare(right.pharmacyName),
  );

  const totalUnits = rows.reduce((sum, row) => sum + row.units, 0);
  const totalValue = rows.reduce((sum, row) => sum + row.salesValue, 0);

  return { rows, areaNames, totalUnits, totalValue };
}
