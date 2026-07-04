import assert from "node:assert/strict";

import { groupSalesDetailByPharmacy, mergePharmacyCoverage } from "../src/lib/marketing-requests/coverage-report-service.ts";
import type { MarketingRoiViewSalesRow } from "../src/lib/marketing-requests/roi-report-types.ts";

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

  // ── salesDetail defaults to [] when the 5th param is omitted entirely (backward compatible).
  assert.deepEqual(zeroRow.salesDetail, [], "no salesDetailByPharmacy arg -> every row defaults to an empty array");

  // ── salesDetail: attached per pharmacy code; a pharmacy absent from the map still gets [].
  const salesDetailByPharmacy = new Map([
    ["PH-1", [{ productCode: "GU001", productName: "Gutrin", invoicePeriod: "2026-02", qty: 5, value: 750 }]],
  ]);
  const rowsWithDetail = mergePharmacyCoverage(targets, byPharmacy, distributorNameByCode, parentDistributorCodeByCode, salesDetailByPharmacy);
  const detailByCode = new Map(rowsWithDetail.map((row) => [row.pharmacyCode, row] as const));
  assert.deepEqual(detailByCode.get("PH-1")!.salesDetail, salesDetailByPharmacy.get("PH-1"));
  assert.deepEqual(detailByCode.get("PH-2")!.salesDetail, [], "a pharmacy with no detail entries still gets an empty array, never undefined");
}

export function runMarketingCoverageGroupSalesDetailTests() {
  function saleRow(overrides: Partial<MarketingRoiViewSalesRow>): MarketingRoiViewSalesRow {
    return {
      distributorCode: "IS",
      distributorName: "Ibnsina",
      invoicePeriod: "2026-03",
      productCode: "GU001",
      productName: "Gutrin",
      customerCode: "PH-1",
      customerName: "Pharmacy One",
      regionName: "Cairo",
      qty: 10,
      value: 1500,
      ...overrides,
    };
  }

  // ── Groups by customerCode (pharmacy code); each pharmacy only sees its own rows.
  {
    const rows = [saleRow({ customerCode: "PH-1" }), saleRow({ customerCode: "PH-2", productCode: "OS001", productName: "Osteosat" })];
    const grouped = groupSalesDetailByPharmacy(rows);
    assert.equal(grouped.size, 2);
    assert.equal(grouped.get("PH-1")!.length, 1);
    assert.equal(grouped.get("PH-2")!.length, 1);
    assert.equal(grouped.get("PH-1")![0].productCode, "GU001");
    assert.equal(grouped.get("PH-2")![0].productCode, "OS001");
  }

  // ── Multiple sale rows for the SAME pharmacy accumulate as separate detail rows (never
  //    collapsed/summed — that's what byPharmacy is for; this is the un-aggregated ledger).
  {
    const rows = [
      saleRow({ invoicePeriod: "2026-01", productCode: "GU001", value: 500 }),
      saleRow({ invoicePeriod: "2026-02", productCode: "GU001", value: 600 }),
      saleRow({ invoicePeriod: "2026-01", productCode: "OS001", productName: "Osteosat", value: 400 }),
    ];
    const grouped = groupSalesDetailByPharmacy(rows);
    assert.equal(grouped.get("PH-1")!.length, 3);
  }

  // ── Sort order: oldest invoicePeriod first, then product name — never the raw insertion order.
  {
    const rows = [
      saleRow({ invoicePeriod: "2026-03", productCode: "OS001", productName: "Osteosat" }),
      saleRow({ invoicePeriod: "2026-01", productCode: "GU001", productName: "Gutrin" }),
      saleRow({ invoicePeriod: "2026-01", productCode: "AA001", productName: "Amino" }),
    ];
    const grouped = groupSalesDetailByPharmacy(rows);
    assert.deepEqual(
      grouped.get("PH-1")!.map((row) => `${row.invoicePeriod}:${row.productName}`),
      ["2026-01:Amino", "2026-01:Gutrin", "2026-03:Osteosat"],
    );
  }

  // ── Money is rounded via roundMarketingMoney, mirroring the aggregate path exactly.
  {
    const rows = [saleRow({ value: 1234.567 })];
    const grouped = groupSalesDetailByPharmacy(rows);
    assert.equal(grouped.get("PH-1")![0].value, 1234.57);
  }

  // ── Empty input -> empty map, never throws.
  assert.deepEqual(groupSalesDetailByPharmacy([]), new Map());
}
