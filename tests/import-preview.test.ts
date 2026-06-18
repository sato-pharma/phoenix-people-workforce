import assert from "node:assert/strict";

import {
  buildImportPreviewDiff,
  customerMapKey,
  type ImportPreviewIssue,
  type ImportPreviewRow,
} from "../src/lib/sales/import-preview.ts";

const DIST = "SF-T";

function mapOf(entries: [string, string][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [code, brick] of entries) map.set(customerMapKey(DIST, code), brick);
  return map;
}

export function runImportPreviewTests() {
  // 1) New vs mapped customers — coded rows whose customer is/ isn't in the stored map.
  {
    const rows: ImportPreviewRow[] = [
      { brickId: "B1", clientCode: "C100", value: 100 },
      { brickId: "B1", clientCode: "C100", value: 50 }, // same customer, second invoice line
      { brickId: "B2", clientCode: "C200", value: 200 },
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: mapOf([["C100", "B1"]]),
      importableRows: 3,
      issues: [],
      rows,
      totalRows: 3,
    });
    assert.equal(diff.distinctCustomers, 2, "two distinct customers");
    assert.equal(diff.mappedCustomers, 1, "C100 is mapped");
    assert.equal(diff.newCustomers, 1, "C200 is new");
    assert.deepEqual(diff.newCustomerCodes, ["C200"], "new customer surfaced");
    assert.equal(diff.importableValue, 350, "importable value summed");
    assert.equal(diff.resolvedRowsPct, 100, "all rows resolved");
  }

  // 2) Brick drift — resolved brick differs from the stored mapping (counted once per customer).
  {
    const rows: ImportPreviewRow[] = [
      { brickId: "B9", clientCode: "C100", value: 10 },
      { brickId: "B9", clientCode: "C100", value: 10 },
      { brickId: "B2", clientCode: "C200", value: 10 }, // matches map → no drift
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: mapOf([["C100", "B1"], ["C200", "B2"]]),
      importableRows: 3,
      issues: [],
      rows,
      totalRows: 3,
    });
    assert.equal(diff.brickDriftCount, 1, "one customer drifted");
    assert.deepEqual(diff.brickDriftSamples, [{ customerCode: "C100", mappedBrickId: "B1", resolvedBrickId: "B9" }]);
    assert.equal(diff.newCustomers, 0, "both customers are mapped");
  }

  // 3) Resolved %/value math with a partially-blocked file.
  {
    const rows: ImportPreviewRow[] = [
      { brickId: "B1", clientCode: "C1", value: 80 },
      { brickId: "B1", clientCode: "C2", value: 20 },
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: mapOf([["C1", "B1"], ["C2", "B1"]]),
      importableRows: 2,
      issues: [],
      rows,
      totalRows: 8, // 6 rows could not be coded
    });
    assert.equal(diff.resolvedRowsPct, 25, "2/8 = 25%");
    assert.equal(diff.importableValue, 100);
  }

  // 4) Empty stored map — every customer is new.
  {
    const rows: ImportPreviewRow[] = [
      { brickId: "", clientCode: "C1", value: 0 },
      { brickId: "", clientCode: "C2", value: 0 },
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: new Map(),
      importableRows: 0,
      issues: [],
      rows,
      totalRows: 2,
    });
    assert.equal(diff.newCustomers, 2, "all customers new");
    assert.equal(diff.mappedCustomers, 0);
    assert.equal(diff.brickDriftCount, 0, "no drift without a stored map");
    assert.equal(diff.resolvedRowsPct, 0);
  }

  // 5) Unmapped products + blocked-path customers come from issues (no coded rows for them).
  {
    const issues: ImportPreviewIssue[] = [
      { field: "Product", value: "WONDERPILL 500" },
      { field: "Product", value: "WONDERPILL 500" }, // duplicate label
      { field: "Territory", value: "C900" }, // unmapped customer (brick-reason)
      { field: "Product & Territory", value: "BOTH" },
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: mapOf([["C1", "B1"]]),
      importableRows: 1,
      issues,
      rows: [{ brickId: "B1", clientCode: "C1", value: 5 }],
      totalRows: 4,
    });
    assert.equal(diff.unmappedProductsCount, 2, "WONDERPILL + BOTH, deduped");
    assert.ok(diff.unmappedProducts.includes("WONDERPILL 500"));
    // C900 (from a Territory issue) is a customer in the file and not mapped → counts as new.
    assert.equal(diff.newCustomers, 1, "C900 is a new (unmapped) customer");
    assert.equal(diff.mappedCustomers, 1, "C1 is mapped");
  }

  // 6) Customer keys normalize (case/spacing) so the same customer never double-counts.
  {
    const rows: ImportPreviewRow[] = [
      { brickId: "B1", clientCode: " c1 ", value: 10 },
      { brickId: "B1", clientCode: "C1", value: 10 },
    ];
    const diff = buildImportPreviewDiff({
      distributorCode: DIST,
      existingBrickByKey: mapOf([["C1", "B1"]]),
      importableRows: 2,
      issues: [],
      rows,
      totalRows: 2,
    });
    assert.equal(diff.distinctCustomers, 1, "' c1 ' and 'C1' are the same customer");
    assert.equal(diff.mappedCustomers, 1);
    assert.equal(diff.newCustomers, 0);
  }
}
