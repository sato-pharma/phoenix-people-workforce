// Master Map — the Supabase reads.
//
// Kept apart from tree.ts so the whole shape of the sheet stays testable without a database.
//
// The customer crosswalk is ~52,600 rows and PostgREST hard-caps a response at 1,000, so it is
// paged by KEYSET on the bigint id rather than by .range(). Offset paging re-scans everything it
// has already skipped, which on this table is the difference between one pass and fifty-three
// increasingly expensive ones — the same lesson the Master Workbook export already learned.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { MasterMapCustomerInput } from "@/lib/sales/master-map/customer-merge";
import type { AreaInput, BrickInput, RegionInput } from "@/lib/sales/master-map/tree";
import { prettyDistributorName } from "@/lib/sales/master-map/tree";

const PAGE_SIZE = 1000;

export type MasterMapSource = {
  areas: AreaInput[];
  bricks: BrickInput[];
  customers: MasterMapCustomerInput[];
  /** distributor code -> human-readable name, for the Code column. */
  distributorNames: Map<string, string>;
};

async function loadAllCustomers(): Promise<MasterMapCustomerInput[]> {
  const supabase = getSupabaseAdmin();
  const customers: MasterMapCustomerInput[] = [];
  let afterId = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("source_of_sales_customer_map")
      .select("id,distributor_code,customer_code,customer_name,address,brick_id,source")
      .eq("active", true)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      customers.push({
        address: (row.address as string | null) ?? "",
        brickId: String(row.brick_id ?? ""),
        customerCode: String(row.customer_code ?? ""),
        customerName: (row.customer_name as string | null) ?? "",
        distributorCode: String(row.distributor_code ?? ""),
        source: (row.source as string | null) ?? "",
      });
    }

    afterId = Number(rows[rows.length - 1].id);
    if (rows.length < PAGE_SIZE) break;
  }

  return customers;
}

export async function loadMasterMapSource(): Promise<MasterMapSource & { regions: RegionInput[] }> {
  const supabase = getSupabaseAdmin();

  const [regionsResult, areasResult, bricksResult, distributorsResult, customers] =
    await Promise.all([
      supabase.from("source_of_sales_regions").select("region_code,region_name").eq("active", true),
      supabase
        .from("source_of_sales_areas")
        .select("area_code,area_name,region_code")
        .eq("active", true),
      supabase
        .from("source_of_sales_bricks")
        .select("brick_id,brick_name,area_code")
        .eq("active", true),
      supabase.from("source_of_sales_distributors").select("distributor_code,distributor_name"),
      loadAllCustomers(),
    ]);

  for (const result of [regionsResult, areasResult, bricksResult, distributorsResult]) {
    if (result.error) throw result.error;
  }

  const distributorNames = new Map<string, string>();
  for (const row of distributorsResult.data ?? []) {
    const code = String(row.distributor_code ?? "");
    if (code) distributorNames.set(code, prettyDistributorName(String(row.distributor_name ?? "")) || code);
  }

  return {
    areas: (areasResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
    })),
    bricks: (bricksResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      brickId: String(row.brick_id ?? ""),
      brickName: String(row.brick_name ?? ""),
    })),
    customers,
    distributorNames,
    regions: (regionsResult.data ?? []).map((row) => ({
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    })),
  };
}
