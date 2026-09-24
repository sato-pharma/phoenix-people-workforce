import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { forbiddenError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// "Direct Orders in my area" — the Medical Rep's VIEW-ONLY window onto the direct
// orders that landed in their own territory (owner instruction, 2026-09-24).
//
// A rep never RAISES a direct order — that is DIRECT_ORDER_REQUESTER_ROLES, District
// Manager upward. This tab lets them SEE the orders their District Manager booked on
// pharmacies that sit in the rep's own `employees.area_id`: who it was for, when it was
// collected, and the sales month Finance counted it in.
//
// Deliberately narrow and read-only:
//   · the SYSTEM direct-request path only (`direct_order_requests`), never the legacy
//     July 2026 XLSX overlay (`july-2026-direct-orders.ts`);
//   · only orders already COUNTED TO SALES — `status = 'approved'` AND a Finance-booked
//     `sales_month` (owner, 2026-09-24: "only counted orders"), from 2026-07 onward;
//   · scoped to the rep's own area(s) via the pharmacy's `area_code`, the same territory
//     idea as the ROI Tracker's area route.
//
// The GOLDEN RULE this honours: a direct order counts in the month FINANCE books it
// (`sales_month`), never the month it was raised — so a null `sales_month` is "not yet
// counted" and is deliberately excluded here.
// ─────────────────────────────────────────────────────────────────────────────

/** The system direct-request path is counted to sales from this month onward (owner: "from July"). */
export const AREA_DIRECT_ORDERS_FROM_MONTH = "2026-07";

export type RepAreaDirectOrderRow = {
  requestId: string;
  /** To whom — the pharmacy the order was booked on. */
  pharmacyName: string;
  areaName: string;
  productName: string;
  units: number;
  salesValue: number;
  /** When — the collection date, falling back to the decision/creation stamp. */
  orderDate: string | null;
  /** Which month Finance counted it to sales (YYYY-MM). */
  salesMonth: string;
};

export type RepAreaDirectOrdersReport = {
  rows: RepAreaDirectOrderRow[];
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

function chunk<T>(items: T[], size = 300): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

/**
 * The counted direct orders in the calling Medical Rep's own area(s), one row per product line.
 *
 * Access is enforced here (throws for any non-rep, non-system caller); the page's redirect is UX
 * only. The area bound is the rep's own `employees.area_id`, so this can never reach a sibling
 * rep's territory.
 */
export async function getRepAreaDirectOrders(access: AccessContext): Promise<RepAreaDirectOrdersReport> {
  assertAreaDirectOrdersAccess(access);

  const viewerKey = canonicalHrIdKey(access.hrId);
  if (!viewerKey) return EMPTY;

  const supabase = getSupabaseAdmin();

  // 1) the viewer's own area(s), from the employee directory.
  const employeeRows = await getEmployeeDirectoryRows({ includeInactive: true });
  const viewer = employeeRows.find((row) => canonicalHrIdKey(row.hrId) === viewerKey);
  const areaIds = new Set<number>();
  const rawAreaId = viewer?.areaId;
  if (rawAreaId !== null && rawAreaId !== undefined && Number.isFinite(Number(rawAreaId))) {
    areaIds.add(Number(rawAreaId));
  }
  if (areaIds.size === 0) return EMPTY;

  // 2) resolve those numeric area ids to their text codes + names. A direct order carries its
  //    area on the pharmacy as `area_code` (text); `employees.area_id` is the numeric `areas.id`.
  const { data: areaRows, error: areaError } = await supabase
    .from("areas")
    .select("id, code, name")
    .in("id", Array.from(areaIds));
  if (areaError) throw areaError;
  const codeToArea = new Map<string, { name: string }>();
  const areaNames: string[] = [];
  for (const row of (areaRows ?? []) as Array<{ id: number | string; code: string | null; name: string | null }>) {
    const code = (row.code ?? "").trim();
    if (!code) continue;
    const name = (row.name ?? "").trim() || code;
    codeToArea.set(code, { name });
    if (!areaNames.includes(name)) areaNames.push(name);
  }
  const codes = Array.from(codeToArea.keys());
  if (codes.length === 0) return { ...EMPTY, areaNames };

  // 3) pharmacies sitting in those areas ("to whom").
  const pharmacyById = new Map<string, { name: string; areaName: string }>();
  for (const part of chunk(codes)) {
    const { data, error } = await supabase
      .from("direct_order_pharmacies")
      .select("id, pharmacy_name, area_code")
      .in("area_code", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; pharmacy_name: string | null; area_code: string | null }>) {
      const area = codeToArea.get((row.area_code ?? "").trim());
      pharmacyById.set(row.id, {
        name: (row.pharmacy_name ?? "").trim() || "—",
        areaName: area?.name ?? "—",
      });
    }
  }
  const pharmacyIds = Array.from(pharmacyById.keys());
  if (pharmacyIds.length === 0) return { ...EMPTY, areaNames };

  // 4) counted orders on those pharmacies — approved AND a Finance-booked sales month, 2026-07+,
  //    excluding superseded (reversed) and duplicate rows so nothing is double-shown.
  const requests: RequestRow[] = [];
  for (const part of chunk(pharmacyIds)) {
    const { data, error } = await supabase
      .from("direct_order_requests")
      .select(
        "id, pharmacy_id, sales_month, collection_date, decided_at, created_at, product_code, product_name, qty, sales_value",
      )
      .eq("status", "approved")
      .not("sales_month", "is", null)
      .gte("sales_month", AREA_DIRECT_ORDERS_FROM_MONTH)
      .is("reversed_by_request_id", null)
      .is("duplicate_of_request_id", null)
      .in("pharmacy_id", part);
    if (error) throw error;
    requests.push(...((data ?? []) as RequestRow[]));
  }
  if (requests.length === 0) return { ...EMPTY, areaNames };

  const requestById = new Map(requests.map((request) => [request.id, request] as const));
  const requestIds = requests.map((request) => request.id);

  // 5) product lines. Since baskets (2026-08-12) one request can carry several products, one row
  //    each; a legacy single-product request with no item rows falls back to the header snapshot,
  //    so an order is never silently dropped.
  const items: ItemRow[] = [];
  for (const part of chunk(requestIds)) {
    const { data, error } = await supabase
      .from("direct_order_request_items")
      .select("request_id, product_code, product_name, qty, sales_value")
      .in("request_id", part);
    if (error) throw error;
    items.push(...((data ?? []) as ItemRow[]));
  }

  const rows: RepAreaDirectOrderRow[] = [];
  const requestsWithItems = new Set<string>();
  const push = (
    request: RequestRow,
    line: { productCode: string | null; productName: string | null; qty: unknown; salesValue: unknown },
  ) => {
    const pharmacy = pharmacyById.get(request.pharmacy_id);
    rows.push({
      requestId: request.id,
      pharmacyName: pharmacy?.name ?? "—",
      areaName: pharmacy?.areaName ?? "—",
      productName: (line.productName ?? "").trim() || (line.productCode ?? "").trim() || "—",
      units: toNum(line.qty),
      salesValue: toNum(line.salesValue),
      orderDate: request.collection_date ?? request.decided_at ?? request.created_at ?? null,
      salesMonth: request.sales_month ?? "",
    });
  };

  for (const item of items) {
    const request = requestById.get(item.request_id);
    if (!request) continue;
    requestsWithItems.add(item.request_id);
    push(request, {
      productCode: item.product_code,
      productName: item.product_name,
      qty: item.qty,
      salesValue: item.sales_value,
    });
  }
  for (const request of requests) {
    if (requestsWithItems.has(request.id)) continue;
    push(request, {
      productCode: request.product_code,
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
