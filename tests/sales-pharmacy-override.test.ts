import assert from "node:assert/strict";

import {
  classifyCustomerChannel,
  isPharmacyOverride,
  isStoreCustomer,
  PHARMACY_OVERRIDE_CLIENT_CODES,
} from "../src/lib/sales/customer-channel.ts";
import { isSplitEligible, type StoreSplitRow } from "../src/lib/sales/store-sales-city-split.ts";

// The owner reviewed all 22 store-classified Anti Infective customers on 2026-08-06 and ruled two
// of them pharmacies despite their names. Both are kept as CODE-keyed exceptions rather than by
// weakening the keyword list, which he ruled must stay exactly as it is.
//
// The second one matters most: مخزن الطرشوبى للادويه matched on مخزن — the one keyword that looked
// unambiguous. No keyword survives contact with how shops actually name themselves, which is the
// whole argument for an override list.

const ABDEEN = { code: "421516", name: "المتحدةشركة صيدليات عابدين فارما" };
const TARSHOUBY = { code: "0001577318", name: "مخزن الطرشوبى للادويه" };

function splitRow(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: "D21",
    clientCode: "0001577318",
    clientName: TARSHOUBY.name,
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 50,
    salesValue: 5557.5,
    ...over,
  };
}

export async function runSalesPharmacyOverrideTests() {
  // ── the override is recognised, and zero-padding does not defeat it ────────────────────────
  // Distributors pad codes differently: the same shop arrives as 421516 and as 0001577318 in the
  // very same month. Matching on the raw string would apply the ruling to one file and not another.
  assert.ok(isPharmacyOverride(ABDEEN.code), "the plain code is recognised");
  assert.ok(isPharmacyOverride(TARSHOUBY.code), "a zero-padded code is recognised");
  assert.ok(isPharmacyOverride("1577318"), "the same code unpadded is the same customer");
  assert.ok(!isPharmacyOverride("0001539521"), "مخزن القادسية is NOT overridden — a real store");
  assert.ok(!isPharmacyOverride(""), "a blank code overrides nothing");
  assert.ok(!isPharmacyOverride(null), "a missing code overrides nothing");

  // ── classification honours the ruling ──────────────────────────────────────────────────────
  assert.equal(
    classifyCustomerChannel(ABDEEN.name, ABDEEN.code),
    "pharmacy",
    "عابدين فارما is a pharmacy despite matching فارم",
  );
  assert.equal(
    classifyCustomerChannel(TARSHOUBY.name, TARSHOUBY.code),
    "pharmacy",
    "الطرشوبى is a pharmacy despite matching مخزن",
  );
  // Without the code the keyword still wins — this is the silent-failure mode worth pinning, because
  // a caller that forgets to pass the code gets the OLD answer with no error.
  assert.equal(
    classifyCustomerChannel(TARSHOUBY.name),
    "store",
    "omitting the code falls back to the keyword answer — callers MUST pass it",
  );
  // A genuine warehouse is untouched by any of this.
  assert.equal(classifyCustomerChannel("مخزن القادسية", "0001539521"), "store");

  // ── and the SPLIT stops moving their money ─────────────────────────────────────────────────
  // This is the point of the exercise: an overridden pharmacy's sales must stay in its own area
  // instead of being scattered across every area of its city and credited to other reps.
  assert.equal(
    isSplitEligible(splitRow()),
    false,
    "الطرشوبى must NOT be split — its 5,557.50 stays in D21",
  );
  assert.equal(
    isSplitEligible(splitRow({ clientCode: ABDEEN.code, clientName: ABDEEN.name, areaCode: "UE5" })),
    false,
    "عابدين فارما must NOT be split",
  );
  // The control: a real warehouse in a multi-area city is still split.
  assert.equal(
    isSplitEligible(splitRow({ clientCode: "0001539521", clientName: "مخزن القادسية", areaCode: "D12" })),
    true,
    "مخزن القادسية IS still split — the override must not disable the rule itself",
  );

  // isStoreCustomer is what the split asks, so it must agree with the classifier here.
  assert.equal(isStoreCustomer(TARSHOUBY.name, TARSHOUBY.code), false);
  assert.equal(isStoreCustomer(TARSHOUBY.name), true, "again: no code, no override");
  assert.equal(isStoreCustomer("مخزن القادسية", "0001539521"), true);

  assert.equal(PHARMACY_OVERRIDE_CLIENT_CODES.size, 2, "exactly the two the owner ruled on");
}
