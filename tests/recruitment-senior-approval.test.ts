import assert from "node:assert/strict";

import { requiresSeniorApproval } from "../src/lib/recruitment/applications.ts";

export function runRecruitmentSeniorApprovalTests() {
  // Strictly above the band requires senior sign-off.
  assert.equal(requiresSeniorApproval(25000, 20000), true);
  assert.equal(requiresSeniorApproval(20000, 20000), false); // exactly at the band is fine
  assert.equal(requiresSeniorApproval(15000, 20000), false);
  assert.equal(requiresSeniorApproval(null, 20000), false);
  assert.equal(requiresSeniorApproval(Number.NaN, 20000), false);
}
