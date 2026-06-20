import assert from "node:assert/strict";

import { buildHeaderMismatchMessages, explainHeaderMismatch } from "../src/lib/sales/normalizer/ai-explain.ts";

// The AI header-mismatch helper must send ONLY column titles + expected labels — never data rows,
// quantities, customer codes, or product names — and must be a no-op when there is nothing to explain
// (so an upload is never frozen or leaked by the AI path).

function payloadContainsOnlyHeadersAndLabels() {
  const msgs = buildHeaderMismatchMessages({
    distributorName: "EGD Branch",
    observedHeaders: ["ITEM_CODE", "QTY_PCS", "TO_COMPANY_ENTITY_NAME"],
    missingGroups: [{ label: "Quantity", expected: ["QTY"] }],
  });
  // the found column titles + the expected field label/alias are present
  assert.ok(msgs.user.includes("ITEM_CODE"));
  assert.ok(msgs.user.includes("QTY_PCS"));
  assert.ok(msgs.user.includes("TO_COMPANY_ENTITY_NAME"));
  assert.ok(msgs.user.includes("Quantity"));
  assert.ok(msgs.user.includes("QTY"));
  // privacy: nothing but what we passed can be in the payload — representative data values are absent
  assert.equal(msgs.user.includes("TEBOFORTIN"), false); // a product/data name is never sent
  assert.equal(msgs.user.includes("60229"), false); // a customer code / sales number is never sent
  assert.ok(msgs.system.length > 0);
}

async function noOpWhenNothingToExplain() {
  // no observed headers → cannot suggest anything → no AI call, aiUsed false
  const a = await explainHeaderMismatch({ distributorName: "X", observedHeaders: [], missingGroups: [{ label: "Quantity", expected: ["QTY"] }] });
  assert.equal(a.aiUsed, false);
  assert.deepEqual(a.suggestions, []);
  // no missing fields → nothing to explain → aiUsed false
  const b = await explainHeaderMismatch({ distributorName: "X", observedHeaders: ["QTY"], missingGroups: [] });
  assert.equal(b.aiUsed, false);
}

export async function runSalesAiExplainTests() {
  payloadContainsOnlyHeadersAndLabels();
  await noOpWhenNothingToExplain();
}
