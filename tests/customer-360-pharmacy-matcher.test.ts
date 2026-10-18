import assert from "node:assert/strict";

import {
  matchItemKey,
  matchNamedPharmacy,
  NEAR_NAME_MIN_KEY,
  type MapShopRow,
  type StoredDecision,
} from "../src/lib/customer-360/pharmacy-matcher.ts";
import { pharmacyNameKey } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";

/**
 * A pharmacy a rep NAMED on a visit, matched to a shop on the Monthly Closing's customer map — the
 * owner's rule (2026-10-18): the same name in the same brick is tied automatically; anything uncertain
 * waits for him on the confirm tab, and his decision outranks the rule.
 */

function shop(overrides: Partial<MapShopRow> = {}): MapShopRow {
  return {
    address: "12 Tahrir St",
    areaCode: "GZ3",
    brickId: "B1",
    customerCode: "1001",
    customerName: "صيدلية النور",
    distributorCode: "IS",
    ...overrides,
  };
}

const NOUR = pharmacyNameKey("صيدلية النور");

function decision(overrides: Partial<StoredDecision> = {}): StoredDecision {
  return {
    decidedAt: "2026-10-18T10:00:00Z",
    decidedByHrId: "B-10",
    pairs: [{ brickId: "B1", customerCode: "1002", customerName: "صيدلية النور", distributorCode: "IS" }],
    status: "confirmed",
    ...overrides,
  };
}

export function runCustomer360PharmacyMatcherTests() {
  // ── The fold: one shop, however the rep spelled it ────────────────────────────────────────────
  assert.equal(pharmacyNameKey("صيدليه النور"), NOUR, "ta marbuta and ha are one letter to the match");
  assert.equal(pharmacyNameKey("النور pharmacy"), NOUR, "the word pharmacy is dropped wherever it stands");

  // ── AUTO: exactly one shop of that name in the brick ──────────────────────────────────────────
  const one = matchNamedPharmacy({ areaShops: [], brickId: "B1", brickShops: [shop()], nameKey: NOUR });
  assert.equal(one.status, "auto", "one shop of the same name in the same brick is tied by itself");
  assert.deepEqual(
    one.pairs.map((pair) => `${pair.distributorCode}|${pair.customerCode}`),
    ["IS|1001"],
    "and it is tied by its distributor pair",
  );
  assert.equal(one.candidates.length, 0, "an automatic tie offers nothing to confirm");

  const twoDistributors = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop(), shop({ customerCode: "77", distributorCode: "egd" })],
    nameKey: NOUR,
  });
  assert.equal(twoDistributors.status, "auto", "one shop bought from two distributors is still one shop");
  assert.deepEqual(
    twoDistributors.pairs.map((pair) => `${pair.distributorCode}|${pair.customerCode}`).sort(),
    ["EGD|77", "IS|1001"],
    "and every one of its pairs is tied, distributor upper-cased",
  );

  const repeated = matchNamedPharmacy({ areaShops: [], brickId: "B1", brickShops: [shop(), shop()], nameKey: NOUR });
  assert.equal(repeated.status, "auto");
  assert.equal(repeated.pairs.length, 1, "a map row seen twice is one pair");

  // ── WAITING: everything uncertain goes to him ─────────────────────────────────────────────────
  const twoShops = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop(), shop({ address: "40 Nile St", customerCode: "1002" })],
    nameKey: NOUR,
  });
  assert.equal(twoShops.status, "waiting", "two shops of that name at one distributor are never guessed between");
  assert.equal(twoShops.reason, "two_shops_one_distributor");
  assert.equal(twoShops.candidates.length, 2, "both are offered, with their addresses");
  assert.deepEqual(twoShops.pairs, [], "and nothing is tied");

  const shifa = pharmacyNameKey("صيدلية الشفاء");
  const shifaKubra = pharmacyNameKey("صيدلية الشفاء الكبرى");
  assert.ok(shifaKubra.includes(shifa) && shifa.length >= NEAR_NAME_MIN_KEY, "fixture: the near name really holds the typed name");
  const near = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop({ customerName: "صيدلية الشفاء الكبرى" })],
    nameKey: shifa,
  });
  assert.equal(near.status, "waiting", "a near name is shown, never tied");
  assert.equal(near.reason, "near_name_only");
  assert.equal(near.candidates[0]?.why, "near_name_same_brick");

  const elsewhere = matchNamedPharmacy({
    areaShops: [shop({ brickId: "B2", customerCode: "2001" }), shop({ brickId: "B1", customerCode: "9999" })],
    brickId: "B1",
    brickShops: [],
    nameKey: NOUR,
  });
  assert.equal(elsewhere.status, "waiting", "the same name in a neighbouring brick never ties by itself");
  assert.equal(elsewhere.reason, "other_brick_only");
  assert.deepEqual(
    elsewhere.candidates.map((candidate) => candidate.customerCode),
    ["2001"],
    "only the other bricks' shops are offered as elsewhere",
  );

  const nothing = matchNamedPharmacy({ areaShops: [], brickId: "B1", brickShops: [shop({ customerName: "صيدلية الحياة" })], nameKey: NOUR });
  assert.equal(nothing.status, "waiting");
  assert.equal(nothing.reason, "no_candidate", "no shop of that name anywhere near says so");

  const noBrick = matchNamedPharmacy({ areaShops: [], brickId: null, brickShops: [shop()], nameKey: NOUR });
  assert.equal(noBrick.status, "waiting", "a visit place with no brick cannot be matched");
  assert.equal(noBrick.reason, "no_brick");

  const blankCode = matchNamedPharmacy({ areaShops: [], brickId: "B1", brickShops: [shop({ customerCode: "  " })], nameKey: NOUR });
  assert.notEqual(blankCode.status, "auto", "a map row with no customer code is never tied");

  // A wholesaler is never a pharmacy a doctor sends patients to, even under the very name typed.
  const store = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop({ customerName: "مخزن النور" })],
    nameKey: pharmacyNameKey("مخزن النور"),
  });
  assert.notEqual(store.status, "auto", "a warehouse is never tied");
  assert.equal(store.candidates.length, 0, "and never offered");

  const crowd = Array.from({ length: 20 }, (_, index) => shop({ brickId: `B${index + 2}`, customerCode: String(3000 + index) }));
  assert.ok(
    matchNamedPharmacy({ areaShops: crowd, brickId: "B1", brickShops: [], nameKey: NOUR }).candidates.length <= 12,
    "the confirm tab offers a short list, never the whole area",
  );

  // ── His decision outranks the rule ────────────────────────────────────────────────────────────
  const confirmed = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop(), shop({ customerCode: "1002" })],
    decision: decision(),
    nameKey: NOUR,
  });
  assert.equal(confirmed.status, "confirmed", "a shop he confirmed stands, whatever the map holds");
  assert.deepEqual(confirmed.pairs.map((pair) => pair.customerCode), ["1002"], "and it is the shop he picked");

  const rejected = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop()],
    decision: decision({ pairs: [], status: "rejected" }),
    nameKey: NOUR,
  });
  assert.equal(rejected.status, "rejected", "\"none of these\" stands even where the rule would tie");
  assert.deepEqual(rejected.pairs, [], "and ties nothing");

  // A stored automatic tie is a record, not a decision: when the shop stops being unique it waits again.
  const staleAuto = matchNamedPharmacy({
    areaShops: [],
    brickId: "B1",
    brickShops: [shop(), shop({ customerCode: "1002" })],
    decision: decision({ decidedByHrId: null, status: "auto" }),
    nameKey: NOUR,
  });
  assert.equal(staleAuto.status, "waiting", "an automatic tie that stopped being unique goes back to the confirm tab");

  // ── One item per name per brick ───────────────────────────────────────────────────────────────
  assert.equal(matchItemKey(NOUR, "B1"), `B1|${NOUR}`, "an item is keyed by brick and folded name, so tomorrow's visit finds it");
  assert.notEqual(matchItemKey(NOUR, "B1"), matchItemKey(NOUR, "B2"), "the same name in two bricks is two items");
}
