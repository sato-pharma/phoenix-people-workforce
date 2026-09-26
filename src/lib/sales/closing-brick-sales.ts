// ─────────────────────────────────────────────────────────────────────────────
// The closing's BRICK grain, and the brick master that names it.
//
// Both loaders were written for Employee 360's brick panel (src/lib/employee-360/brick-coverage.ts)
// and lifted here VERBATIM on 2026-09-27 for C2 of the Phoenix CRM plan, which needs the same two
// reads to put a rep's coverage of a brick beside what that brick actually sold. Nothing about them
// changed in the move: same queries, same chunking, same shapes. Employee 360 imports them from here
// and its own tests still pass unedited, which is the point of doing the extraction on its own.
//
// 🔴 **BRICKS DO NOT ADD UP TO THE AREA'S CLOSING FIGURE, AND EVERY CALLER MUST SAY SO.** The closing
// credits an area with money no brick holds — a wholesaler's sales split across its city's areas, El
// Qema's warehouse stock spread over the country, the Office allocation, and direct orders, which
// `phx_closing_brick` excludes outright. A brick's figure is what distributors booked ON it. A screen
// that prints these numbers under a heading implying they sum to the area is wrong. The wording is a
// shared constant, `BRICK_SALES_CAVEAT` — kept in `@/lib/phoenix-crm/brick-report`, a PURE module,
// because this file reaches the database and must never be pulled into a phone bundle behind it.
//
// 🔴 **EL QEMA LEAVES NO TRACE, and that masking is the CALLER's to apply.** These loaders return the
// raw rows; `withoutMaskedSourceRows` (src/lib/sales/closing-source-mask.ts) must be run over them
// before anything is summed or rendered for anyone but the Super Admin, or a warehouse brick carrying
// El Qema's stock announces it. Employee 360 does this; so does the Phoenix CRM report.
// ─────────────────────────────────────────────────────────────────────────────

import { cairoTodayIso } from "@/lib/crm/dates";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

export type BrickMasterRow = { brickId: string; brickName: string; areaCode: string; current: boolean };
export type BrickSalesRow = { distributorCode: string; areaCode: string; brickId: string; value: number };

export const upperCode = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/** Every brick of these areas, whatever its state, so a brick that sold before it was ended still names itself. */
export async function loadAreaBrickMaster(
  areaCodes: readonly string[],
  extraBrickIds: readonly string[],
): Promise<BrickMasterRow[]> {
  const supabase = getSupabaseAdmin();
  const today = cairoTodayIso();
  const toRow = (row: {
    active: boolean | null;
    area_code: string | null;
    brick_id: string | null;
    brick_name: string | null;
    effective_to: string | null;
  }): BrickMasterRow | null =>
    row.brick_id
      ? {
          brickId: row.brick_id,
          brickName: (row.brick_name ?? "").trim(),
          areaCode: upperCode(row.area_code),
          current: row.active !== false && (!row.effective_to || row.effective_to >= today),
        }
      : null;

  const out = new Map<string, BrickMasterRow>();
  const { data, error } = await supabase
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name, area_code, active, effective_to")
    .in("area_code", [...areaCodes]);
  if (error) throw new Error(error.message);
  for (const raw of data ?? []) {
    const row = toRow(raw as Parameters<typeof toRow>[0]);
    if (row && !out.has(row.brickId)) out.set(row.brickId, row);
  }

  // A brick the closing booked to one of these areas while its master row sits elsewhere (a
  // hand-split customer) still needs its name. Chunked: PostgREST zeroes a long `.in()` silently.
  const missing = extraBrickIds.filter((id) => id && !out.has(id));
  for (let from = 0; from < missing.length; from += 50) {
    const { data: extra, error: extraError } = await supabase
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name, area_code, active, effective_to")
      .in("brick_id", missing.slice(from, from + 50));
    if (extraError) throw new Error(extraError.message);
    for (const raw of extra ?? []) {
      const row = toRow(raw as Parameters<typeof toRow>[0]);
      if (row && !out.has(row.brickId)) out.set(row.brickId, row);
    }
  }
  return [...out.values()];
}

/** The closing's brick grain for one line and month. */
export async function loadClosingBrickSales(line: string, period: string): Promise<BrickSalesRow[]> {
  const rows = await rpcAll<Record<string, unknown>>(
    getSupabaseAdmin(),
    "phx_closing_brick",
    { p_line: line, p_period: period },
    ["distributor_code", "region_code", "area_code", "brick_id"],
  );
  return rows.map((row) => ({
    distributorCode: String(row.distributor_code ?? ""),
    areaCode: String(row.area_code ?? ""),
    brickId: String(row.brick_id ?? ""),
    value: Number(row.value ?? 0) || 0,
  }));
}
