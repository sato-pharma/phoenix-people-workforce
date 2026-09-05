// The even-split customer registry — the small table that says "this customer's areas are decided
// by a rule of their own, not by the geography on the invoice".
//
// Today it holds exactly one row: client 1011654 (مخزن شركه اى زد, "EZ") on CNS, whose units the
// owner rules are shared evenly between the CNS reps active in Cairo and Giza that month. That rule
// lives in the database, in phx_sos_rows_attributed(period), and is applied when the fact rollup is
// rebuilt — the roster is frozen per period in sos_even_split_roster.
//
// WHY THE CLOSING NEEDS TO READ IT. The store city split (store-sales-city-split.ts) redistributes
// a wholesaler's sales across the areas of its city. EZ is a wholesaler, sitting in Cairo, on a
// split-eligible line — so on its face it qualifies, and the split would deal its units out again
// on top of a distribution the database has already made. Two rules would then own the same units.
//
// The split's existing exemption cannot see this. customersAlreadySplitAcrossAreas spots a customer
// a HUMAN apportioned, by noticing rows that point away from the brick they all still carry. EZ's
// rows carry no such tell: the split reads source_of_sales_import_rows, which is the raw invoice,
// where EZ is a single Cairo East 1 row for the whole month. The distribution happens later, in the
// rollup the Closing Matrix reads. So the details rows say "one area" while the matrix says "seven",
// and only the registry can bridge that gap.
//
// It is read, not hard-coded, because the registry is a table the owner can add to. A second even-
// split customer must be exempt the day it is registered, not the day someone remembers this file.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeLineKey } from "@/lib/sales/confidential-products";

/**
 * The key an exemption is matched on: client code plus normalized line.
 *
 * The line is part of the key because the registry is keyed that way — `(client_code,
 * official_line)` is its primary key. EZ is registered on CNS alone, so were the same wholesaler
 * ever to sell on Pedia, those units would still be the city split's to move.
 */
export function evenSplitKey(clientCode: unknown, officialLine: unknown): string {
  return `${String(clientCode ?? "").trim()}|${normalizeLineKey(String(officialLine ?? ""))}`;
}

/**
 * Every ACTIVE registry entry, as `evenSplitKey` strings.
 *
 * Inactive rows are left out on purpose: deactivating an entry is how the owner hands a customer
 * back to ordinary geography, and the database's own split honours `active` the same way.
 *
 * Throws if the table cannot be read. That is deliberate — a silently empty registry would let the
 * city split re-deal units the database has already distributed, and a wrong number on the closing
 * is far more expensive here than a page that says it is broken.
 */
export async function loadEvenSplitCustomerKeys(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sos_even_split_customers")
    .select("client_code,official_line")
    .eq("active", true);
  if (error) throw error;
  return new Set(
    (data ?? []).map((row) => evenSplitKey(row?.client_code, row?.official_line)),
  );
}
