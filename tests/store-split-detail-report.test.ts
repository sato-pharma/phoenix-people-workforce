import assert from "node:assert/strict";

import {
  detailStoreSplitByCustomer,
  summariseStoreSplitByCustomer,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

// The detailed store-split report (owner request, 2026-08-05): which STORE was split, on which
// product, the units and values, and what each area of its city received.
//
// The property that makes it trustworthy is that it describes the SAME movement the closing
// applies — it is derived from the same eligibility rule, so it can never claim a split that did
// not happen nor miss one that did. And the shares must add back to the sale: a report of a
// total-preserving move that does not itself preserve the total would be worse than no report.

type Row = StoreSplitRow & { areaName?: string; clientCode?: string; productName?: string };

function row(overrides: Partial<Row>): Row {
  return {
    areaCode: "AB1",
    areaName: "Alex East",
    clientCode: "C-1",
    clientName: "مخزن وايتس فارم",   // "store" in Arabic — classified as a wholesaler
    includedInClosing: true,
    isDirect: false,
    officialLine: "CNS",
    productCode: "TE001",
    productName: "Tebofortine 40 mg",
    qty: 90,
    salesValue: 9_000,
    ...overrides,
  };
}

export function runStoreSplitDetailReportTests() {
  const rows: Row[] = [
    // Alexandria has three areas (AB1/AB2/AB3), so this divides three ways.
    row({}),
    // Same store, second product — must be its own detail row but one store in the summary.
    row({ productCode: "TE002", productName: "Tebofortine Forte 80", qty: 30, salesValue: 3_000 }),
    // Same store and product, a second invoice line — folded into one row, not duplicated.
    row({ qty: 30, salesValue: 3_000 }),
    // A PHARMACY is never split, whatever else is true of it.
    row({ clientCode: "C-2", clientName: "Dr Ahmed Pharmacy", qty: 500, salesValue: 50_000 }),
    // A direct order carries no area and never participates.
    row({ clientCode: "C-3", clientName: "مخزن الطرشوبى", isDirect: true, qty: 400, salesValue: 40_000 }),
    // A row excluded from the closing cannot move money that is not in the closing.
    row({ clientCode: "C-4", clientName: "مخزن النور", includedInClosing: false, qty: 300, salesValue: 30_000 }),
    // A store in an area with NO city mapping stays where it is.
    row({ clientCode: "C-5", clientName: "مخزن بلا مدينة", areaCode: "ZZ9", areaName: "Nowhere", qty: 10, salesValue: 1_000 }),
  ];

  const details = detailStoreSplitByCustomer(rows);

  // Only the eligible store's two products appear — nothing else moved.
  assert.equal(details.length, 2, "only the split-eligible store's rows are reported, one per product");
  const codes = details.map((entry) => entry.productCode).sort();
  assert.deepEqual(codes, ["TE001", "TE002"]);
  assert.ok(
    !details.some((entry) => /Pharmacy|بلا مدينة|النور|الطرشوبى/.test(entry.clientName)),
    "a pharmacy, a direct order, an excluded row and an unmapped area are all absent — the report mirrors the split exactly",
  );

  const main = details.find((entry) => entry.productCode === "TE001")!;
  assert.equal(main.units, 120, "the two invoice lines of the same store and product are folded into one row");
  assert.equal(main.value, 12_000);
  assert.equal(main.originAreaCode, "AB1");
  assert.equal(main.originAreaName, "Alex East", "the store's own area is named, not just coded");
  assert.equal(main.city, "Alexandria");
  assert.deepEqual([...main.sharedWithAreaCodes], ["AB1", "AB2", "AB3"], "the whole city receives a share, including the store's own area");

  // THE arithmetic: the shares add back to the sale.
  assert.equal(main.shareValue, 4_000, "12,000 across three areas is 4,000 each");
  assert.equal(
    Number((main.shareValue * main.sharedWithAreaCodes.length).toFixed(2)),
    main.value,
    "share x areas must reproduce the row's own value — a report of a total-preserving move must preserve the total",
  );
  assert.equal(main.originKeepsValue, 4_000, "the origin area keeps ONE share, not the whole sale — that is the entire point of the split");

  // The store-level summary folds the products without losing the money.
  const stores = summariseStoreSplitByCustomer(rows);
  assert.equal(stores.length, 1, "one eligible store");
  const [store] = stores;
  assert.equal(store.products, 2, "both of its products are counted");
  assert.equal(store.units, 150, "120 + 30");
  assert.equal(store.value, 15_000, "12,000 + 3,000 — the summary and the detail describe the same money");
  assert.equal(store.areasSharedWith, 3);
  assert.equal(
    Number(details.reduce((sum, entry) => sum + entry.value, 0).toFixed(2)),
    store.value,
    "the detail rows sum to the store summary exactly",
  );

  // An empty month is an empty report, not a crash or a fabricated row.
  assert.deepEqual(detailStoreSplitByCustomer([]), []);
  assert.deepEqual(summariseStoreSplitByCustomer([]), []);

  // A store with no code is still named rather than silently dropped — the code is what is
  // missing, not the sale.
  const anonymous = detailStoreSplitByCustomer([row({ clientCode: "", clientName: "مخزن بدون كود" })]);
  assert.equal(anonymous.length, 1);
  assert.equal(anonymous[0]?.clientCode, "—", "a missing customer code reads as an em dash, never as a blank that looks like an error");
  assert.equal(anonymous[0]?.clientName, "مخزن بدون كود");
}
