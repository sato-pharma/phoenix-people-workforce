import assert from "node:assert/strict";

import { CUSTOMER_MAP_PAGE_MAX, clampPageParams } from "../src/lib/sales/normalizer/customer-map.ts";

// The customer map can hold 21k+ rows per distributor; the page endpoint must never let the UI
// pull an unbounded slice. clampPageParams enforces safe defaults + a hard cap.
function clampDefaultsAndBounds() {
  assert.deepEqual(clampPageParams({}), { limit: 50, offset: 0 }, "defaults");
  assert.deepEqual(clampPageParams({ limit: 25, offset: 100 }), { limit: 25, offset: 100 });
  assert.equal(clampPageParams({ limit: 9999 }).limit, CUSTOMER_MAP_PAGE_MAX, "limit is capped");
  assert.equal(clampPageParams({ limit: 0 }).limit, 50, "non-positive limit falls back to default");
  assert.equal(clampPageParams({ limit: -5 }).limit, 50);
  assert.equal(clampPageParams({ offset: -10 }).offset, 0, "negative offset clamps to 0");
  assert.equal(clampPageParams({ limit: 33.9 }).limit, 33, "limit is floored");
  assert.equal(clampPageParams({ offset: 12.7 }).offset, 12, "offset is floored");
}

export function runSalesMappingDatabaseTests() {
  clampDefaultsAndBounds();
}
