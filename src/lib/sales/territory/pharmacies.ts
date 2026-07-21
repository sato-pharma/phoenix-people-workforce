import { normalizeLineKey } from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { isReconciled } from "./reconciliation";
import type { TerritoryAreaPayload, TerritoryPharmacy } from "./types";

type RawPharmacyRow = {
  brick_id: string;
  client_code: string;
  client_name: string;
  official_line: string;
  product_code: string;
  product_name: string;
  period: string;
  units: number | string | null;
  value: number | string | null;
  scope_total_units: number | string | null;
  scope_total_value: number | string | null;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Defense-in-depth re-check, mirroring applyLineRegionScope's shape (access-scope.ts) — the
 * SQL side (phx_territory_area_pharmacies) already filters by official_line before returning
 * a single row, so this should normally be a no-op. It exists as the explicit guard point a
 * future RPC edit can't silently bypass: if a row's line doesn't match, it's dropped here,
 * never rendered. Pure — unit-tested directly.
 */
export function applyPharmacyLineScope(rows: RawPharmacyRow[], officialLine: string): RawPharmacyRow[] {
  const key = normalizeLineKey(officialLine);
  return rows.filter((row) => normalizeLineKey(row.official_line) === key);
}

/**
 * Fetch one area's full brick -> pharmacy -> month breakdown, already line-scoped server-side
 * and re-verified client-side. `periods` should be every period in the requested window (e.g.
 * the last 6 months) so a pharmacy's monthly presence can be computed even for months it had
 * zero sales, not just the months it happens to have a row for.
 *
 * `officialLine` must already be resolved (from resolveTerritoryRootScope) — this function
 * refuses to call the RPC at all when it's missing, rather than widening to "all lines".
 */
export async function fetchTerritoryAreaPharmacies(
  areaCode: string,
  periods: string[],
  officialLine: string | null,
): Promise<TerritoryAreaPayload> {
  if (!officialLine) {
    return { areaCode, bricks: [], reconciled: true, totalUnits: 0, totalValue: 0 };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_territory_area_pharmacies", {
    p_area_codes: [areaCode],
    p_periods: periods,
    p_lines: [officialLine],
  });
  if (error) throw error;

  const rawRows = (data ?? []) as RawPharmacyRow[];
  const rows = applyPharmacyLineScope(rawRows, officialLine);
  if (rows.length === 0) {
    return { areaCode, bricks: [], reconciled: true, totalUnits: 0, totalValue: 0 };
  }

  const scopeTotal = {
    units: toNumber(rows[0].scope_total_units),
    value: toNumber(rows[0].scope_total_value),
  };

  const pharmaciesByBrick = new Map<string, Map<string, TerritoryPharmacy>>();
  for (const row of rows) {
    const brickId = row.brick_id;
    const clientCode = row.client_code;
    if (!pharmaciesByBrick.has(brickId)) pharmaciesByBrick.set(brickId, new Map());
    const byClient = pharmaciesByBrick.get(brickId)!;
    if (!byClient.has(clientCode)) {
      byClient.set(clientCode, {
        clientCode,
        clientName: row.client_name || "Unknown",
        brickId,
        totalUnits: 0,
        totalValue: 0,
        months: periods.map((period) => ({ period, hasSales: false, units: 0, products: [] })),
      });
    }
    const pharmacy = byClient.get(clientCode)!;
    const units = toNumber(row.units);
    const value = toNumber(row.value);
    pharmacy.totalUnits += units;
    pharmacy.totalValue += value;
    const monthEntry = pharmacy.months.find((month) => month.period === row.period);
    if (monthEntry) {
      // Unconditional — must stay equal to the sum feeding pharmacy.totalUnits/totalValue
      // above (a credit-note row can be negative; it still has to net into the month).
      monthEntry.units += units;
      monthEntry.hasSales = monthEntry.hasSales || units > 0;
      // The product breakdown (trend tooltip) only lists genuine positive sales lines —
      // a negative/zero adjustment row would read as a confusing "Product X: -3 units".
      if (row.product_code && units > 0) {
        monthEntry.products.push({
          productCode: row.product_code,
          productName: row.product_name || "Unknown product",
          units,
          value,
        });
      }
    }
  }
  // Highest-selling product first within each month, so the trend tooltip reads ranked.
  for (const byClient of pharmaciesByBrick.values()) {
    for (const pharmacy of byClient.values()) {
      for (const month of pharmacy.months) {
        month.products.sort((a, b) => b.units - a.units);
      }
    }
  }

  let computedUnits = 0;
  let computedValue = 0;
  const bricks = [...pharmaciesByBrick.entries()].map(([brickId, byClient]) => {
    const pharmacies = [...byClient.values()].sort((a, b) => b.totalValue - a.totalValue);
    for (const pharmacy of pharmacies) {
      computedUnits += pharmacy.totalUnits;
      computedValue += pharmacy.totalValue;
    }
    return { brickId, pharmacies };
  });

  return {
    areaCode,
    bricks,
    reconciled: isReconciled({ units: computedUnits, value: computedValue }, scopeTotal),
    totalUnits: computedUnits,
    totalValue: computedValue,
  };
}
