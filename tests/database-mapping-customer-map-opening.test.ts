import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickOpeningCustomerDistributor } from "../src/lib/sales/normalizer/customer-map.ts";

/**
 * Sales → Database Mapping → Distributor Mapping → Customer map opens on a distributor that HAS
 * customers. Measured on production on 2026-09-18: the map opened on the header grid's first
 * distributor, chimipharm, which had 0 active customers, so the map read empty on every visit until
 * someone picked another distributor. EGD had 3,325 and sofico 836. The page now counts each grid
 * distributor's active customers on the server and opens on the first, in grid order, that has any.
 * A count that failed to load is unknown, not zero, and with nothing loaded the map opens where it
 * always did.
 */

const PAGE = "app/(admin)/sales/database-mapping/page.tsx";
const WORKSPACE = "src/components/sales/database-mapping-workspace.tsx";
const VALIDATION = "src/components/sales/database-validation-tab.tsx";

export function runDatabaseMappingCustomerMapOpeningTests() {
  const grid = ["CP", "EG", "SF"];

  // The production shape: chimipharm first with no customers, EGD next with 3,325.
  assert.equal(
    pickOpeningCustomerDistributor(grid, new Map([["CP", 0], ["EG", 3325], ["SF", 836]])),
    "EG",
    "the customer map must open on EGD, the first distributor with customers, not on empty chimipharm",
  );
  // The grid's order decides among distributors with customers; the biggest does not jump ahead.
  assert.equal(pickOpeningCustomerDistributor(grid, new Map([["CP", 12], ["EG", 3325]])), "CP");
  // A count that failed is left out of the map: it is skipped, never taken as having customers.
  assert.equal(pickOpeningCustomerDistributor(grid, new Map([["SF", 836]])), "SF");
  // Nothing loaded, or every distributor empty: the map opens where it always did.
  assert.equal(pickOpeningCustomerDistributor(grid, new Map()), "CP");
  assert.equal(pickOpeningCustomerDistributor(grid, new Map([["CP", 0], ["EG", 0], ["SF", 0]])), "CP");
  assert.equal(pickOpeningCustomerDistributor([], new Map()), "ALL");

  // Wiring: the server picks the opening distributor, and the tab starts there.
  const page = readFileSync(PAGE, "utf8");
  assert.match(
    page,
    /pickOpeningCustomerDistributor\(gridCodes, await countCustomerMapByDistributor\(gridCodes\)\)/,
    `${PAGE}: the opening distributor must come from the live customer counts.`,
  );
  assert.match(page, /initialCustomerDistributor=\{initialCustomerDistributor\}/, `${PAGE}: pass the opening distributor to the workspace.`);
  assert.match(
    readFileSync(WORKSPACE, "utf8"),
    /openingDistributor=\{initialCustomerDistributor\}/,
    `${WORKSPACE}: the Distributor Mapping tab must receive the opening distributor.`,
  );
  const validation = readFileSync(VALIDATION, "utf8");
  assert.match(validation, /useState\(openingDistributor\)/, `${VALIDATION}: the customer map must start on the opening distributor.`);
  assert.ok(
    !validation.includes("useState(distributors[0]?.code"),
    `${VALIDATION}: the customer map is back to opening on the grid's first distributor, whatever its customer count.`,
  );
}
