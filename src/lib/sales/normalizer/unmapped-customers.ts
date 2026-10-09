import { getSupabaseAdmin } from "@/lib/supabase/server";

// Every customer with no ACTIVE mapping — switched off in the customer map, or present in imported sales and
// never mapped at all. The SoS Magic "Needs mapping" tab only lists what one analyzed FILE does not know, so
// a customer switched off in the database was invisible there until a file carrying its code was opened.

export type UnmappedCustomer = {
  distributorCode: string;
  customerCode: string;
  customerName: string;
  address: string;
  why: "switched off" | "never mapped";
  lastBrickId: string | null;
  lastAreaCode: string | null;
  lastSource: string | null;
  switchedOffAt: string | null;
  salesRows: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
  lines: string;
};

export type UnmappedCustomersResult = {
  customers: UnmappedCustomer[];
  /** True when the database returned exactly its row ceiling, so the list may be cut. */
  possiblyTruncated: boolean;
};

// PostgREST's default row ceiling. A result that fills it exactly is reported as possibly cut, never as complete.
export const UNMAPPED_ROW_CEILING = 1000;

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

export function parseUnmappedCustomers(rows: unknown): UnmappedCustomersResult {
  const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  const customers = list.map((r): UnmappedCustomer => ({
    distributorCode: text(r.distributor_code),
    customerCode: text(r.customer_code),
    customerName: text(r.customer_name),
    address: text(r.address),
    why: r.why === "switched off" ? "switched off" : "never mapped",
    lastBrickId: orNull(r.last_brick_id),
    lastAreaCode: orNull(r.last_area_code),
    lastSource: orNull(r.last_source),
    switchedOffAt: orNull(r.switched_off_at),
    salesRows: Number(r.sales_rows) || 0,
    firstPeriod: orNull(r.first_period),
    lastPeriod: orNull(r.last_period),
    lines: text(r.lines),
  }));
  return { customers, possiblyTruncated: list.length >= UNMAPPED_ROW_CEILING };
}

export async function listUnmappedCustomers(): Promise<UnmappedCustomersResult> {
  const { data, error } = await getSupabaseAdmin().rpc("sos_unmapped_customers");
  if (error) throw new Error(`Could not list the unmapped customers: ${error.message}`);
  return parseUnmappedCustomers(data);
}
