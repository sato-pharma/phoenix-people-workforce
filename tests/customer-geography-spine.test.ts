import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CUSTOMER_GEOGRAPHY_CHUNK_SIZE,
  customerGeographyKey,
  selectExactPairGeography,
} from "../src/lib/sales/customer-geography.ts";

// The PLACE half of the system spine. Until this module existed the only resolver was
// `resolveCustomerCodeGeography`, private inside src/lib/direct-orders/service.ts, so no other
// domain could ask the customer map what territory a code sits in without writing the query again.
//
// It also carried a bug that the file's OWN comments describe two functions further down:
// PostgREST's two `.in()` filters are INDEPENDENT, so `.in(distributor, [PS, IBN])` with
// `.in(customer, [111, 222])` also matches PS/222 and IBN/111 — pairs nobody asked about.
// Measured on production 2026-09-03: 54 pairs asked, 45 rows wanted, 53 rows returned.
//
// At today's size the phantom rows are harmless, because they land under keys nobody looks up. The
// danger is growth: the over-match grows as distributors x codes while the wanted set grows
// linearly, and PostgREST caps every response at 1000 rows WITH NO MARKER. Past that cap a real
// pair is dropped and its geography reads null — which looks like "this pharmacy has no territory"
// rather than like a query that got cut off.

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/customer-geography.ts", import.meta.url)),
  "utf8",
);

const DIRECT_ORDER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/service.ts", import.meta.url)),
  "utf8",
);

export function runCustomerGeographySpineTests() {
  // 1. Both sides of a lookup agree, whitespace included. The map stores trimmed codes; an
  // untrimmed caller must not silently miss.
  assert.equal(customerGeographyKey(" PS ", " 111 "), "PS::111", "the key must trim both halves");
  assert.equal(customerGeographyKey(null, undefined), "::", "a null pair must still produce a stable key");

  // 2 and 3. THE HEADLINE. Ask for two pairs; hand back the four rows the two independent `.in()`
  // filters would actually return. Only the asked pairs may resolve — a phantom pair here would
  // attach one customer's territory to a different customer's code.
  const asked = [
    { customerCode: "111", distributorCode: "PS" },
    { customerCode: "222", distributorCode: "IBN" },
  ];
  const rowsTheInFiltersReturn = [
    { area_code: "GZ3", brick_id: "b-1", customer_code: "111", distributor_code: "PS", region_code: "GIZ" },
    { area_code: "CA1", brick_id: "b-2", customer_code: "222", distributor_code: "IBN", region_code: "CAI" },
    // The two nobody asked for.
    { area_code: "WRONG-A", brick_id: "b-3", customer_code: "222", distributor_code: "PS", region_code: "WRONG-R" },
    { area_code: "WRONG-A", brick_id: "b-4", customer_code: "111", distributor_code: "IBN", region_code: "WRONG-R" },
  ];

  const resolved = selectExactPairGeography(asked, rowsTheInFiltersReturn);
  assert.equal(resolved.size, 2, "only the pairs actually asked for may resolve");
  assert.equal(resolved.get("PS::111")?.areaCode, "GZ3", "an asked pair must resolve to its own territory");
  assert.equal(resolved.get("IBN::222")?.areaCode, "CA1", "an asked pair must resolve to its own territory");
  assert.equal(
    resolved.has("PS::222"),
    false,
    "a cross-pair row the two independent .in() filters return must never be kept",
  );
  assert.equal(resolved.has("IBN::111"), false, "a cross-pair row must never be kept");

  // 4. An unmapped pair is ABSENT, never a row of nulls — so a caller can tell "the customer map
  // does not know this code" from "it maps to nothing", which are different problems.
  const unmapped = selectExactPairGeography([{ customerCode: "999", distributorCode: "PS" }], []);
  assert.equal(unmapped.has("PS::999"), false, "an unmapped pair must be absent, not null-filled");

  // 5. Paged with the KEYSET pager, not an offset walk and not an unpaged select. src/lib/supabase/
  // paginated.ts records an offset walk losing 1,262 of 49,713 customer mappings, and names the
  // customer map as a table read while imports write to it.
  assert.match(
    MODULE_SOURCE,
    /fetchAllRowsKeyset</,
    "the resolver must page with the keyset pager so the 1000-row cap cannot truncate it silently",
  );

  // 6. An `.in()` carrying several hundred values returns ZERO rows and no error, so the pairs are
  // chunked. The size is the guard, not the intent.
  assert.ok(
    CUSTOMER_GEOGRAPHY_CHUNK_SIZE > 0 && CUSTOMER_GEOGRAPHY_CHUNK_SIZE <= 50,
    "pairs must be chunked small enough that a large .in() cannot return zero rows",
  );

  // 7. Direct orders must DELEGATE. If it goes back to querying the customer map itself inside that
  // resolver, the spine has one authority and one bypass, which is worse than having neither.
  assert.match(
    DIRECT_ORDER_SOURCE,
    /await resolveCustomerGeography\(/,
    "direct-orders must resolve territory through the shared resolver",
  );
}
