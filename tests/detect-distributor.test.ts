import assert from "node:assert/strict";

import { detectDistributor, type DetectionProfile } from "../src/lib/sales/normalizer/detect-distributor.ts";

// Two profiles that share generic required headers (product/qty/customer) but differ on the
// distributor-specific optional aliases (address columns), so a tie breaks on the optional match.
const PS: DetectionProfile = {
  distributorCode: "PS",
  distributorName: "overseas",
  requiredGroups: [["Mat. Code", "Mat. Desc."], ["Qty"], ["Customer"]],
  optionalGroups: [["Customer Name"], ["Customer Address"], ["Value"], ["Discount%"], ["Invoice Date"]],
};
const IS: DetectionProfile = {
  distributorCode: "IS",
  distributorName: "Ibn sina",
  requiredGroups: [["Item Code", "Item Name"], ["Quantity", "Total Quantity"], ["Client Code", "Main Customer Code"]],
  optionalGroups: [["Client Name"], ["Address_En", "Address_Ar"], ["Net"], ["Discount%"], ["Date"]],
};

export function runDetectDistributorTests() {
  // 1) A clean PS header row → PS detected with high confidence.
  {
    const headers = ["Mat. Code", "Mat. Desc.", "Qty", "Value", "Invoice Date", "Customer", "Customer Name", "Customer Address", "Discount%"];
    const result = detectDistributor(headers, [PS, IS]);
    assert.equal(result.best?.distributorCode, "PS", "PS detected");
    assert.equal(result.confidence, "high", "confident");
    assert.equal(result.ambiguous, false);
    assert.equal(result.best?.matchedRequired, 3, "all required groups matched");
  }

  // 2) A clean IS header row → IS detected (different required + optional aliases).
  {
    const headers = ["Item Code", "Item Name", "Total Quantity", "Net", "Date", "Client Code", "Client Name", "Address_En", "Discount%"];
    const result = detectDistributor(headers, [PS, IS]);
    assert.equal(result.best?.distributorCode, "IS", "IS detected");
    assert.equal(result.confidence, "high");
  }

  // 3) Header matching is case/space-insensitive.
  {
    const headers = ["  mat. code ", "QTY", "customer"];
    const result = detectDistributor(headers, [PS, IS]);
    assert.equal(result.best?.distributorCode, "PS", "normalized match");
    assert.equal(result.best?.matchedRequired, 3);
  }

  // 4) Missing a required group (no customer column) → not a candidate → none detected.
  {
    const headers = ["Mat. Code", "Qty", "Value"]; // no Customer
    const result = detectDistributor(headers, [PS]);
    assert.equal(result.confidence, "none", "incomplete required groups");
    assert.equal(result.best, null);
    assert.equal(result.matches.length, 0);
  }

  // 5) Two profiles fully satisfied with identical scores → ambiguous, no auto-pick.
  {
    const A: DetectionProfile = {
      distributorCode: "A", distributorName: "A",
      requiredGroups: [["Code"], ["Qty"], ["Cust"]], optionalGroups: [["Shared"]],
    };
    const B: DetectionProfile = {
      distributorCode: "B", distributorName: "B",
      requiredGroups: [["Code"], ["Qty"], ["Cust"]], optionalGroups: [["Shared"]],
    };
    const result = detectDistributor(["Code", "Qty", "Cust", "Shared"], [A, B]);
    assert.equal(result.ambiguous, true, "tie is ambiguous");
    assert.equal(result.best, null, "no auto-pick on a tie");
    assert.equal(result.confidence, "low");
    assert.equal(result.matches.length, 2, "both candidates surfaced");
  }

  // 6) Both required, but one has more optional matches → that one wins with high confidence.
  {
    const headers = ["Item Code", "Total Quantity", "Client Code", "Client Name", "Address_En", "Net"];
    const result = detectDistributor(headers, [PS, IS]);
    assert.equal(result.best?.distributorCode, "IS", "IS wins on optional matches");
    assert.equal(result.confidence, "high");
    assert.ok((result.best?.matchedOptional ?? 0) >= 3, "optional aliases counted");
  }
}
