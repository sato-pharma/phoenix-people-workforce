// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — each brick's own months, per product (engine.ts rule 9).
//
// One read per closed month of public.phx_make_it_happen_brick_units: units per (line, area, rep,
// brick, product), from the same validated rollup, line map, area crosswalk and seat-occupant-as-of
// the Sales vs Target brick read uses. Direct orders (booked on no brick) and El Qema (QM, which leaves
// no trace for anyone but the Super Admin) are left out in the SQL itself, so no caller can forget to.
//
// The lines and areas passed narrow the read to the viewer's own territory; the EXACT bound is then
// applied here, the way Sales vs Target applies it to its brick drill-down, so a brick list can never
// out-reach the page it sits on.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalHrIdKey } from "@/lib/hr-id";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { filterBricksForBound } from "@/lib/sales/vs-target-scope";
import type { MakeItHappenBound } from "@/lib/sales/make-it-happen/scope";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export type BrickUnitsRow = {
  period: string;
  lineCode: string | null;
  areaCode: string | null;
  repHrId: string | null;
  dmHrId: string | null;
  brickId: string;
  brickName: string;
  productCode: string;
  units: number;
};

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/**
 * The lines and areas the viewer's scoped achievement rows touch — the read's narrowing, never its
 * bound. `scopedRaw` are the RAW rows (before the area merges) whose merged row is in scope, so a
 * merged-away area code still reaches the SQL. null for a company-wide viewer: read everything.
 */
export function brickReadNarrowing(
  scopedRaw: readonly AchievementRow[],
  companyWide: boolean,
): { lineCodes: string[] | null; areaCodes: string[] | null } {
  if (companyWide) return { lineCodes: null, areaCodes: null };
  const lines = new Set<string>();
  const areas = new Set<string>();
  for (const row of scopedRaw) {
    if (row.lineCode) lines.add(row.lineCode);
    if (row.areaCode) areas.add(row.areaCode.trim());
  }
  return { lineCodes: [...lines], areaCodes: [...areas] };
}

async function loadMonth(
  period: string,
  narrowing: { lineCodes: string[] | null; areaCodes: string[] | null },
): Promise<BrickUnitsRow[]> {
  const rows = await rpcAll<Record<string, unknown>>(
    getSupabaseAdmin(),
    "phx_make_it_happen_brick_units",
    { p_period: period, p_line_codes: narrowing.lineCodes, p_area_codes: narrowing.areaCodes },
    ["line_code", "area_code", "brick_id", "product_code"],
  );
  const out: BrickUnitsRow[] = [];
  for (const row of rows) {
    const brickId = text(row.brick_id);
    const productCode = text(row.product_code).toUpperCase();
    const units = Number(row.units ?? 0) || 0;
    if (!brickId || !productCode) continue;
    out.push({
      period: text(row.period) || period,
      lineCode: text(row.line_code) || null,
      areaCode: text(row.area_code) || null,
      repHrId: text(row.rep_hr_id) || null,
      dmHrId: text(row.dm_hr_id) || null,
      brickId,
      brickName: text(row.brick_name),
      productCode,
      units,
    });
  }
  return out;
}

/**
 * Every closed month's brick units in the viewer's bound, a rep picked by a manager narrowed to that
 * rep. Months run in parallel; an empty month list reads nothing.
 */
export async function loadBrickUnitsInBound(input: {
  months: readonly string[];
  bound: MakeItHappenBound;
  narrowing: { lineCodes: string[] | null; areaCodes: string[] | null };
  repKey: string | null;
}): Promise<BrickUnitsRow[]> {
  const { months, bound, narrowing, repKey } = input;
  if (months.length === 0 || bound.rows.kind === "none") return [];
  if (narrowing.lineCodes?.length === 0 || narrowing.areaCodes?.length === 0) return [];
  const loaded = (await Promise.all(months.map((month) => loadMonth(month, narrowing)))).flat();
  // The same order as the achievement rows: merges first, then the bound.
  let rows = filterBricksForBound(applyAchievementAreaMerges(loaded), bound.rows);
  const codes = bound.productCodes;
  if (codes) rows = rows.filter((row) => codes.has(row.productCode));
  if (repKey) rows = rows.filter((row) => canonicalHrIdKey(row.repHrId) === repKey);
  return rows;
}
