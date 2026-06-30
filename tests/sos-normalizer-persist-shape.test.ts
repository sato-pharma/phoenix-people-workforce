import assert from "node:assert/strict";

import { buildNormalizedImportRows, buildNormalizedSummaryRows } from "../src/lib/sales/normalizer/service.ts";
import type { CodedRow } from "../src/lib/sales/normalizer/types.ts";

// The exact column set of public.source_of_sales_import_rows after every migration that touches it:
//   20260525221715_source_of_sales_foundation        — base columns
//   20260529150722_source_of_sales_reference_hierarchy — area_code, area_name, block_code, brick_id
//   20260603175151_monthly_closing_value_recompute    — discount
//   20260603213432_customer_directory                 — client_code, client_name, client_address
//   20260604101304_direct_channel                     — is_direct
// Note: there is NO block_name and NO brick_name column on this table (brick_name lives on
// source_of_sales_bricks). The persisted insert object must stay a subset of this set, otherwise
// PostgREST rejects (or silently drops) the whole "Import (validated)" batch.
const VALID_IMPORT_ROW_COLUMNS = new Set([
  "batch_id",
  "row_number",
  "distributor_code",
  "invoice_period",
  "region_name",
  "region_code",
  "product_name",
  "product_code",
  "official_line",
  "qty",
  "bonus_qty",
  "value",
  "validation_state",
  "validation_issues",
  "raw_row",
  "area_code",
  "area_name",
  "block_code",
  "brick_id",
  "discount",
  "client_code",
  "client_name",
  "client_address",
  "is_direct",
]);

function codedRow(overrides: Partial<CodedRow> = {}): CodedRow {
  return {
    areaCode: "A1",
    areaName: "Area One",
    brickId: "B1",
    brickName: "Brick One",
    bonusQty: 1,
    clientCode: "C123",
    clientName: "Pharmacy X",
    clientAddress: "10 Nile St",
    discount: 0.1,
    distributorCode: "IS",
    invoiceDate: "2026-04",
    invoiceNumber: null,
    isDirect: false,
    officialLine: "CNS",
    productCode: "LA001",
    productName: "Lacto 1",
    qty: 6,
    rawRowNumber: 2,
    regionCode: "CA",
    regionName: "Cairo",
    value: 60,
    ...overrides,
  };
}

export async function runSosNormalizerPersistShapeTests() {
  const rows = [codedRow(), codedRow({ brickId: "B2", productCode: "TE002", qty: 3, value: 30 })];
  const inserts = buildNormalizedImportRows(rows, "batch-1");

  assert.equal(inserts.length, 2);

  for (const insert of inserts) {
    const keys = Object.keys(insert);

    // The original bug: these phantom columns do not exist on source_of_sales_import_rows.
    assert.ok(!("block_name" in insert), "insert must NOT include block_name (no such column)");
    assert.ok(!("brick_name" in insert), "insert must NOT include brick_name (no such column)");

    // Future-proofing: every emitted key must be a real column. This catches any new key that
    // drifts ahead of a migration, the same way block_name/brick_name did.
    for (const key of keys) {
      assert.ok(
        VALID_IMPORT_ROW_COLUMNS.has(key),
        `insert key "${key}" is not a known source_of_sales_import_rows column`,
      );
    }
  }

  // Core mappings still hold: brick is stored by id only, block_code is the empty placeholder
  // (matching insertSourceOfSalesRows), batch + row_number wiring is correct, and qty/value carry.
  const [first, second] = inserts;
  assert.equal(first!.batch_id, "batch-1");
  assert.equal(first!.brick_id, "B1");
  assert.equal(first!.block_code, "");
  assert.equal(first!.row_number, 1);
  assert.equal(first!.area_code, "A1");
  assert.equal(first!.region_code, "CA");
  assert.equal(first!.client_code, "C123");
  assert.equal(first!.discount, 0.1);
  assert.equal(first!.is_direct, false);
  assert.equal(second!.brick_id, "B2");
  assert.equal(second!.row_number, 2);
  assert.equal(second!.value, 30);

  // Non-finite numerics fall back to 0 (never NaN, which would break the numeric columns).
  const [naNsafe] = buildNormalizedImportRows([codedRow({ qty: Number.NaN, value: Number.NaN, discount: Number.NaN, bonusQty: Number.NaN })], "batch-2");
  assert.equal(naNsafe!.qty, 0);
  assert.equal(naNsafe!.value, 0);
  assert.equal(naNsafe!.discount, 0);
  assert.equal(naNsafe!.bonus_qty, 0);

  const summaries = buildNormalizedSummaryRows(rows, "batch-1");
  const byKey = new Map(summaries.map((row) => [`${row.group_type}:${row.group_key}`, row]));

  assert.equal(byKey.get("line:CNS")?.row_count, 2, "line summary aggregates rows by official line");
  assert.equal(byKey.get("region:CA|Cairo")?.row_count, 2, "region summary aggregates rows by region code/name");
  assert.equal(byKey.get("area:A1|Area One|CA")?.total_qty, 9, "area summary totals quantity");
  assert.equal(byKey.get("product:LA001|Lacto 1|CNS")?.total_value, 60, "product summary totals value");
  assert.equal(byKey.get("brick:B1|Brick One|A1|CA")?.row_count, 1, "brick summary keys by brick id/name/area/region");

  const directSummaries = buildNormalizedSummaryRows([codedRow({ areaCode: "DIRECT", brickId: "", brickName: "", isDirect: true })], "batch-direct");
  assert.equal(directSummaries.some((row) => row.group_type === "area"), false, "direct rows do not create geography area summaries");
  assert.equal(directSummaries.some((row) => row.group_type === "brick"), false, "direct rows do not create geography brick summaries");
  assert.equal(directSummaries.some((row) => row.group_type === "product"), true, "direct rows still create product summaries");
}
