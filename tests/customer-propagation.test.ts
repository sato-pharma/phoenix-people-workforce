import assert from "node:assert/strict";

import {
  buildPropagationIndex,
  propagateSuggestions,
  type MappedCustomerRow,
} from "../src/lib/sales/normalizer/customer-propagate.ts";

function mapped(overrides: Partial<MappedCustomerRow>): MappedCustomerRow {
  return {
    address: "",
    brickId: "BR100",
    customerCode: "C-1",
    customerName: "",
    distributorCode: "PS",
    ...overrides,
  };
}

export function runCustomerPropagationTests() {
  // Exact normalized-name propagation across distributors, respelling included.
  const index1 = buildPropagationIndex([
    mapped({ brickId: "BR200", customerCode: "1502731", customerName: "صيدلية د/ أحمد عبد الرحمن", distributorCode: "PS" }),
  ]);
  const hit = propagateSuggestions(
    [{ raw: "SF-99", rawName: "صيدليه دكتور احمد عبد الرحمن" }],
    index1,
  );
  assert.equal(hit.length, 1);
  assert.equal(hit[0].code, "BR200");
  assert.equal(hit[0].confidence, 90);
  assert.equal(hit[0].source, "propagated");
  assert.equal(hit[0].matchedFrom.distributorCode, "PS");
  assert.equal(hit[0].matchedFrom.customerCode, "1502731");

  // Address overlap boost → 93.
  const index2 = buildPropagationIndex([
    mapped({ address: "شارع الجمهورية أمام المستشفى العام المنصورة", brickId: "BR300", customerName: "صيدلية النور الكبرى" }),
  ]);
  const boosted = propagateSuggestions(
    [{ raw: "X-1", rawAddress: "ش الجمهوريه امام المستشفي العام المنصوره", rawName: "صيدليه النور الكبري" }],
    index2,
  );
  assert.equal(boosted.length, 1);
  assert.equal(boosted[0].confidence, 93);

  // Ambiguity suppression: same name mapped to two DIFFERENT bricks → no suggestion.
  const index3 = buildPropagationIndex([
    mapped({ brickId: "BR100", customerName: "صيدلية الشفاء الجديدة", distributorCode: "PS" }),
    mapped({ brickId: "BR999", customerName: "صيدلية الشفاء الجديدة", distributorCode: "SF" }),
  ]);
  assert.equal(propagateSuggestions([{ raw: "Y-1", rawName: "صيدلية الشفاء الجديدة" }], index3).length, 0);

  // Same name mapped twice to the SAME brick → still propagates.
  const index4 = buildPropagationIndex([
    mapped({ brickId: "BR100", customerName: "صيدلية الشفاء الجديدة", distributorCode: "PS" }),
    mapped({ brickId: "BR100", customerName: "صيدلية الشفاء الجديدة", distributorCode: "SF" }),
  ]);
  assert.equal(propagateSuggestions([{ raw: "Y-2", rawName: "صيدليه الشفاء الجديده" }], index4).length, 1);

  // Chain branch discrimination: العزبي المنصورة does NOT propagate from العزبي أسيوط.
  const index5 = buildPropagationIndex([
    mapped({ brickId: "BR400", customerName: "صيدلية العزبي أسيوط" }),
  ]);
  assert.equal(propagateSuggestions([{ raw: "Z-1", rawName: "العزبي المنصورة" }], index5).length, 0);

  // Chain same branch → propagates.
  const index6 = buildPropagationIndex([
    mapped({ brickId: "BR500", customerName: "صيدلية العزبي المنصورة" }),
  ]);
  const chainHit = propagateSuggestions([{ raw: "Z-2", rawName: "العزبي المنصوره" }], index6);
  assert.equal(chainHit.length, 1);
  assert.equal(chainHit[0].code, "BR500");

  // Unbranched chain unknown never matches — could be any branch.
  assert.equal(propagateSuggestions([{ raw: "Z-3", rawName: "العزبي" }], index6).length, 0);

  // Single-token generic names are never indexed or propagated.
  const index7 = buildPropagationIndex([mapped({ brickId: "BR600", customerName: "صيدلية النور" })]);
  assert.equal(propagateSuggestions([{ raw: "G-1", rawName: "صيدلية النور" }], index7).length, 0);

  // Rows without a brick or name never index.
  const index8 = buildPropagationIndex([
    mapped({ brickId: "", customerName: "صيدلية الأمل الجديدة" }),
    mapped({ brickId: "BR700", customerName: "" }),
  ]);
  assert.equal(index8.byNameKey.size, 0);
  assert.equal(index8.byChainBranch.size, 0);
}
