import assert from "node:assert/strict";

import {
  applyDirectorySearch,
  mapDirectoryRowsToNames,
  rollUpCustomerSales,
  type CustomerDirectoryRow,
  type CustomerSalesLine,
} from "../src/lib/sales/customer-directory.ts";

export function runCustomerDirectoryTests() {
  // mapDirectoryRowsToNames: codes → names, fallback to code when missing.
  const maps = {
    areaName: new Map([["A1", "Heliopolis"]]),
    brickName: new Map([["B-1", "Brick One"]]),
    distributorName: new Map([["IS-S", "Ibn Sina-Sato"]]),
    regionName: new Map([["CA", "Cairo"]]),
  };
  const mapped = mapDirectoryRowsToNames(
    [
      {
        area_code: "A1",
        brick_id: "B-1",
        client_address: "1 Main St",
        client_code: "C100",
        client_name: "Pharmacy A",
        distributor_code: "IS-S",
        region_code: "CA",
        total_units: 12,
        total_value: 729,
      },
      {
        area_code: "A9",
        brick_id: "B-9",
        client_address: "",
        client_code: "C200",
        client_name: "Pharmacy B",
        distributor_code: "ZZ",
        region_code: "ZZ",
        total_units: 0,
        total_value: 0,
      },
    ],
    maps,
  );
  assert.equal(mapped[0]?.brickName, "Brick One");
  assert.equal(mapped[0]?.areaName, "Heliopolis");
  assert.equal(mapped[0]?.regionName, "Cairo");
  assert.equal(mapped[0]?.distributorName, "Ibn Sina-Sato");
  assert.equal(mapped[0]?.totalValue, 729);
  // Unknown codes fall back to the code itself.
  assert.equal(mapped[1]?.brickName, "B-9");
  assert.equal(mapped[1]?.distributorName, "ZZ");

  // applyDirectorySearch: case-insensitive match on name OR code; empty = all.
  const rows: CustomerDirectoryRow[] = mapped;
  assert.equal(applyDirectorySearch(rows, "").length, 2);
  assert.equal(applyDirectorySearch(rows, "pharmacy a")[0]?.clientCode, "C100");
  assert.equal(applyDirectorySearch(rows, "C200")[0]?.clientName, "Pharmacy B");
  assert.equal(applyDirectorySearch(rows, "nomatch").length, 0);

  // rollUpCustomerSales: per-product + grand totals (units AND value).
  const lines: CustomerSalesLine[] = [
    { brickId: "B-1", invoicePeriod: "2026-04", officialLine: "Anti infective", productCode: "RO001", productName: "Royafloxacin", qty: 10, value: 607.5 },
    { brickId: "B-1", invoicePeriod: "2026-04", officialLine: "Anti infective", productCode: "RO001", productName: "Royafloxacin", qty: 2, value: 121.5 },
    { brickId: "B-1", invoicePeriod: "2026-04", officialLine: "Pedia", productCode: "GU001", productName: "Guamusin", qty: 4, value: 243 },
  ];
  const rolled = rollUpCustomerSales(lines);
  assert.equal(rolled.totalUnits, 16);
  assert.equal(rolled.totalValue, 972);
  assert.equal(rolled.productTotals.length, 2);
  const roya = rolled.productTotals.find((product) => product.productCode === "RO001");
  assert.equal(roya?.totalUnits, 12);
  assert.equal(roya?.totalValue, 729);
}
