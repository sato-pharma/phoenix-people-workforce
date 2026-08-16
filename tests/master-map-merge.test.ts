import assert from "node:assert/strict";
import {
  mergeMasterMapCustomers,
  type MasterMapCustomerInput,
} from "../src/lib/sales/master-map/customer-merge.ts";

// The Master Map collapses distributor rows into one row per real shop. Merging by name is an
// inference, and a WRONG merge is invisible — two pharmacies silently become one line and nothing
// in the sheet says so. Measured against production, the unguarded rule fused 6,930 real
// pharmacies into 477 rows. These tests pin the two guards that stop that.

function row(overrides: Partial<MasterMapCustomerInput> = {}): MasterMapCustomerInput {
  return {
    address: "",
    brickId: "B1",
    customerCode: "1",
    customerName: "صيدلية النور",
    distributorCode: "IS",
    source: "admin-import",
    ...overrides,
  };
}

export function runMasterMapMergeTests() {
  // ---- GUARD 1: a nameless row never merges -------------------------------------------------
  // 7,407 production rows carry no name at all. Matching "" against "" is evidence of nothing.
  const nameless = mergeMasterMapCustomers([
    row({ customerCode: "100", customerName: "", distributorCode: "EP-BK" }),
    row({ customerCode: "101", customerName: "", distributorCode: "EP-BK" }),
    row({ customerCode: "102", customerName: null, distributorCode: "PS" }),
  ]);
  assert.equal(
    nameless.length,
    3,
    "three nameless customers stay three shops — merging blank names is what fused 68 real pharmacies into one row",
  );
  assert.ok(
    nameless.every((customer) => !customer.hasName),
    "a nameless shop reports hasName false so the renderer can label it rather than print an empty cell",
  );

  // A whitespace-only name folds to empty and must be treated as nameless, not as a shared name.
  const blankish = mergeMasterMapCustomers([
    row({ customerCode: "200", customerName: "   " }),
    row({ customerCode: "201", customerName: "\t\n" }),
  ]);
  assert.equal(blankish.length, 2, "whitespace-only names fold to empty and still never merge");

  // ---- GUARD 2: never fuse two codes of ONE distributor -------------------------------------
  // If Ibnsina holds two codes for the same name in the same brick, Ibnsina is saying these are
  // two customers. It is the only party that actually knows.
  const sameDistributor = mergeMasterMapCustomers([
    row({ customerCode: "300", distributorCode: "IS" }),
    row({ customerCode: "301", distributorCode: "IS" }),
  ]);
  assert.equal(
    sameDistributor.length,
    2,
    "one distributor with two codes for the same name in the same brick means two shops, never one",
  );

  // The guard must not leak: a third distributor's row for that same name must also stay separate,
  // because the group it would join is already known to be ambiguous.
  const contaminated = mergeMasterMapCustomers([
    row({ customerCode: "300", distributorCode: "IS" }),
    row({ customerCode: "301", distributorCode: "IS" }),
    row({ customerCode: "302", distributorCode: "PS" }),
  ]);
  assert.equal(
    contaminated.length,
    3,
    "once a distributor has disowned the name, no other distributor's row may merge into it either",
  );

  // ---- The merge that IS wanted --------------------------------------------------------------
  const merged = mergeMasterMapCustomers([
    row({ customerCode: "375429", distributorCode: "IS" }),
    row({ customerCode: "375429", distributorCode: "IS-S" }),
  ]);
  assert.equal(merged.length, 1, "the same shop in two distributors' books is one shop");
  assert.deepEqual(
    merged[0].codes.map((code) => `${code.distributorCode}:${code.customerCode}`),
    ["IS:375429", "IS-S:375429"],
    "both pairings are kept and ordered stably, so the sheet never loses a code it was given",
  );

  // Geography is part of identity: the same name in a different brick is a different shop.
  const differentBricks = mergeMasterMapCustomers([
    row({ brickId: "B1", customerCode: "400", distributorCode: "IS" }),
    row({ brickId: "B2", customerCode: "401", distributorCode: "PS" }),
  ]);
  assert.equal(differentBricks.length, 2, "the same pharmacy name in two bricks is two pharmacies");

  // ---- Provenance ----------------------------------------------------------------------------
  const provenance = mergeMasterMapCustomers([
    row({ customerCode: "500", distributorCode: "IS", source: "admin-import" }),
    row({ customerCode: "500", distributorCode: "PS", source: "normalizer" }),
    row({ customerCode: "500", distributorCode: "RM", source: "admin-import" }),
  ]);
  assert.equal(provenance.length, 1, "three distributors, one shop");
  assert.deepEqual(
    provenance[0].sources,
    ["admin-import", "normalizer"],
    "every distinct origin is kept and de-duplicated, so a merged row never claims a single source it cannot support",
  );

  // ---- Address selection ---------------------------------------------------------------------
  const addresses = mergeMasterMapCustomers([
    row({ address: "ش التحرير", customerCode: "600", distributorCode: "IS" }),
    row({ address: "ش التحرير - بجوار البنك الاهلي", customerCode: "600", distributorCode: "PS" }),
  ]);
  assert.equal(
    addresses[0].address,
    "ش التحرير - بجوار البنك الاهلي",
    "the most detailed address wins, because a shorter one is usually the same place described less well",
  );
  assert.deepEqual(
    addresses[0].conflictingAddresses,
    ["ش التحرير"],
    "the discarded address is retained rather than dropped, so a bad merge stays visible in the data",
  );

  // ---- Order independence --------------------------------------------------------------------
  // This runs hourly. A sheet whose rows reshuffle between syncs for no reason reads as broken.
  const forwards = mergeMasterMapCustomers([
    row({ customerCode: "700", customerName: "ب", distributorCode: "IS" }),
    row({ customerCode: "701", customerName: "ا", distributorCode: "PS" }),
    row({ customerCode: "702", customerName: "", distributorCode: "RM" }),
  ]);
  const backwards = mergeMasterMapCustomers([
    row({ customerCode: "702", customerName: "", distributorCode: "RM" }),
    row({ customerCode: "701", customerName: "ا", distributorCode: "PS" }),
    row({ customerCode: "700", customerName: "ب", distributorCode: "IS" }),
  ]);
  assert.deepEqual(
    forwards.map((customer) => customer.codes[0].customerCode),
    backwards.map((customer) => customer.codes[0].customerCode),
    "input order must not change the output, or every sync would rewrite rows that did not change",
  );
  assert.equal(
    forwards[forwards.length - 1].hasName,
    false,
    "nameless shops sort to the end of their brick, where they read as the punch list they are",
  );

  // ---- Arabic folding is shared with the Customer Directory ----------------------------------
  // ة/ه and أ/ا are interchangeable in Egyptian data entry; the same fold the channel classifier
  // uses must apply here, or the two features disagree about what one shop is.
  const folded = mergeMasterMapCustomers([
    row({ customerCode: "800", customerName: "صيدليه الأمل", distributorCode: "IS" }),
    row({ customerCode: "800", customerName: "صيدلية الامل", distributorCode: "PS" }),
  ]);
  assert.equal(
    folded.length,
    1,
    "spellings that differ only by ة/ه or أ/ا are one shop, matching how the Customer Directory folds names",
  );
}
