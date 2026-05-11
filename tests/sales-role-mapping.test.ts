import assert from "node:assert/strict";

import { salesRoleOverrideForHrId } from "../src/lib/sales/role-mapping.ts";

export function runSalesRoleMappingTests() {
  assert.equal(salesRoleOverrideForHrId("B-1"), "MR_DSM");
  assert.equal(salesRoleOverrideForHrId(" b-1 "), "MR_DSM");
  assert.equal(salesRoleOverrideForHrId("B-187"), null);
  assert.equal(salesRoleOverrideForHrId("B-101"), null);
}
