import assert from "node:assert/strict";

import { mergePharmacyCoverage } from "../src/lib/marketing-requests/coverage-report-service.ts";

export function runMarketingCoveragePharmacyMergeTests() {
  const targets = [
    { code: "PH-1", name: "Pharmacy One" },
    { code: "PH-2", name: "Pharmacy Two (no sales)" },
    { code: "PH-3", name: "Pharmacy Three" },
  ];

  // Only PH-1 and PH-3 have a sales aggregate; PH-2 has none.
  const byPharmacy = new Map([
    ["PH-1", { value: 1500, units: 10 }],
    ["PH-3", { value: 250.4, units: 2 }],
  ]);
  const distributorNameByCode = new Map([
    ["PH-1", "Ibnsina"],
    ["PH-2", "Ibnsina"],
    ["PH-3", null],
  ]);
  const parentDistributorCodeByCode = new Map([
    ["PH-1", "IS"],
    ["PH-2", "IS"],
    ["PH-3", null],
  ]);

  const rows = mergePharmacyCoverage(targets, byPharmacy, distributorNameByCode, parentDistributorCodeByCode);

  // ── Never omit: one row per target pharmacy, always — same count as the target list.
  assert.equal(rows.length, targets.length, "output length must equal the target-pharmacy count, never fewer");
  const byCode = new Map(rows.map((row) => [row.pharmacyCode, row] as const));
  assert.ok(byCode.has("PH-1"));
  assert.ok(byCode.has("PH-2"), "the zero-sales pharmacy must still be present");
  assert.ok(byCode.has("PH-3"));

  // ── The zero-sales pharmacy is explicit: value 0, units 0, hasSalesRows false — never dropped.
  const zeroRow = byCode.get("PH-2")!;
  assert.equal(zeroRow.salesValue, 0);
  assert.equal(zeroRow.salesUnits, 0);
  assert.equal(zeroRow.hasSalesRows, false);
  assert.equal(zeroRow.distributorName, "Ibnsina");
  assert.equal(zeroRow.parentDistributorCode, "IS");

  // ── A matched pharmacy carries its real value/units and hasSalesRows=true.
  const hitRow = byCode.get("PH-1")!;
  assert.equal(hitRow.salesValue, 1500);
  assert.equal(hitRow.salesUnits, 10);
  assert.equal(hitRow.hasSalesRows, true);

  // ── Missing distributor metadata falls back to null gracefully (never throws/undefined-crashes).
  const noDistributorRow = byCode.get("PH-3")!;
  assert.equal(noDistributorRow.distributorName, null);
  assert.equal(noDistributorRow.parentDistributorCode, null);

  // ── Sort order: highest sales value first; zero-sales rows sink to the bottom.
  assert.deepEqual(rows.map((r) => r.pharmacyCode), ["PH-1", "PH-3", "PH-2"], "sorted by salesValue desc, zero last");

  // ── The merge NEVER fabricates a row from the sales aggregate alone: a sales key with
  //    no corresponding target pharmacy must not appear in the output.
  const byPharmacyWithStray = new Map([
    ["PH-1", { value: 100, units: 1 }],
    ["PH-999-NOT-A-TARGET", { value: 99999, units: 999 }],
  ]);
  const strayRows = mergePharmacyCoverage(
    [{ code: "PH-1", name: "Pharmacy One" }],
    byPharmacyWithStray,
    new Map(),
    new Map(),
  );
  assert.equal(strayRows.length, 1, "a stray sales aggregate for a non-target pharmacy must not fabricate an extra row");
  assert.equal(strayRows[0].pharmacyCode, "PH-1");

  // ── Empty target list → empty output (never throws).
  assert.deepEqual(mergePharmacyCoverage([], new Map(), new Map(), new Map()), []);
}
