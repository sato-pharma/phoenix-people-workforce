/**
 * READ-ONLY verification of the seat-derived DM/RM area scope against live data.
 *
 * Asserts, for the real production org structure, that a District Manager whose district contains an
 * out-of-region area (Saad Salama / B-119, whose CNS Alex-BHR district owns D16 "Kafr El-Sheikh 1" —
 * geographically Delta (1)) now resolves that area, and that the sibling DM's other Delta (1) areas
 * stay out. Issues only SELECTs. Run with:
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *        --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *        scripts/verify-dm-area-scope.ts
 */
import assert from "node:assert/strict";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { resolveSeatAreaScope } from "@/lib/sales/seat-area-scope";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

function ctxFor(hrId: string, role: AccessContext["role"], scope: AccessContext["scope"]): AccessContext {
  return { hrId, loginId: hrId, role, scope, source: "session" } as AccessContext;
}

const sorted = (set: Set<string> | null | undefined) => [...(set ?? [])].sort();

async function main() {
  const supabase = getSupabaseAdmin();

  // Ground truth straight from the seat map, independent of the new resolver.
  const { data: seatRows, error: seatError } = await supabase
    .from("au_v_line_area_map")
    .select("area_code,operational_region_code,dm_seat_id,line_code")
    .eq("dm_seat_id", "SEAT-CNS-DM-AB");
  if (seatError) throw seatError;
  const expectedAreas = sorted(new Set((seatRows ?? []).map((r) => String(r.area_code).toUpperCase())));
  console.log("seat map says SEAT-CNS-DM-AB owns:", expectedAreas.join(", "));

  // 1. The resolver itself.
  const saadCtx = ctxFor("B-119", "District Manager", "team");
  const seatScope = await resolveSeatAreaScope(saadCtx);
  assert.ok(seatScope, "B-119 must resolve a seat area scope");
  assert.deepEqual(sorted(seatScope!.areaCodes), expectedAreas, "resolver matches the seat map exactly");
  assert.ok(seatScope!.areaCodes.has("D16"), "the out-of-region Kafr El-Sheikh 1 (D16) IS in scope");
  assert.equal(seatScope!.areaCodes.has("D11"), false, "the sibling DM's Qalubeya (D11) is NOT in scope");
  assert.equal(seatScope!.areaCodes.has("D17"), false, "the sibling DM's Kafr El-Sheikh 2 (D17) is NOT in scope");
  assert.deepEqual(sorted(seatScope!.factRegionCodes), ["AB", "D1"], "fact regions span AB + D1");
  console.log("PASS  resolveSeatAreaScope(B-119) =", sorted(seatScope!.areaCodes).join(", "));
  console.log("      fact regions =", sorted(seatScope!.factRegionCodes).join(", "));

  // 2. The full sales access scope a page would get.
  const salesScope = await resolveSalesAccessScope(saadCtx);
  assert.deepEqual(sorted(salesScope.allowedAreaCodes), expectedAreas, "sales scope carries the seat areas");
  assert.deepEqual(sorted(salesScope.allowedAreaFactRegionCodes), ["AB", "D1"], "sales scope carries the fact regions");
  console.log("PASS  resolveSalesAccessScope(B-119).allowedAreaCodes =", sorted(salesScope.allowedAreaCodes).join(", "));

  // 3. How much sales data this actually unhides, from the live rollup.
  // Paged: the rollup holds far more than 1,000 rows for one area, and a cut read would under-count what this unhides.
  const factRows = await fetchAllRows<{ area_code: string | null; effective_units: number | string | null }>(
    () =>
      supabase
        .from("source_of_sales_fact_rollup")
        .select("area_code,effective_units")
        .eq("official_line", "CNS")
        .eq("area_code", "D16"),
    "id",
  );
  const units = factRows.reduce((sum, r) => sum + Number(r.effective_units ?? 0), 0);
  console.log(`PASS  D16 CNS rows now in his scope: ${factRows.length} rows, ${units.toFixed(0)} units`);
  assert.ok(factRows.length > 0, "there is real D16 CNS data to unhide");

  // 4. The Delta (1) DM must NOT gain Saad's areas — and, in the other direction, must LOSE the ones
  //    the old region-name bound wrongly gave him. Scoping him by region name "Delta (1)" handed him
  //    every D1x area, including Saad's D16 and D17 (which belongs to the CNS "Others" pseudo-DM seat).
  const siblingScope = await resolveSeatAreaScope(ctxFor("B-120", "District Manager", "team"));
  assert.ok(siblingScope, "B-120 must resolve a seat area scope too");
  assert.equal(siblingScope!.areaCodes.has("D16"), false, "the Delta (1) DM does NOT get D16 (it is Saad's)");
  assert.equal(siblingScope!.areaCodes.has("D17"), false, "nor D17, which sits under the CNS Others seat");
  assert.ok(siblingScope!.areaCodes.size > 0, "he keeps his own district's areas");
  console.log("PASS  sibling DM B-120 scope =", sorted(siblingScope!.areaCodes).join(", "));

  // 5. An NSM stays line-scoped (no area bound) — behaviour unchanged.
  const nsmScope = await resolveSalesAccessScope(ctxFor("B-122", "National Sales Manager", "line"));
  assert.equal(nsmScope.allowedAreaCodes, null, "NSM keeps nationwide-within-line scope");
  console.log("PASS  NSM B-122 has no area bound (unchanged)");

  console.log("\nAll live checks passed.");
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
