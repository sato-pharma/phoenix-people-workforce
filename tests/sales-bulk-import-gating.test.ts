import assert from "node:assert/strict";

import { isBulkSlotBlocking, type BulkSlotStage } from "../src/lib/sales/bulk-import-gating.ts";

export function runSalesBulkImportGatingTests() {
  // Opening a distributor card (touching it) but never picking a file must NOT block "Confirm &
  // Import All" — the whole point of the fix (PR #1427 only added a manual "Remove" escape hatch;
  // it never stopped a merely-opened, empty card from blocking on its own).
  assert.equal(isBulkSlotBlocking("idle"), false, "idle (opened, no file picked) must not block");
  assert.equal(isBulkSlotBlocking(undefined), false, "no status reported yet must not block");

  // A file mid-validation, or one that failed validation, is real in-flight state the operator must
  // resolve or explicitly remove — these still block.
  assert.equal(isBulkSlotBlocking("working"), true, "a file still validating must block");
  assert.equal(isBulkSlotBlocking("rejected"), true, "a file that failed validation must block");

  // Terminal/ready stages never block (ready → committable; committed/commit_failed are past commit).
  for (const stage of ["ready", "committed", "commit_failed"] as BulkSlotStage[]) {
    assert.equal(isBulkSlotBlocking(stage), false, `${stage} must not block`);
  }
}
