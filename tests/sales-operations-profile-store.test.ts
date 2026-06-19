import assert from "node:assert/strict";

import { getDistributorTemplate } from "../src/lib/sales-operations/dictionary.ts";
import { rowToTemplate, templateToRow } from "../src/lib/sales-operations/profile-store.ts";

export async function runSalesOperationsProfileStoreTests() {
  // ── round-trip: code template → DB row → template preserves the editable mapping ──────────────
  const ps = getDistributorTemplate("PS")!;
  const psRow = templateToRow(ps);
  assert.deepEqual(psRow.product_name_columns, ["Mat. Desc."]);
  assert.deepEqual(psRow.product_code_columns, ["Mat. Code"]);
  assert.deepEqual(psRow.customer_code_columns, ["Customer"]);
  assert.equal(psRow.brick_lookup, "customer-code");

  const psBack = rowToTemplate(psRow, ps);
  assert.deepEqual(psBack.productNameHeaders, ["Mat. Desc."], "headers survive the round-trip");
  assert.deepEqual(psBack.customerCodeHeaders, ["Customer"]);
  assert.equal(psBack.name, "Overseas", "name merged from the code template (not stored in the row)");
  assert.deepEqual(psBack.fingerprintHeaders, ps.fingerprintHeaders, "fingerprint stays code-defined");
  assert.equal(psBack.hasDateColumn, true, "hasDateColumn derived from date_columns");
  assert.equal(psBack.brickLookup, "customer-code");

  // ── CP: brick-name strategy, region-only, date-less ──────────────────────────────────────────
  const cp = getDistributorTemplate("CP")!;
  const cpBack = rowToTemplate(templateToRow(cp), cp);
  assert.equal(cpBack.brickLookup, "brick-name");
  assert.deepEqual(cpBack.brickNameHeaders, ["Area name A"]);
  assert.equal(cpBack.regionOnly, true, "region-only override threads through");
  assert.equal(cpBack.hasDateColumn, false, "no date column → period from the picker");

  // ── EG-BR: the code-defined hard blank-customer rule is preserved (not stored in the row) ─────
  const egbr = getDistributorTemplate("EG-BR")!;
  const egbrBack = rowToTemplate(templateToRow(egbr), egbr);
  assert.equal(egbrBack.blankCustomerBehavior, "error", "blankCustomerBehavior stays code-defined");

  // ── an override that edits a single field; empty arrays collapse to undefined ─────────────────
  const override = rowToTemplate(
    {
      distributor_code: "PS",
      brick_lookup: "customer-code",
      customer_code_columns: ["Customer", "Sold-To"], // admin added a fallback column (multi-column)
      customer_name_columns: [],
      customer_address_columns: null,
      brick_name_columns: null,
      product_name_columns: ["Mat. Desc."],
      product_code_columns: ["Mat. Code"],
      qty_columns: ["Qty"],
      date_columns: ["Invoice Date"],
      bonus_columns: null,
      region_only: false,
      date_format: "day-first",
    },
    ps,
  );
  assert.deepEqual(override.customerCodeHeaders, ["Customer", "Sold-To"], "multi-column per field is first-class");
  assert.equal(override.customerNameHeaders, undefined, "empty array → undefined (field simply absent)");
}
