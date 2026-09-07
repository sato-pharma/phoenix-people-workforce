import assert from "node:assert/strict";

import {
  classifyCustomerChannel,
  isStoreCustomerForPeriod,
  legacyIsStoreCustomer,
} from "../src/lib/sales/customer-channel.ts";

/**
 * The owner read the EPDA Pedia August 2026 list on 2026-09-07 and ruled seven more customers
 * warehouses. None carries a store word, the «م - » prefix or the trade phrase, so each is named.
 *
 * The reason this file exists is the neighbours, not the seven. `STORE_OVERRIDE_NAMES` is the one
 * list that can CREATE a warehouse from a name — `PHARMACY_OVERRIDE_CHAINS` can only ever refuse
 * one — so an over-wide stem here does not merely mislabel a customer, it deals its sales out across
 * a city and moves money between reps, with no error and nothing downstream reporting it (the split
 * preserves each line's unit total, and the publication drift check compares units).
 *
 * Measured on production before the stems were written: bare «الفرسان» matches NINE customers worth
 * 15,615,203.94 EGP across five businesses. The owner ruled exactly one of them.
 */

const RULED_WAREHOUSES: ReadonlyArray<readonly [string, string, string]> = [
  ["الفرسان - الزاوية", "162956", "EP-PHS"],
  ["الصفا ميديكال م.نصر", "164266", "EP-PHS"],
  ["شركة اورينت جروب - بهتيم", "164162", "EP-PHS"],
  ["النهضة للادوية-شبين الكوم", "164016", "EP-PHS"],
  ["مالتى ستورز - الهرم", "164345", "EP-PHS"],
  ["فيوتشر - الزقازيق", "163044", "EP-PHS"],
  ["هاحر والشروق  - طنطا", "163906", "EP-PHS"],
];

/** Real production customers the seven stems must NOT reach. He has ruled on none of them. */
const MUST_STAY_PHARMACY: ReadonlyArray<readonly [string, string, string]> = [
  // 22,599.00 EGP. Bare «الفرسان» — the name he did NOT rule on.
  ["الفرسان", "0001533141", "PS"],
  // 3,637,392.75 EGP, and the loudest reason the Zawya stem is written in full: it is 600 times the
  // account he ruled, at the same distributor, and a stem of «الفرسان» would have swept it in.
  ["الفرسان جروب - بنها", "163700", "EP-PHS"],
];

export function runEpdaPediaWarehouseRulingsTests() {
  // 1. Each ruling reaches the classifier, and the account it was made about.
  for (const [name, code, distributor] of RULED_WAREHOUSES) {
    assert.equal(
      classifyCustomerChannel(name, code, distributor),
      "store",
      `${name} is a warehouse by the owner's 2026-09-07 ruling`,
    );
  }

  // 2. The neighbours stay where they are.
  for (const [name, code, distributor] of MUST_STAY_PHARMACY) {
    assert.equal(
      classifyCustomerChannel(name, code, distributor),
      "pharmacy",
      `${name} was never ruled on and must not be swept in by a neighbour's stem`,
    );
  }

  // 3. The rulings reach August Pedia — the month he was reading, which is not published — and stop
  //    at every month judged by the older rule. A name ruling is invisible to the legacy path by
  //    construction, which is what keeps a published month reproducible.
  const [zawya, zawyaCode, zawyaDistributor] = RULED_WAREHOUSES[0];
  assert.equal(
    isStoreCustomerForPeriod(zawya, zawyaCode, zawyaDistributor, "2026-08", "Pedia"),
    true,
    "August Pedia takes the ruling — its cutover is 2026-08",
  );
  assert.equal(
    isStoreCustomerForPeriod(zawya, zawyaCode, zawyaDistributor, "2026-08", "Anti Infective"),
    false,
    "August Anti Infective does NOT — it is published and locked, and its cutover is 2026-09",
  );
  assert.equal(
    isStoreCustomerForPeriod(zawya, zawyaCode, zawyaDistributor, "2026-07", "Pedia"),
    false,
    "July Pedia does not move either",
  );
  assert.equal(
    isStoreCustomerForPeriod(zawya, zawyaCode, zawyaDistributor, "2026-09", "Anti Infective"),
    true,
    "and September, past every cutover, takes it on any line",
  );

  // 4. The legacy rule stays genuinely the old one. If a name ruling ever leaked into it, every
  //    month before the cutover would silently restate.
  for (const [name, code, distributor] of RULED_WAREHOUSES) {
    assert.equal(
      legacyIsStoreCustomer(name, code, distributor),
      false,
      `${name} must be invisible to the pre-2026-09-06 rule`,
    );
  }
}
