import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Moving a brick to a different block goes through relocateBrick (new "{block}-{n}" id + deactivate
// the old row) instead of updateSingleMasterRow's plain in-place PATCH — owner preference
// (2026-07-23): this dataset's brick IDs consistently encode their block as a display convention
// (verified 100% consistent across all 439 live production bricks), so a move should keep a new
// brick's ID matching its new block rather than leave a stale-looking prefix. Like the rest of this
// surface this is DB-backed and not directly unit-testable without a live/mocked Supabase client, so
// this is a source-text regression test (matches sales-master-data-pagination.test.ts's convention).
export function runSalesBrickRelocateTests() {
  const serviceSource = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");

  assert.match(
    serviceSource,
    /export async function relocateBrick\(input: \{\s*actorLoginId: string;\s*brickId: string;\s*newBlockCode: string;\s*\}\)/,
    "relocateBrick has the expected signature",
  );
  assert.match(
    serviceSource,
    /if \(existing\.active === false\) \{\s*return \{ success: false, error: `Brick "\$\{brickId\}" is inactive/,
    "relocateBrick refuses to move an already-inactive brick",
  );
  assert.match(
    serviceSource,
    /if \(currentBlockCode === newBlockCode\) \{\s*return \{ success: false, error: `"\$\{brickId\}" is already in block/,
    "relocateBrick no-ops with a clear error when the target block is unchanged",
  );
  assert.match(
    serviceSource,
    /if \(block\.active === false\) \{\s*return \{ success: false, error: `Block "\$\{newBlockCode\}" is inactive/,
    "relocateBrick refuses to move a brick into an inactive block",
  );
  assert.match(
    serviceSource,
    /const newBrickId = `\$\{prefix\}\$\{nextSeq\}`/,
    "relocateBrick allocates the new id from the target block's existing siblings",
  );
  assert.match(
    serviceSource,
    /brick_name: existing\.brick_name,[\s\S]{0,120}region_code: normalizeCode\(block\.region_code\)/,
    "the new brick copies the old brick's name and takes area/region from the new block",
  );
  assert.match(
    serviceSource,
    /if \(deactivateError\) \{[\s\S]{0,200}\.delete\(\)\.eq\(def\.keyColumn, newBrickId\)/,
    "a failed deactivate compensates by deleting the just-created new row, instead of leaving two active bricks for one territory",
  );
  const relocateBody = serviceSource.slice(serviceSource.indexOf("export async function relocateBrick"));
  assert.equal(
    (relocateBody.match(/writeAuditLog\(/g) ?? []).length,
    2,
    "relocateBrick audits both the deactivated old brick and the newly created one",
  );

  const routeSource = readFileSync("app/api/sales/database-mapping/bricks/[key]/relocate/route.ts", "utf8");
  assert.match(routeSource, /export async function POST\(/, "the relocate route exports POST");
  assert.match(routeSource, /resolveAccessContext\(request\)/, "the route resolves an authenticated session");
  assert.match(
    routeSource,
    /assertPermission\(access, "sales", "update"\)/,
    "relocating requires the sales:update permission — same tier as a plain edit",
  );
  assert.match(routeSource, /relocateBrick\(\{ actorLoginId, brickId: key, newBlockCode: body\.newBlockCode \}\)/, "the route delegates to relocateBrick");

  const uiSource = readFileSync("src/components/sales/database-mapping-workspace.tsx", "utf8");
  assert.match(
    uiSource,
    /const isBrickRelocate = def\.master === "bricks";/,
    "the workspace routes a brick's Save-edit action through the relocate flow",
  );
  assert.match(
    uiSource,
    /`\/api\/sales\/database-mapping\/bricks\/\$\{encodeURIComponent\(rowKey\)\}\/relocate`/,
    "brick edits POST to the relocate endpoint instead of PATCHing the row in place",
  );
}
