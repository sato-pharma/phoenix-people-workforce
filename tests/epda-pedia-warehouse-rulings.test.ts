import assert from "node:assert/strict";

import {
  classifyCustomerChannel,
  isStoreCustomerForPeriod,
  legacyIsStoreCustomer,
} from "../src/lib/sales/customer-channel.ts";

/**
 * The owner read the EPDA Pedia August 2026 list on 2026-09-07 and ruled seven more customers
 * warehouses, then an eighth — «الفرسان جروب - بنها» — when the measurement below surfaced it. None
 * carries a store word, the «م - » prefix or the trade phrase, so each is named.
 *
 * The reason this file exists is the neighbours, not the eight. `STORE_OVERRIDE_NAMES` is the one
 * list that can CREATE a warehouse from a name — `PHARMACY_OVERRIDE_CHAINS` can only ever refuse
 * one — so an over-wide stem here does not merely mislabel a customer, it deals its sales out across
 * a city and moves money between reps, with no error and nothing downstream reporting it (the split
 * preserves each line's unit total, and the publication drift check compares units).
 *
 * Measured on production before the stems were written: bare «الفرسان» matches NINE customers worth
 * 15,615,203.94 EGP across five businesses. The owner has ruled on two of them, and both stems are
 * written long enough to reach only those two.
 */

const RULED_WAREHOUSES: ReadonlyArray<readonly [string, string, string]> = [
  ["الفرسان - الزاوية", "162956", "EP-PHS"],
  ["الصفا ميديكال م.نصر", "164266", "EP-PHS"],
  ["النهضة للادوية-شبين الكوم", "164016", "EP-PHS"],
  ["مالتى ستورز - الهرم", "164345", "EP-PHS"],
  ["فيوتشر - الزقازيق", "163044", "EP-PHS"],
  ["هاحر والشروق  - طنطا", "163906", "EP-PHS"],
  // Ruled the same day, after the measurement below surfaced it: its siblings were already
  // warehouses through El Qema and this account was the odd one out. All Head Office value, so it
  // moves nothing today — it decides the first rep-line sale it ever makes.
  ["الفرسان جروب - بنها", "163700", "EP-PHS"],
  ["الفرسان جروب - بنها", "163700", "EP-BK"],
];

/** Real production customers these stems must NOT reach. He has ruled on none of them. */
const MUST_STAY_PHARMACY: ReadonlyArray<readonly [string, string, string]> = [
  // 22,599.00 EGP. Bare «الفرسان» — the name he has still not ruled on, and the reason both
  // الفرسان stems are written long. A stem of «الفرسان» would adopt it silently.
  ["الفرسان", "0001533141", "PS"],
  // Ruled a wholesaler on the EPDA sheet on 2026-09-07 and a PHARMACY in the 167-customer sheet on
  // 2026-09-06. Until he says which answer stands it keeps the earlier one, because that is the one
  // already pinned — and because a contradiction resolved quietly is a number nobody can explain.
  ["شركة اورينت جروب - بهتيم", "164162", "EP-PHS"],
  // A pharmacy by DEFAULT, not by any ruling — it carries «شركه» without the definite article, so
  // it misses the «الشركة» keyword. Kept as a negative because it carries «جروب»: proof that neither
  // «الفرسان جروب» nor «اورينت جروب» reaches every customer with that word in its name.
  ["شركه ايه ام جروب", "999100", "PS"],
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
