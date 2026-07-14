import assert from "node:assert/strict";

import { applyRestrictedProductFilter, type SalesRow } from "../src/lib/employee-360/deep-service.ts";

// Regression guard for the fix in PR #1061: Employee 360's Sales & Achievement
// section (topProducts/byFamily/totals) had no confidential-product masking at
// all. This locks the exact wiring applyRestrictedProductFilter contributes on
// top of the already-tested stripRestrictedRowsByName (see
// tests/sales-restricted-products.test.ts for the underlying strip logic):
// the right predicate (row.product), the right enabled condition
// (!canViewRestrictedProducts(viewerRole)), and applied BEFORE aggregation.

function row(overrides: Partial<SalesRow>): SalesRow {
  return {
    employee_hr_id: "B-74",
    line: "Pedia",
    family: "Lacto",
    product: "Lacto Advanced 1",
    month: 6,
    year: 2026,
    sales_value: 1000,
    target_value: 900,
    ...overrides,
  };
}

const restrictedNames = new Set(["lacto basic 1", "lacto basic 2", "satoslim"]);

export async function runEmployee360SalesMaskingTests() {
  const rows: SalesRow[] = [
    row({ product: "Lacto Advanced 1", sales_value: 100 }),
    row({ product: "Lacto Basic 1", sales_value: 999 }),
    row({ product: "Lacto Basic 2", sales_value: 888 }),
    row({ product: "Satoslim", sales_value: 777 }),
    row({ product: "Spasmo", sales_value: 50 }),
  ];

  // ── Non-privileged viewers lose every restricted-product row ──
  for (const role of ["District Manager", "Regional Manager", "Training Manager", "Employee", "Medical Rep"] as const) {
    const filtered = applyRestrictedProductFilter(rows, role, restrictedNames);
    assert.deepEqual(
      filtered.map((r) => r.product),
      ["Lacto Advanced 1", "Spasmo"],
      `${role} must not see restricted-product sales rows`,
    );
  }

  // ── CEO / Super Admin keep everything ──
  for (const role of ["CEO", "Super Admin"] as const) {
    const filtered = applyRestrictedProductFilter(rows, role, restrictedNames);
    assert.equal(filtered.length, rows.length, `${role} keeps every row`);
  }

  // ── Empty restricted-name set never strips (defensive — shouldn't normally happen since
  //    restrictedProductNameSet() always returns at least the hardcoded fallbacks) ──
  const noNames = applyRestrictedProductFilter(rows, "District Manager", new Set());
  assert.equal(noNames.length, rows.length, "an empty restricted-name set strips nothing");

  // ── A row with no product name passes through untouched, for both viewer classes ──
  const blankProduct = [row({ product: null })];
  assert.equal(
    applyRestrictedProductFilter(blankProduct, "District Manager", restrictedNames).length,
    1,
    "a row with no product name is never mistaken for a restricted product",
  );
}
