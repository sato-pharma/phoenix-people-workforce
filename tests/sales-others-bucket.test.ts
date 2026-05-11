import assert from "node:assert/strict";

import { isSalesOthersBucket } from "../src/lib/sales/others.ts";

export function runSalesOthersBucketTests() {
  assert.equal(isSalesOthersBucket({ employeeHrId: "O-1", line: "Pedia" }), true);
  assert.equal(isSalesOthersBucket({ employeeHrId: "O-2", line: "Anti Infective" }), true);
  assert.equal(isSalesOthersBucket({ employeeHrId: "O-3", line: "CNS" }), true);
  assert.equal(isSalesOthersBucket({ employeeName: "Others", line: "Anti Infective" }), true);
  assert.equal(isSalesOthersBucket({ employeeLookupKey: "Other", line: "Pedia" }), true);

  assert.equal(isSalesOthersBucket({ employeeHrId: "B-101", employeeName: "Other", line: "Unknown" }), false);
  assert.equal(isSalesOthersBucket({ employeeHrId: "B-101", line: "Anti Infective" }), false);
}
