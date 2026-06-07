import assert from "node:assert/strict";

import { NORMALIZER_TEMPLATE } from "../src/lib/sales/monthly-distributor-import.ts";
import { HEADER_GRID_COLUMNS, profilesToHeaderGrid } from "../src/lib/sales/normalizer/profile-grid.ts";
import { RAW_DISTRIBUTOR_PROFILES } from "../src/lib/sales/normalizer/profiles.ts";
import { CODED_HEADERS } from "../src/lib/sales/normalizer/service.ts";

// The Normalizer emits ONE coded format (CODED_HEADERS). For a coded sheet to PASS the Source-of-Sales
// validator under NORMALIZER_TEMPLATE, every header the template needs must exist in that coded format.
// This guards the core "coded sheets pass validation" property without touching the database.
export function runSosImportTemplateTests() {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const coded = new Set(CODED_HEADERS.map(norm));

  // every REQUIRED field must have at least one accepted header alias that the coded sheet emits.
  // (findHeaderMap resolves each field to whichever alias is present; the coded format uses the canonical
  // name, but hybrid sheets may use distributor-raw aliases like QTY_INVOICE / INVOICE_DATE / Brick ID2.)
  for (const spec of Object.values(NORMALIZER_TEMPLATE.fields)) {
    const aliases = Array.isArray(spec) ? spec : [spec];
    assert.ok(
      aliases.some((header) => coded.has(norm(header))),
      `NORMALIZER_TEMPLATE field [${aliases.join(", ")}] must include a CODED_HEADERS column`,
    );
  }
  // the bonus + discount columns the template reads are also emitted; discount drives the value recompute
  // (Qty x factory_price x (1 - Discount%)) that reproduces the engine's value exactly.
  assert.ok(NORMALIZER_TEMPLATE.bonusField && coded.has(norm(NORMALIZER_TEMPLATE.bonusField)), "bonusField must be a coded column");
  assert.ok(NORMALIZER_TEMPLATE.discountField && coded.has(norm(NORMALIZER_TEMPLATE.discountField)), "discountField (drives value recompute) must be a coded column");
  // optional product-name fallback(s) are present too
  for (const header of NORMALIZER_TEMPLATE.optionalFields?.productName ?? []) {
    assert.ok(coded.has(norm(header)), `optional productName "${header}" must be a coded column`);
  }
  // the normalizer template carries Area/Brick (not region-only) and RECOMPUTES value (no valueField),
  // so normalized distributor rows are NOT flagged is_direct.
  assert.equal(NORMALIZER_TEMPLATE.regionOnly ?? false, false);
  assert.equal(NORMALIZER_TEMPLATE.valueField, undefined);

  // ── Database Validation header grid (Phase 2 visibility) ──
  const grid = profilesToHeaderGrid(RAW_DISTRIBUTOR_PROFILES);
  assert.equal(grid.rows.length, RAW_DISTRIBUTOR_PROFILES.length, "one grid row per distributor profile");
  assert.deepEqual(grid.columns, HEADER_GRID_COLUMNS);
  const ps = grid.rows.find((r) => r.distributorCode === "PS");
  assert.ok(ps, "PS profile present in the grid");
  assert.equal(ps!.cells.distrub, "PS");
  assert.equal(ps!.cells.area, "auto (from Brick)"); // Area is derived from Brick, never mapped
  assert.equal(ps!.cells.region, "auto (from Brick)");
  assert.ok(ps!.cells.product !== "—" && ps!.cells.product.length > 0, "PS product cell is mapped");
  assert.ok(ps!.cells.qty !== "—" && ps!.cells.qty.length > 0, "PS qty cell is mapped");
}
