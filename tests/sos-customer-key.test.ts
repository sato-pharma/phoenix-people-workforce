import assert from "node:assert/strict";

import { customerKey, savedCustomerKeys } from "../src/lib/sales/customer-key.ts";

// Regression guard for the cross-distributor collision bug: the SAME customerCode under two
// distributors must produce two distinct identities, and accept-result reconciliation must mark
// exactly the saved (distributor, customer) pair — never its cross-distributor twin.
export function runSosCustomerKeyTests() {
  // Composite identity — same customerCode, different distributor → different key.
  assert.equal(customerKey("PS", "C100"), "PS|C100");
  assert.notEqual(customerKey("PS", "C100"), customerKey("IS", "C100"));

  // Reconciliation: two rows share customerCode "C100" across PS and IS; only PS succeeded.
  const results = [
    { distributorCode: "PS", customerCode: "C100", ok: true },
    { distributorCode: "IS", customerCode: "C100", ok: false },
  ];
  const saved = savedCustomerKeys(results);
  assert.deepEqual(saved, ["PS|C100"]);
  assert.ok(saved.includes(customerKey("PS", "C100")));
  // The IS twin must NOT be marked saved even though it shares the customerCode.
  assert.ok(!saved.includes(customerKey("IS", "C100")));

  // All-ok across distributors → both composite keys returned, deduped by identity.
  const bothOk = savedCustomerKeys([
    { distributorCode: "PS", customerCode: "C100", ok: true },
    { distributorCode: "IS", customerCode: "C100", ok: true },
  ]);
  assert.equal(bothOk.length, 2);
  assert.deepEqual([...bothOk].sort(), ["IS|C100", "PS|C100"]);
}
