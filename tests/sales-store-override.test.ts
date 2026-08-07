import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyCustomerChannel,
  isStoreCustomer,
  isStoreOverride,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  storeOverrideReason,
} from "../src/lib/sales/customer-channel.ts";
import { isSplitEligible, type StoreSplitRow } from "../src/lib/sales/store-sales-city-split.ts";

// The owner ruled on 2026-08-07 that ابن خلدون (client code 446299, distributor IBNSINA) is a
// genuine Menoufia wholesaler that must be split across Menoufia's areas like the other four
// wholesalers there, even though production confirms its name is exactly "ابن خلدون" on every
// period on record — none of the six STORE_NAME_KEYWORDS. This is the mirror image of
// sales-pharmacy-override.test.ts: that file pins a store-by-keyword forced to pharmacy, this one
// pins a pharmacy-by-default forced to store.

const IBN_KHALDOUN = { code: "446299", distributorCode: "IS-S", name: "ابن خلدون" };

function splitRow(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: "D12",
    clientCode: IBN_KHALDOUN.code,
    clientName: IBN_KHALDOUN.name,
    distributorCode: IBN_KHALDOUN.distributorCode,
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 200,
    salesValue: 22230,
    ...over,
  };
}

export async function runSalesStoreOverrideTests() {
  // ── the override is recognised, and zero-padding does not defeat it ────────────────────────
  assert.ok(isStoreOverride(IBN_KHALDOUN.code, "is-s"), "the distributor-scoped code is recognised");
  assert.ok(isStoreOverride("0000446299", " IS-S "), "padding and casing do not defeat the key");
  assert.ok(!isStoreOverride(IBN_KHALDOUN.code, "OTHER"), "the same code at another distributor is untouched");
  assert.ok(!isStoreOverride("446300", "IS-S"), "a neighbouring code is not swept in");
  assert.ok(!isStoreOverride("", "IS-S"), "a blank code overrides nothing");
  assert.ok(!isStoreOverride(null, "IS-S"), "a missing code overrides nothing");

  // ── classification honours the ruling despite no keyword in the name ──────────────────────
  assert.equal(
    classifyCustomerChannel(IBN_KHALDOUN.name, IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode),
    "store",
    "ابن خلدون is a store despite carrying none of the six store words",
  );
  // Without the code, nothing signals a store, and the classifier's honest fallback is pharmacy —
  // pinning the silent-failure mode: a caller that forgets to pass the code gets the OLD answer.
  assert.equal(
    classifyCustomerChannel(IBN_KHALDOUN.name, IBN_KHALDOUN.code, "OTHER"),
    "pharmacy",
    "the same code at another distributor falls back to the keyword-less default",
  );
  assert.equal(storeOverrideReason(IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode), "Owner-approved store");
  // A genuine keyword-matched store is untouched by this override existing at all.
  assert.equal(classifyCustomerChannel("مخزن القادسية", "0001539521"), "store");

  // ── and the SPLIT starts moving its money ──────────────────────────────────────────────────
  // This is the point of the exercise: this wholesaler's sale must now spread across Menoufia's
  // areas instead of sitting entirely on the one area (Menoufia 1 / D12) it happened to book on.
  assert.equal(
    isSplitEligible(splitRow()),
    true,
    "ابن خلدون's Menoufia sale must now be split — it was not before this override",
  );
  // The control: a customer with no override and no keyword is still left alone.
  assert.equal(
    isSplitEligible(splitRow({ clientCode: "999999", clientName: "صيدلية النور" })),
    false,
    "an un-overridden, un-keyworded pharmacy is still never split",
  );
  assert.equal(
    isSplitEligible(splitRow({ distributorCode: "OTHER" })),
    false,
    "a cross-distributor code collision is never split by Ibn Khaldoun's ruling",
  );

  // isStoreCustomer is what the split asks, so it must agree with the classifier here.
  assert.equal(isStoreCustomer(IBN_KHALDOUN.name, IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode), true);
  assert.equal(isStoreCustomer(IBN_KHALDOUN.name), false, "again: no code, no override");
  assert.equal(isStoreCustomer("مخزن القادسية", "0001539521"), true);

  assert.equal(STORE_OVERRIDE_CUSTOMER_KEYS.size, 1, "exactly the one the owner ruled on so far");

  const channelsByRepSource = readFileSync(
    new URL("../src/lib/sales/channels-by-rep.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    channelsByRepSource,
    /p_store_override_keys:\s*\[\.\.\.STORE_OVERRIDE_CUSTOMER_KEYS\]/,
    "Channels by Rep must pass the same distributor-scoped override keys as Monthly Closing",
  );

  const migration = readFileSync(
    new URL("../supabase/migrations/20260807044131_scope_store_override_and_channels_by_rep.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /split_part\(c, '\|', 1\)/, "closing RPCs must compare the distributor part");
  assert.match(migration, /p_store_override_keys text\[\]/, "Channels by Rep must accept owner overrides");
  assert.match(
    migration,
    /split_part\(k, '\|', 1\)/,
    "Channels by Rep must scope an override to the distributor before matching its client code",
  );
}
