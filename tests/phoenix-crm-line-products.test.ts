import assert from "node:assert/strict";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/confidential-products.ts";
import { groupLineProducts, type LineProductFamily } from "../src/lib/phoenix-crm/server/products.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — the products of a line, grouped by family for the pharmacy-stock check.
//
// Owner, 2026-09-24: "show products by families and expandable and collapsable by conc in Does this
// pharmacy have these products?" A pharmacy can carry one concentration of a family and not another,
// so the stock check is answered per PRODUCT (concentration), the products grouped under their family
// so each family can expand to reveal them. groupLineProducts is the pure core of loadProductsByLine
// (the database read only pages the rows and calls it), so the grouping is pinned here without a
// database:
//
//   1. products are grouped by family, within a normalized line key;
//   2. a confidential product code is never offered;
//   3. a product with no name falls back to its family name, so a single-product family still answers;
//   4. duplicates collapse, and both families and their products come out sorted by name.
// ─────────────────────────────────────────────────────────────────────────────

function row(over: Record<string, unknown>): Record<string, unknown> {
  return { product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin", line: "CNS", ...over };
}

function familyNames(grouped: Record<string, LineProductFamily[]>, line: string): string[] {
  return (grouped[line] ?? []).map((entry) => entry.family);
}

function productsOf(grouped: Record<string, LineProductFamily[]>, line: string, family: string): string[] {
  return (grouped[line] ?? []).find((entry) => entry.family === family)?.products ?? [];
}

export function runPhoenixCrmLineProductsTests() {
  // ── 1 + 4: products group under their family; families and products are sorted ─
  {
    const grouped = groupLineProducts([
      row({ product_code: "PX-2", product_name: "Tebofortin 80mg", family: "Tebofortin" }),
      row({ product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin" }),
      row({ product_code: "PX-3", product_name: "Depakine 500mg", family: "Depakine" }),
    ]);
    assert.deepEqual(familyNames(grouped, "cns"), ["Depakine", "Tebofortin"], "families come out sorted by name");
    assert.deepEqual(
      productsOf(grouped, "cns", "Tebofortin"),
      ["Tebofortin 40mg", "Tebofortin 80mg"],
      "a family's concentrations are grouped under it and sorted by name",
    );
  }

  // ── the line key is normalized, so two spellings of one line land together ─────
  {
    const grouped = groupLineProducts([
      row({ product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin", line: "CNS" }),
      row({ product_code: "PX-2", product_name: "Tebofortin 80mg", family: "Tebofortin", line: "  cns  " }),
    ]);
    assert.deepEqual(Object.keys(grouped), ["cns"], "two spellings of one line normalize to a single key");
    assert.deepEqual(productsOf(grouped, "cns", "Tebofortin"), ["Tebofortin 40mg", "Tebofortin 80mg"]);
  }

  // ── 2: a confidential product code is never offered ───────────────────────────
  {
    const restricted = RESTRICTED_PRODUCT_CODES[0];
    assert.ok(restricted, "there is at least one confidential product code to exercise the filter");
    const grouped = groupLineProducts([
      row({ product_code: restricted, product_name: "Secret 10mg", family: "Secret" }),
      row({ product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin" }),
    ]);
    assert.deepEqual(familyNames(grouped, "cns"), ["Tebofortin"], "the confidential family is dropped entirely");
  }

  // ── 3: a product with no name falls back to its family name ───────────────────
  {
    const grouped = groupLineProducts([row({ product_code: "PX-9", product_name: "   ", family: "Congestal" })]);
    assert.deepEqual(productsOf(grouped, "cns", "Congestal"), ["Congestal"], "an unnamed product answers under its family name");
  }

  // ── 4: duplicate rows collapse to one product ─────────────────────────────────
  {
    const grouped = groupLineProducts([
      row({ product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin" }),
      row({ product_code: "PX-1b", product_name: "Tebofortin 40mg", family: "Tebofortin" }),
    ]);
    assert.deepEqual(productsOf(grouped, "cns", "Tebofortin"), ["Tebofortin 40mg"], "the same concentration is listed once");
  }

  // ── rows missing a code, family or line are ignored, not grouped under "" ──────
  {
    const grouped = groupLineProducts([
      row({ product_code: "", product_name: "No code", family: "Ghost" }),
      row({ product_code: "PX-4", product_name: "No family", family: "  " }),
      row({ product_code: "PX-5", product_name: "No line", family: "Orphan", line: "" }),
      row({ product_code: "PX-1", product_name: "Tebofortin 40mg", family: "Tebofortin" }),
    ]);
    assert.deepEqual(Object.keys(grouped), ["cns"], "only the well-formed row survives");
    assert.deepEqual(familyNames(grouped, "cns"), ["Tebofortin"]);
  }
}
