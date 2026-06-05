import assert from "node:assert/strict";

import {
  buildLineProductMatrix,
  rollupByLine,
  type ExecDistProductRow,
} from "../src/lib/sales/executive-report.ts";

const rows: ExecDistProductRow[] = [
  { areaCode: "A1", distributorCode: "PS", officialLine: "Head Office", productCode: "P-A", productName: "Product A", regionCode: "CA", units: 10, value: 100 },
  { areaCode: "A1", distributorCode: "IS", officialLine: "Head Office", productCode: "P-A", productName: "Product A", regionCode: "CA", units: 4, value: 40 },
  { areaCode: "A2", distributorCode: "PS", officialLine: "Head Office", productCode: "P-B", productName: "Product B", regionCode: "CA", units: 5, value: 60 },
  { areaCode: "A3", distributorCode: "IS", officialLine: "Pedia", productCode: "P-C", productName: "Product C", regionCode: "AB", units: 7, value: 70 },
  { areaCode: "A3", distributorCode: "EP-S", officialLine: "Pedia", productCode: "P-C", productName: "Product C", regionCode: "AB", units: 3, value: 30 },
];

export function runExecutiveReportTests() {
  // rollupByLine — value/units, distinct counts, share, no double counting, sorted by value.
  const byLine = rollupByLine(rows);
  assert.equal(byLine.length, 2);
  const head = byLine.find((l) => l.officialLine === "Head Office");
  const pedia = byLine.find((l) => l.officialLine === "Pedia");
  assert.ok(head && pedia);
  assert.equal(head!.value, 200); // 100 + 40 + 60
  assert.equal(head!.units, 19); // 10 + 4 + 5
  assert.equal(head!.productCount, 2); // P-A, P-B
  assert.equal(head!.areaCount, 2); // A1, A2
  assert.equal(head!.distributorCount, 2); // PS, IS
  assert.equal(pedia!.value, 100); // 70 + 30
  assert.equal(pedia!.distributorCount, 2); // IS, EP-S
  assert.equal(pedia!.productCount, 1); // P-C only
  // shares sum to 1; sorted by value desc (Head Office first)
  assert.equal(byLine[0]!.officialLine, "Head Office");
  assert.ok(Math.abs(head!.valueShare - 200 / 300) < 1e-6);
  assert.ok(Math.abs(head!.valueShare + pedia!.valueShare - 1) < 1e-6);

  // buildLineProductMatrix — per (line, product), lineShare relative to the line.
  const matrix = buildLineProductMatrix(rows);
  const headPA = matrix.find((m) => m.officialLine === "Head Office" && m.productCode === "P-A");
  const headPB = matrix.find((m) => m.officialLine === "Head Office" && m.productCode === "P-B");
  const pediaPC = matrix.find((m) => m.officialLine === "Pedia" && m.productCode === "P-C");
  assert.ok(headPA && headPB && pediaPC);
  assert.equal(headPA!.value, 140); // 100 + 40 (both distributors merged)
  assert.equal(headPA!.units, 14);
  assert.equal(headPB!.value, 60);
  assert.ok(Math.abs(headPA!.lineShare - 140 / 200) < 1e-6);
  assert.ok(Math.abs(headPB!.lineShare - 60 / 200) < 1e-6);
  assert.equal(pediaPC!.value, 100); // 70 + 30
  assert.ok(Math.abs(pediaPC!.lineShare - 1) < 1e-6); // sole product in its line
  // grouped by line, then value desc within line (P-A before P-B under Head Office)
  const headRows = matrix.filter((m) => m.officialLine === "Head Office");
  assert.equal(headRows[0]!.productCode, "P-A");
  assert.equal(headRows[1]!.productCode, "P-B");

  // Empty input → empty rollups (no throw, denominator-safe).
  assert.deepEqual(rollupByLine([]), []);
  assert.deepEqual(buildLineProductMatrix([]), []);
}
