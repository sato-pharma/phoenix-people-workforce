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
  const definitionsSource = readFileSync("src/lib/sales/master-data/definitions.ts", "utf8");

  // brick_name and block description are in-place renames (updateSingleMasterRow's plain PATCH);
  // only block_code (which brick a block's bricks live under) drives the relocate flow above.
  assert.match(
    definitionsSource,
    /\{ key: "brick_name", label: "Brick Name", locked: false, required: true, type: "text" \}/,
    "Brick Name is editable in place (a rename), separate from moving a brick to a new block",
  );
  assert.match(
    definitionsSource,
    /\{ key: "description", label: "Description", locked: false, required: false, type: "text" \}/,
    "Block Description is editable",
  );
  assert.match(
    definitionsSource,
    /derive: \(row\) => \(\{ normalized_description: normalizeKey\(row\.description \?\? ""\) \}\),\s*auditEntityType: "source_of_sales_block"/,
    "the Block Master derives normalized_description from the now-editable description column",
  );

  const serviceSource = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");

  assert.match(
    serviceSource,
    /export async function relocateBrick\(input: \{\s*actorLoginId: string;\s*brickId: string;\s*newBlockCode: string;/,
    "relocateBrick has the expected signature",
  );
  assert.match(
    serviceSource,
    /newBrickName\?: string;\s*\}\): Promise<\{ customersCascaded/,
    "relocateBrick accepts an optional rename to apply atomically with the move",
  );
  assert.match(
    serviceSource,
    /const newBrickName = typeof input\.newBrickName === "string" \? input\.newBrickName\.trim\(\) : "";/,
    "relocateBrick normalizes the optional rename input",
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
    /const effectiveBrickName = newBrickName \|\| String\(existing\.brick_name \?\? ""\);/,
    "an explicit rename wins over the old brick's name; an empty/absent rename falls back to it",
  );
  assert.match(
    serviceSource,
    /brick_name: effectiveBrickName,[\s\S]{0,120}region_code: normalizeCode\(block\.region_code\)/,
    "the new brick takes the effective (possibly renamed) name and area/region from the new block",
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
  assert.match(
    relocateBody,
    /from\("source_of_sales_customer_map"\)\s*\.update\(\{\s*area_code: normalizeCode\(block\.area_code\),\s*brick_id: newBrickId,\s*region_code: normalizeCode\(block\.region_code\),/,
    "relocateBrick cascades the move into source_of_sales_customer_map (brick_id has no FK — every customer still pointing at the old id would silently stop resolving on the next monthly import, since the importer only loads active bricks)",
  );
  assert.match(
    relocateBody,
    /\.eq\("brick_id", brickId\)/,
    "the customer_map cascade is scoped to rows still pointing at the OLD brick id",
  );
  assert.doesNotMatch(
    relocateBody.slice(0, relocateBody.indexOf("source_of_sales_customer_map")),
    /return \{ newBrickId, success: true \}/,
    "the function does not return success before the customer_map cascade runs",
  );

  const routeSource = readFileSync("app/api/sales/database-mapping/bricks/[key]/relocate/route.ts", "utf8");
  assert.match(routeSource, /export async function POST\(/, "the relocate route exports POST");
  assert.match(routeSource, /resolveAccessContext\(request\)/, "the route resolves an authenticated session");
  assert.match(
    routeSource,
    /assertPermission\(access, "sales", "update"\)/,
    "relocating requires the sales:update permission — same tier as a plain edit",
  );
  assert.match(
    routeSource,
    /relocateBrick\(\{\s*actorLoginId,\s*brickId: key,\s*newBlockCode: body\.newBlockCode,\s*newBrickName: typeof body\.brickName === "string" \? body\.brickName : undefined,\s*\}\)/,
    "the route delegates to relocateBrick with the block move and the optional rename",
  );

  const uiSource = readFileSync("src/components/sales/database-mapping-workspace.tsx", "utf8");
  assert.match(
    uiSource,
    /const isBrickRelocate = def\.master === "bricks" && \(editValues\.block_code \?\? ""\) !== originalBlockCode;/,
    "the workspace only treats a brick edit as a relocate when block_code actually changed — a pure rename stays a plain PATCH",
  );
  assert.match(
    uiSource,
    /`\/api\/sales\/database-mapping\/bricks\/\$\{encodeURIComponent\(rowKey\)\}\/relocate`/,
    "brick edits POST to the relocate endpoint instead of PATCHing the row in place",
  );
  assert.match(
    uiSource,
    /JSON\.stringify\(\{ brickName: editValues\.brick_name, newBlockCode: editValues\.block_code \}\)/,
    "a relocate carries the (possibly renamed) brick name alongside the target block so a simultaneous rename isn't dropped",
  );
  assert.match(
    uiSource,
    /const isRelocatingEdit =\s*isEditing && def\.master === "bricks" && \(editValues\.block_code \?\? ""\) !== String\(row\.block_code \?\? ""\);/,
    "the row-level Move/Save label and relocate hint use the same 'block_code actually changed' condition as the save handler",
  );
  assert.match(
    uiSource,
    /\{isRelocatingEdit \? "Move" : "Save"\}/,
    "the save button only reads \"Move\" when the pending edit is a real relocate",
  );
  // Styling-agnostic on purpose. This used to pin the hint's ENTIRE className, which meant
  // every restyle broke an assertion that has nothing to do with styling — it broke once on
  // the colour sweep (text-[#94A3B8]) and again on the type sweep (text-[10px]), neither of
  // which could possibly affect when the hint appears. What this guards is the CONDITION and
  // the words; the paragraph is allowed to look like anything.
  assert.match(
    uiSource,
    /\{isRelocatingEdit \? \(\s*<p[^>]*>\s*Creates a new brick ID in the target block and deactivates this one\./,
    "the relocate warning hint only shows for a real block move, not a pure brick_name rename",
  );
}
