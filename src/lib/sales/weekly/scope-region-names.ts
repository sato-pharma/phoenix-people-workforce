// Weekly scope lines — the name of the one region a manager is bound to, read from the organogram.
//
// The portal Weekly Sales dashboard, its Depot Detail tab and Weekly Stock each print a scope line
// ("Pedia · Upper Egypt 1 · District Manager") on the screen and in the workbook. Each used to name a single
// bound region from the depot rows' own region labels, or print its code. Depot rows keep the region they were
// mapped with ("Upper Egypt"), never Upper Egypt 1, Upper Egypt 2 or Delta (3), so those lookups missed exactly
// the managers of those regions: measured on production 2026-09-17, five district managers (Pedia Upper Egypt 1
// and 2, Anti Infective Upper Egypt 1 and 2, Anti Infective Delta (3)) read "1 region" or a code, and every
// single-region manager read his code on the dashboard ("GZ region").
//
// The organogram (au_v_org_tree) names every region a seat sits in, under the same codes the weekly scope bounds
// by, so all three lines take the region's name from here and read the same words for the same manager.
//
// Fails soft: an unreadable org tree leaves the lookup empty and the line reads "1 region" — never a code, and
// never an error page over a scope line.

import type { WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** What a scope line says for a single bound region whose name could not be read. Words, never a code. */
export const WEEKLY_SCOPE_REGION_FALLBACK = "1 region";

/** One `au_v_org_tree` row, narrowed to what the lookup reads. */
export type WeeklyScopeRegionRow = {
  region_code?: string | null;
  region_name?: string | null;
};

/** Pure: region code (upper case) → its organogram name. A row with no region code or no name adds nothing. */
export function selectWeeklyScopeRegionNames(rows: readonly WeeklyScopeRegionRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const code = String(row.region_code ?? "").trim().toUpperCase();
    const name = String(row.region_name ?? "").trim();
    if (code && name && !names.has(code)) names.set(code, name);
  }
  return names;
}

/** Pure: only a territory viewer bound to exactly one region has that region named on his scope line. */
export function weeklyScopeNamesOneRegion(scope: WeeklyAccessScope): boolean {
  return scope.tier === "territory" && scope.allowedRegionCodes !== null && scope.allowedRegionCodes.size === 1;
}

/**
 * The organogram's region names for a viewer's scope line. Only a viewer bound to exactly one region has a
 * region named, so every other viewer costs no read at all. Fails soft to an empty map.
 */
export async function loadWeeklyScopeRegionNames(
  scope: WeeklyAccessScope,
  /** Injected only by the test — production always uses the admin client. */
  client?: Pick<ReturnType<typeof getSupabaseAdmin>, "from">,
): Promise<Map<string, string>> {
  if (!weeklyScopeNamesOneRegion(scope)) return new Map();
  try {
    // Inside the try: a missing service key throws here, and that too must leave the line readable.
    const supabase: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = client ?? getSupabaseAdmin();
    const { data, error } = await supabase.from("au_v_org_tree_sales").select("region_code,region_name");
    if (error) return new Map();
    return selectWeeklyScopeRegionNames((data ?? []) as WeeklyScopeRegionRow[]);
  } catch {
    return new Map();
  }
}

/**
 * Pure: the region part of every weekly scope line — "all regions", the one bound region's organogram name, or
 * "N regions". A name the lookup could not supply reads "1 region", never the code.
 */
export function weeklyScopeRegionPart(
  allowedRegionCodes: ReadonlySet<string> | null,
  regionNames: ReadonlyMap<string, string>,
): string {
  if (!allowedRegionCodes) return "all regions";
  if (allowedRegionCodes.size !== 1) return `${allowedRegionCodes.size} regions`;
  const [code] = [...allowedRegionCodes];
  return regionNames.get(code.trim().toUpperCase()) ?? WEEKLY_SCOPE_REGION_FALLBACK;
}
