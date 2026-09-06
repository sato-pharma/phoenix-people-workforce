import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyCustomerChannel } from "../src/lib/sales/customer-channel.ts";

/**
 * `classifyCustomerChannel` resolves a channel in this order:
 *   hospital keywords -> PHARMACY override -> store override -> store keywords -> pharmacy.
 *
 * `phx_sales_channels_by_rep` implemented every step EXCEPT the pharmacy override, and had no
 * parameter for it at all — so the owner's per-customer pharmacy rulings of 2026-08-06 could not
 * reach the Channels by Rep tab, while the Customer Directory and the monthly-closing channel
 * comparison both pass them. Measured on production: 578,248.77 EGP of the owner's explicitly-ruled
 * pharmacies read as STORES on this one tab. For 2026-07 alone the correction moves 130,587.75 EGP
 * out of store and into pharmacy, with the total unchanged.
 */

const SRC = readFileSync(new URL("../src/lib/sales/channels-by-rep.ts", import.meta.url), "utf8");

export function runChannelsByRepPharmacyOverrideTests() {
  // 1. The canonical rule: an owner-ruled pharmacy stays a pharmacy even though its name carries a
  //    store keyword. Both live overrides do carry one — that is why they needed a ruling.
  assert.equal(
    classifyCustomerChannel("مخزن الطرشوبى للادويه", "1577318", "PS"),
    "pharmacy",
    "an owner-ruled pharmacy outranks the store keyword in its own name",
  );
  assert.equal(
    classifyCustomerChannel("المتحدةشركة صيدليات عابدين فارما", "421516", "IS-S"),
    "pharmacy",
    "the pharmacy override applies at every distributor — it is keyed by customer code alone",
  );

  // 2. Without the ruling those same names ARE stores, which is what makes the override load-bearing
  //    rather than decorative.
  assert.equal(
    classifyCustomerChannel("مخزن الطرشوبى للادويه", "999999", "PS"),
    "store",
    "the same name without a ruling is a store — the override is doing the work here",
  );

  // 3. Hospital still wins over the pharmacy override, matching the documented precedence.
  assert.equal(
    classifyCustomerChannel("مستشفى مخزن", "1577318", "PS"),
    "hospital",
    "hospital keywords outrank the pharmacy override",
  );

  // 4. The wiring: Channels by Rep must actually SEND the pharmacy overrides. The RPC ignored them
  //    for want of a parameter, and a correct override list nobody passes changes nothing.
  assert.ok(
    SRC.includes("p_pharmacy_override_codes: [...PHARMACY_OVERRIDE_CLIENT_CODES]"),
    "Channels by Rep must pass the owner's pharmacy overrides to the RPC, as its sibling surfaces do",
  );
  assert.ok(
    SRC.includes("p_store_override_keys: [...STORE_OVERRIDE_CUSTOMER_KEYS]"),
    "and must keep passing the store overrides",
  );
}
