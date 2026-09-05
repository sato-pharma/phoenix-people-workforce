import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canAccess, createAccessContext } from "../src/lib/auth/permissions.ts";

// DELETING A SALES MAPPING NEEDS sales:delete — sales:import is not enough.
//
// SoS audit, confirmed. Both mapping-database POST handlers asserted `sales:import` ONCE at the
// top, for every action they serve, and then branched into a delete. The matrix gives
// `sales: ["read", "import", "export"]` to SFE Manager and `allActions` only to Super Admin, so the
// role that operates the import pipeline could destroy mapping rows without ever holding the delete
// grant.
//
// That the two are meant to differ is settled twice in the same module: the sibling route
// app/api/sales/database-mapping/[master]/[key]/route.ts asserts sales:delete for its DELETE, and
// `reconcile-apply`, a few lines below the customer-map delete branch, carries its own Super-Admin
// gate with a comment about blast radius. The author reasoned about exactly this and the delete
// branch was simply missed.
//
// WHY IT MATTERS MORE THAN A PERMISSION TIDY-UP. The customer map is the crosswalk that decides
// which AREA is credited with a sale. Delete a row and every later import row for that customer
// resolves to no brick, so its units fall out of area attribution: the area's Monthly Closing
// under-reports by that customer's whole volume while the company total still counts it. The loss
// is silent — a mapping that was deleted looks exactly like a customer never mapped.

const ROUTES = {
  aliases: "../app/api/sales/mapping-database/aliases/route.ts",
  customerMap: "../app/api/sales/mapping-database/customer-map/route.ts",
} as const;

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function ctx(role: string) {
  return createAccessContext({ hrId: "B-999", role });
}

export async function runMappingDeleteNeedsDeletePermissionTests(): Promise<void> {
  // ── 1. the role behaviour this depends on — asserted, not assumed ──────────────────────────
  const sfe = ctx("SFE Manager");
  assert.equal(
    await canAccess(sfe, "sales", "import"),
    true,
    "SFE Manager holds sales:import — he operates the import pipeline, which is why he reaches " +
      "these handlers at all",
  );
  assert.equal(
    await canAccess(sfe, "sales", "delete"),
    false,
    "SFE Manager must NOT hold sales:delete. If this ever becomes true the fix below stops " +
      "protecting anything, and the change belongs in the matrix with the owner's say-so, not here",
  );

  const superAdmin = ctx("Super Admin");
  assert.equal(
    await canAccess(superAdmin, "sales", "delete"),
    true,
    "Super Admin must keep sales:delete — the fix must not lock the mapping database for everyone",
  );

  // ── 2. both delete paths assert it, BEFORE doing the deleting ──────────────────────────────
  const customerMap = read(ROUTES.customerMap);
  const deleteBranch = customerMap.indexOf('if (body.action === "delete")');
  assert.ok(deleteBranch > 0, "the customer-map delete branch must still exist");
  const assertAt = customerMap.indexOf('assertPermission(access, "sales", "delete")', deleteBranch);
  const deleteCallAt = customerMap.indexOf("deleteCustomerMapRow(", deleteBranch);
  assert.ok(assertAt > 0, "the customer-map delete branch must assert sales:delete");
  assert.ok(
    assertAt < deleteCallAt,
    "the assert must run BEFORE deleteCustomerMapRow — a check after the write is not a check",
  );

  const aliases = read(ROUTES.aliases);
  const aliasAssertAt = aliases.indexOf('assertPermission(access, "sales", "delete")');
  assert.ok(aliasAssertAt > 0, "the aliases route must assert sales:delete for its delete actions");
  for (const call of ["deleteProductAlias(", "deleteTerritoryAlias("]) {
    const callAt = aliases.indexOf(call);
    assert.ok(callAt > 0, `expected ${call} to still exist`);
    assert.ok(
      aliasAssertAt < callAt,
      `the sales:delete assert must run before ${call} — both alias kinds delete a mapping`,
    );
  }
  // Asserted once for any delete action rather than inside each type branch, so a third alias type
  // added later cannot get a delete path that skips the check.
  assert.match(
    aliases,
    /if \(body\.action === "delete"\) \{\s*await assertPermission\(access, "sales", "delete"\);/,
    "the aliases route must gate on the ACTION, so a future alias type inherits the gate",
  );

  // ── 3. the import path must NOT have been tightened ────────────────────────────────────────
  // Over-fixing here would lock out the SFE Manager's normal work — saving a mapping is exactly
  // what sales:import is for, and requiring delete for a save would break the import pipeline.
  for (const [name, source] of [["customer-map", customerMap], ["aliases", aliases]] as const) {
    assert.match(
      source,
      /assertPermission\(access, "sales", "import"\)/,
      `${name} must still assert sales:import for the handler as a whole`,
    );
  }
  const upsertAt = customerMap.indexOf("addCustomerMapRow(");
  assert.ok(upsertAt > 0, "the customer-map upsert must still exist");
  const upsertSlice = customerMap.slice(customerMap.indexOf('if (body.action === "reconcile-apply")'), upsertAt);
  assert.ok(
    !upsertSlice.includes('assertPermission(access, "sales", "delete")'),
    "saving a mapping must NOT require sales:delete — that would break the SFE Manager's normal " +
      "import work, which is the opposite failure",
  );

  // ── 4. the destructive sibling keeps its own Super-Admin gate ──────────────────────────────
  assert.match(
    customerMap,
    /access\.role !== "Super Admin" && access\.scope !== "system"/,
    "reconcile-apply must keep its Super-Admin gate — it rewrites historical reported sales, a " +
      "bigger blast radius than a single mapping delete",
  );
}
