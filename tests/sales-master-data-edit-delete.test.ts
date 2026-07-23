import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Database Mapping (/sales/database-mapping) gained per-row Edit and Delete (soft
// deactivate/reactivate) alongside the existing Add-row and bulk-import flows. Like the rest of
// this master-data surface these functions are DB-backed (Supabase service role) and not directly
// unit-testable without a live/mocked client, so — matching sales-master-data-pagination.test.ts —
// this is a source-text regression test.
export function runSalesMasterDataEditDeleteTests() {
  const serviceSource = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");

  // A shared parent-FK-resolution helper exists and is reused by both single-row mutators, instead
  // of a third copy of the cascade logic (block_code -> area_code/region_code, etc.) drifting in.
  assert.match(
    serviceSource,
    /function resolveParentValues\(\s*def: MasterDefinition,\s*effective: Record<string, string>,\s*parentMaps: Map<MasterKey, Map<string, Record<string, unknown>>>,\s*\)/,
    "a shared resolveParentValues helper exists",
  );
  assert.match(
    serviceSource,
    /export async function addSingleMasterRow\([\s\S]*?resolveParentValues\(def, input\.row, parentMaps\)/,
    "addSingleMasterRow resolves parents through the shared helper",
  );
  assert.doesNotMatch(
    serviceSource.slice(serviceSource.indexOf("export async function addSingleMasterRow")),
    /const parentValues: Record<string, string \| null> = \{\};\s*for \(const parent of def\.parents\)/,
    "addSingleMasterRow no longer duplicates the inline parent-resolution loop",
  );

  // updateSingleMasterRow: edits editable columns only, re-validates + re-cascades parents, and
  // refuses when the master has none (add-only masters like distributors).
  assert.match(
    serviceSource,
    /export async function updateSingleMasterRow\(input: \{\s*actorLoginId: string;\s*master: MasterKey;\s*key: string;\s*patch: Record<string, string>;\s*\}\)/,
    "updateSingleMasterRow has the expected signature",
  );
  assert.match(
    serviceSource,
    /if \(editable\.length === 0\) \{\s*return \{ success: false, error: `\$\{def\.label\} has no editable columns \(add-only master\)\.` \};/,
    "updateSingleMasterRow refuses to edit an add-only master",
  );
  assert.match(
    serviceSource,
    /resolveParentValues\(def, effective, parentMaps\)/,
    "updateSingleMasterRow re-resolves parent FKs from the post-edit effective row",
  );
  assert.match(
    serviceSource,
    /def\.master === "products" && Object\.prototype\.hasOwnProperty\.call\(updatePayload, "factory_price"\)[\s\S]{0,120}phx_recompute_weekly_sales_value/,
    "editing a product's factory_price resyncs stored weekly-sales value, same as bulk import",
  );

  // setMasterRowActive: the soft-delete/reactivate toggle, with a guard for the code-defined system
  // distributor channels (Direct, tender channels, ...) that sales imports depend on.
  assert.match(
    serviceSource,
    /export async function setMasterRowActive\(input: \{\s*actorLoginId: string;\s*master: MasterKey;\s*key: string;\s*active: boolean;\s*\}\)/,
    "setMasterRowActive has the expected signature",
  );
  assert.match(
    serviceSource,
    /SYSTEM_DISTRIBUTORS\.some\(\(channel\) => channel\.distributor_code\.toLowerCase\(\) === key\.toLowerCase\(\)\)/,
    "setMasterRowActive checks the row against the system-distributor list before deactivating",
  );
  assert.match(
    serviceSource,
    /is a system channel required for sales imports and cannot be deactivated/,
    "deactivating a system distributor is blocked with a clear error",
  );
  assert.match(
    serviceSource,
    /\.update\(\{ active: input\.active, updated_at: new Date\(\)\.toISOString\(\) \}\)/,
    "setMasterRowActive only flips the active flag, never issues a real DELETE",
  );
  const setActiveBody = serviceSource.slice(
    serviceSource.indexOf("export async function setMasterRowActive"),
    serviceSource.indexOf("export async function relocateBrick"),
  );
  assert.doesNotMatch(
    setActiveBody,
    /\.delete\(\)/,
    "setMasterRowActive never issues a real row DELETE (relocateBrick's compensating rollback is a separate, narrow exception — see sales-brick-relocate.test.ts)",
  );

  const routeSource = readFileSync("app/api/sales/database-mapping/[master]/[key]/route.ts", "utf8");
  assert.match(routeSource, /export async function PATCH\(/, "the single-row route exports PATCH");
  assert.match(routeSource, /export async function DELETE\(/, "the single-row route exports DELETE");
  assert.match(routeSource, /resolveAccessContext\(request\)/, "the route resolves an authenticated session");
  assert.match(
    routeSource,
    /assertPermission\(access, "sales", "update"\)/,
    "PATCH requires the sales:update permission",
  );
  assert.match(
    routeSource,
    /assertPermission\(access, "sales", "delete"\)/,
    "DELETE requires the sales:delete permission",
  );
  assert.match(routeSource, /updateSingleMasterRow\(/, "PATCH delegates edits to updateSingleMasterRow");
  assert.match(routeSource, /setMasterRowActive\(/, "the route delegates active-flag changes to setMasterRowActive");

  const uiSource = readFileSync("src/components/sales/database-mapping-workspace.tsx", "utf8");
  assert.match(uiSource, /function handleSaveEdit\(rowKey: string\)/, "the workspace has a save-edit handler");
  assert.match(uiSource, /function handleSetActive\(rowKey: string, active: boolean\)/, "the workspace has a delete/reactivate handler");
  assert.match(
    uiSource,
    /setConfirmDeleteKey\(rowKey\)/,
    "deactivating a row requires an inline confirm step, not a one-click destructive action",
  );
  assert.match(
    uiSource,
    /\.filter\(\(row\) => row\.active !== false\)/,
    "parent pickers (Add + Edit) only offer active parents, so a row can't be re-parented onto a deactivated one",
  );
}
