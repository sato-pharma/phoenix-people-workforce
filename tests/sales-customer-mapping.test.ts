import assert from "node:assert/strict";

import {
  consolidateCustomers,
  customerMatchKey,
  normalizeIdentityText,
  stableGroupId,
} from "../src/lib/sales/customer-mapping.ts";

type DirRow = Parameters<typeof consolidateCustomers>[0][number];

function row(overrides: Partial<DirRow>): DirRow {
  return {
    areaCode: "A1",
    areaName: "Area One",
    brickId: "BR1",
    brickName: "Brick One",
    channel: "pharmacy",
    clientAddress: "10 Tahrir St",
    clientCode: "C1",
    clientName: "Nile Pharmacy",
    distributorCode: "D1",
    distributorName: "Distributor One",
    matchedKeywords: [],
    regionCode: "R1",
    regionName: "Region One",
    totalUnits: 10,
    totalValue: 100,
    ...overrides,
  };
}

export function runCustomerMappingTests() {
  // normalizeIdentityText: case/punctuation/whitespace fold; diacritics; blanks.
  assert.equal(normalizeIdentityText("  El-Shifa   PHARMACY!! "), "el shifa pharmacy");
  assert.equal(normalizeIdentityText("Café  Méd"), "cafe med");
  assert.equal(normalizeIdentityText(null), "");
  assert.equal(normalizeIdentityText("صيدلية   النيل"), "صيدلية النيل");

  // stableGroupId: deterministic + order-independent + 8 hex chars.
  assert.equal(stableGroupId("abc"), stableGroupId("abc"));
  assert.notEqual(stableGroupId("abc"), stableGroupId("abd"));
  assert.match(stableGroupId("anything"), /^[0-9A-F]{8}$/);

  // customerMatchKey: blank name is unmatchable; case/punctuation differences still match.
  assert.equal(customerMatchKey({ brickId: "BR1", customerAddress: "x", customerName: "" }), "");
  assert.equal(
    customerMatchKey({ brickId: "BR1", customerAddress: "10 Tahrir St.", customerName: "Nile Pharmacy" }),
    customerMatchKey({ brickId: "br1", customerAddress: "10  tahrir  st", customerName: "NILE PHARMACY!" }),
  );

  // Same pharmacy (name + brick + address) at two distributors → ONE master, merged + summed.
  const same = consolidateCustomers([
    row({ clientCode: "C1", distributorCode: "D1", totalUnits: 10, totalValue: 100 }),
    row({ clientCode: "C2", distributorCode: "D2", clientName: "nile pharmacy", clientAddress: "10 tahrir st", totalUnits: 5, totalValue: 50 }),
  ]);
  assert.equal(same.consolidated.length, 1, "same pharmacy across distributors → one master");
  const master = same.consolidated[0];
  assert.equal(master.distributorSpan, 2);
  assert.equal(master.members.length, 2);
  assert.equal(master.totalUnits, 15);
  assert.equal(master.totalValue, 150);
  assert.equal(same.rows.length, 2, "each distributor row is kept");
  assert.ok(same.rows.every((r) => r.masterCustomerId === master.masterCustomerId), "rows share the master id");
  assert.ok(same.rows.every((r) => r.matched && r.distributorSpan === 2));

  // Different brick → different pharmacy → NOT merged.
  const diffBrick = consolidateCustomers([
    row({ clientCode: "C1", distributorCode: "D1", brickId: "BR1" }),
    row({ clientCode: "C2", distributorCode: "D2", brickId: "BR2" }),
  ]);
  assert.equal(diffBrick.consolidated.length, 2, "different brick stays separate");
  assert.notEqual(diffBrick.rows[0].masterCustomerId, diffBrick.rows[1].masterCustomerId);

  // Blank name → unmatchable → its own solo master, never merged with another blank-name row.
  const blanks = consolidateCustomers([
    row({ clientCode: "C1", distributorCode: "D1", clientName: "" }),
    row({ clientCode: "C2", distributorCode: "D2", clientName: "" }),
  ]);
  assert.equal(blanks.consolidated.length, 2, "blank-name rows do not falsely merge");
  assert.ok(blanks.rows.every((r) => !r.matched && r.distributorSpan === 1));

  // Same physical pharmacy always resolves to the SAME stable master id across runs.
  const a = consolidateCustomers([row({})]).consolidated[0].masterCustomerId;
  const b = consolidateCustomers([row({})]).consolidated[0].masterCustomerId;
  assert.equal(a, b);
  assert.match(a, /^MC-[0-9A-F]{8}$/);
}
