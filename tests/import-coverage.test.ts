import assert from "node:assert/strict";

import { aggregatePersistentUnmapped, type CoverageSnapshot, type NewCustomerDetail } from "../src/lib/sales/import-coverage.ts";

// Minimal snapshot builder — only the fields the aggregator reads matter.
function snap(
  committedAt: string,
  distributorCode: string,
  details: NewCustomerDetail[],
  codes: string[] = [],
): CoverageSnapshot {
  return {
    batchId: "b", brickDriftCount: 0, committedAt, distinctCustomers: 0, distributorCode,
    id: committedAt, importableRows: 0, importableValue: 0, mappedCustomers: 0,
    newCustomerCodes: codes, newCustomerDetails: details, newCustomers: 0, period: null,
    resolvedPct: 0, totalRows: 0, unmappedProducts: [], unmappedProductsCount: 0,
  };
}

export function runImportCoverageTests() {
  // 1) A customer unmapped in 3 snapshots → surfaced with importCount 3; <3 is excluded.
  {
    const d = (code: string, name: string): NewCustomerDetail => ({ address: "12 St", code, name });
    const out = aggregatePersistentUnmapped([
      snap("2026-06-18", "PS", [d("C1", "Ezaby"), d("C2", "Seif")]),
      snap("2026-06-17", "PS", [d("C1", "Ezaby")]),
      snap("2026-06-16", "PS", [d("C1", "Ezaby")]),
    ]);
    assert.equal(out.length, 1, "only C1 hit 3 imports");
    assert.equal(out[0].customerCode, "C1");
    assert.equal(out[0].importCount, 3);
    assert.equal(out[0].customerName, "Ezaby");
    assert.equal(out[0].distributorCode, "PS");
  }

  // 2) Counted once per snapshot even if a code repeats within one snapshot.
  {
    const d = (code: string): NewCustomerDetail => ({ address: "", code, name: "X" });
    const out = aggregatePersistentUnmapped([
      snap("2026-06-18", "PS", [d("C1"), d("C1"), d("C1")]), // 3 rows, ONE snapshot
    ]);
    assert.equal(out.length, 0, "one snapshot ≠ 3 imports");
  }

  // 3) Old snapshots (codes only, no details) still count; name stays blank.
  {
    const out = aggregatePersistentUnmapped([
      snap("2026-06-18", "IS", [], ["C9"]),
      snap("2026-06-17", "IS", [], ["C9"]),
      snap("2026-06-16", "IS", [], ["C9"]),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].importCount, 3);
    assert.equal(out[0].customerName, "", "no name captured for code-only snapshots");
  }

  // 4) The newest snapshot's name/address wins (snapshots passed newest-first).
  {
    const out = aggregatePersistentUnmapped([
      snap("2026-06-18", "PS", [{ address: "New Addr", code: "C1", name: "New Name" }]),
      snap("2026-06-17", "PS", [{ address: "Old Addr", code: "C1", name: "Old Name" }]),
      snap("2026-06-16", "PS", [{ address: "", code: "C1", name: "" }]),
    ]);
    assert.equal(out[0].customerName, "New Name", "most-recent name kept");
    assert.equal(out[0].address, "New Addr");
  }

  // 5) Same code under different distributors → distinct customers (keyed by distributor+code).
  {
    const d = (code: string): NewCustomerDetail => ({ address: "", code, name: "N" });
    const out = aggregatePersistentUnmapped([
      snap("2026-06-18", "PS", [d("C1")]), snap("2026-06-17", "PS", [d("C1")]), snap("2026-06-16", "PS", [d("C1")]),
      snap("2026-06-18b", "IS", [d("C1")]), snap("2026-06-17b", "IS", [d("C1")]), snap("2026-06-16b", "IS", [d("C1")]),
    ]);
    assert.equal(out.length, 2, "PS/C1 and IS/C1 are separate");
    assert.deepEqual(out.map((r) => r.distributorCode).sort(), ["IS", "PS"]);
  }
}
