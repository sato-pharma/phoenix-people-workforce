import { getSupabaseAdmin } from "@/lib/supabase/server";

// The customer -> brick crosswalk (code / name / address -> brick), for the read-only "Database
// Validation" tab. Optionally filtered to one distributor. Fully paginated past PostgREST's 1000-row
// cap (the table can hold tens of thousands of rows).

export type CustomerMapRow = {
  address: string;
  areaCode: string;
  brickId: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  regionCode: string;
};

export async function listCustomerMap(filter?: { distributorCode?: string }): Promise<CustomerMapRow[]> {
  const supabase = getSupabaseAdmin();
  const pageSize = 1000;
  const rows: CustomerMapRow[] = [];
  let from = 0;
  for (;;) {
    let query = supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code,customer_code,customer_name,address,brick_id,area_code,region_code")
      .eq("active", true)
      .order("distributor_code", { ascending: true })
      .order("customer_code", { ascending: true });
    if (filter?.distributorCode) query = query.eq("distributor_code", filter.distributorCode);
    const result = await query.range(from, from + pageSize - 1);
    if (result.error) break; // tolerate (e.g. table absent pre-migration); return what we have
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of page) {
      rows.push({
        address: String(r.address ?? ""),
        areaCode: String(r.area_code ?? ""),
        brickId: String(r.brick_id ?? ""),
        customerCode: String(r.customer_code ?? ""),
        customerName: String(r.customer_name ?? ""),
        distributorCode: String(r.distributor_code ?? ""),
        regionCode: String(r.region_code ?? ""),
      });
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}
