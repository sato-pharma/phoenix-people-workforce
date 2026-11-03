import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { brickSwitchOffRefusal, historicalNameCandidates } from "@/lib/sales/master-data/brick-move-result";

// Moving a brick to a different block goes through relocateBrick instead of updateSingleMasterRow's
// plain in-place PATCH. Owner preference (2026-07-23): this dataset's brick IDs encode their block, so
// the moved brick gets a fresh "{block}-{n}" id in its new block. Owner rule (2026-09-18): the old
// brick is NEVER switched off. It stays active in its old area as history, renamed and pointing at the
// brick that replaced it, so published months keep resolving through it.
//
// The move itself (the new brick, the history, the pharmacies and their open-month sales) is ONE
// database transaction, sos_relocate_brick, pinned in sales-brick-move-sales.test.ts. This file pins
// the TypeScript around it: source-text checks, since the service needs a live database (the
// convention of sales-master-data-pagination.test.ts), plus the pure history-name rule.
export function runSalesBrickRelocateTests() {
  const definitionsSource = readFileSync("src/lib/sales/master-data/definitions.ts", "utf8");

  // brick_name and block description are in-place renames (updateSingleMasterRow's plain PATCH);
  // only block_code (which block a brick lives under) drives the move.
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
    /newBrickName\?: string;\s*\}\): Promise<\{ success: true; result: BrickRelocation \} \| \{ success: false; error: string \}>/,
    "relocateBrick accepts an optional rename and answers with what the database moved",
  );

  const relocateStart = serviceSource.indexOf("export async function relocateBrick");
  const failureStart = serviceSource.indexOf("function relocateFailure");
  assert.ok(relocateStart >= 0 && failureStart > relocateStart, "relocateBrick is followed by relocateFailure");
  const relocateBody = serviceSource.slice(relocateStart, failureStart);

  assert.match(
    relocateBody,
    /const newBrickName = typeof input\.newBrickName === "string" \? input\.newBrickName\.trim\(\)\.replace\(\/\\s\+\/g, " "\) : "";/,
    "relocateBrick normalizes the optional rename input",
  );
  assert.match(
    relocateBody,
    /const brickName = newBrickName \|\| oldName;/,
    "an explicit rename wins over the old brick's name; an empty or absent rename keeps it",
  );
  assert.match(
    relocateBody,
    /historicalNameCandidates\(\{/,
    "the name the old brick keeps as history comes from the shared candidate list",
  );
  assert.match(
    relocateBody,
    /const historicalName = candidates\.find\(\(candidate\) => !taken\.has\(normalizeKey\(candidate\)\)\);/,
    "the history keeps the first candidate no other brick holds (brick names are unique)",
  );
  assert.match(
    relocateBody,
    /\.rpc\("sos_relocate_brick", \{[\s\S]*?p_historical_name: historicalName,[\s\S]*?p_normalized_historical_name: normalizeKey\(historicalName\),[\s\S]*?\}\);/,
    "the move is ONE database call, sos_relocate_brick, which also names the old brick's history",
  );
  assert.equal(
    (relocateBody.match(/writeAuditLog\(/g) ?? []).length,
    2,
    "relocateBrick audits both the brick kept as history and the brick that replaced it",
  );
  assert.match(
    relocateBody,
    /superseded_by_brick_id: result\.newBrickId/,
    "the history brick's audit row names the brick it moved to",
  );
  // The old flow switched the old brick off, patched the customer map from TypeScript and deleted the
  // new row when that failed. All of it now happens, or none of it, inside sos_relocate_brick.
  assert.doesNotMatch(relocateBody, /active: false/, "relocateBrick never switches the old brick off");
  assert.doesNotMatch(relocateBody, /\.delete\(\)/, "relocateBrick deletes nothing; a failed move rolls back in the database");
  assert.doesNotMatch(
    relocateBody,
    /from\("source_of_sales_customer_map"\)/,
    "the pharmacies move inside the database transaction (through the mapping guard), never from TypeScript",
  );

  const failureBody = serviceSource.slice(failureStart, serviceSource.indexOf("function cairoDateLabel"));
  assert.match(
    failureBody,
    /if \(\(error as \{ code\?: unknown \} \| null\)\?\.code === "P0001"\) \{\s*return \{ success: false, error: errorMessageOf\(error\)/,
    "the database's own refusals (P0001: switched off, already history, held on the Mapping guard) reach the screen as written",
  );
  assert.match(
    failureBody,
    /isStatementTimeoutError\(error\)/,
    "a move the database cancelled for time says nothing was moved",
  );

  assert.match(
    serviceSource,
    /input\.master === "bricks" &&\s*!input\.active &&\s*normalizeDisplay\(\(existingRow as Record<string, unknown>\)\.superseded_by_brick_id\) !== ""/,
    "switching off a brick kept as history is refused (owner rule: never deactivate the old brick)",
  );
  assert.match(
    serviceSource,
    /error: "This brick is kept as history after it moved to another area, so published months keep their numbers\. It stays switched on\.",/,
    "the refusal says why the history brick stays switched on",
  );

  // The bin refuses a brick that still has active pharmacies, and refuses when it cannot tell.
  assert.equal(brickSwitchOffRefusal({ count: 0, error: null }), null, "a brick with no active pharmacy may be switched off");
  assert.match(
    brickSwitchOffRefusal({ count: 1, error: null }) ?? "",
    /^1 active pharmacy still sits on this brick, so it stays switched on\. Move it on SoS Mapping first\.$/,
    "one active pharmacy refuses the switch-off and says where to move it",
  );
  assert.match(
    brickSwitchOffRefusal({ count: 902, error: null }) ?? "",
    /^902 active pharmacies still sit on this brick/,
    "many active pharmacies refuse the switch-off",
  );
  assert.match(
    brickSwitchOffRefusal({ count: null, error: { message: "timeout" } }) ?? "",
    /stays switched on/,
    "an unreadable count refuses, never lets the switch-off through",
  );
  assert.match(
    brickSwitchOffRefusal({ count: null, error: null }) ?? "",
    /stays switched on/,
    "a missing count with no error refuses too",
  );
  const switchOffBody = serviceSource.slice(
    serviceSource.indexOf("export async function setMasterRowActive"),
    serviceSource.indexOf("Moves a brick to the block it really belongs to"),
  );
  assert.match(
    switchOffBody,
    /input\.master === "bricks" && !input\.active\) \{\s*const activePharmacies = await supabase\s*\.from\("source_of_sales_customer_map"\)\s*\.select\("id", \{ count: "exact", head: true \}\)\s*\.eq\("brick_id", key\)\s*\.eq\("active", true\);\s*const refusal = brickSwitchOffRefusal\(activePharmacies\);\s*if \(refusal\) return \{ success: false, error: refusal \};/,
    "setMasterRowActive counts the brick's ACTIVE pharmacies and returns the refusal",
  );
  assert.ok(
    switchOffBody.indexOf("brickSwitchOffRefusal(activePharmacies)") < switchOffBody.indexOf(".update({ active: input.active"),
    "the check runs before the brick is switched off",
  );

  const routeSource = readFileSync("app/api/sales/database-mapping/bricks/[key]/relocate/route.ts", "utf8");
  assert.match(routeSource, /export async function POST\(/, "the relocate route exports POST");
  assert.match(routeSource, /resolveAccessContext\(request\)/, "the route resolves an authenticated session");
  assert.match(
    routeSource,
    /if \(access\.role !== "Super Admin" && access\.scope !== "system"\) \{\s*return NextResponse\.json\(\{ success: false, error: "Only the Super Admin can move a brick\." \}, \{ status: 403 \}\);/,
    "only the Super Admin can move a brick, like the rest of the Database Mapping screen",
  );
  assert.match(
    routeSource,
    /assertPermission\(access, "sales", "update"\)/,
    "relocating requires the sales:update permission — same tier as a plain edit",
  );
  assert.ok(
    routeSource.indexOf('access.role !== "Super Admin"') < routeSource.indexOf("relocateBrick({"),
    "the Super Admin gate runs before the move",
  );
  assert.match(
    routeSource,
    /export const maxDuration = 150;/,
    "the route outlives the database's own two-minute limit on the move",
  );
  assert.match(
    routeSource,
    /relocateBrick\(\{\s*actorLoginId,\s*brickId: key,\s*newBlockCode: body\.newBlockCode,\s*newBrickName: typeof body\.brickName === "string" \? body\.brickName : undefined,\s*\}\)/,
    "the route delegates to relocateBrick with the block move and the optional rename",
  );
  assert.match(
    routeSource,
    /move: outcome\.result,/,
    "the route hands back what moved, so the screen can rebuild the files the sales moved in",
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
    /if \(isBrickRelocate\) onBrickMoved\(parseBrickRelocation\(payload\.move\)\?\.pendingFiles \?\? 0\);/,
    "a move from the row editor tells the other tabs and rebuilds the files its sales moved in, like the correction panel",
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
  // Styling-agnostic on purpose: an earlier version pinned the hint's whole className and broke on
  // two restyles that could not change when the hint appears. What this guards is the CONDITION and
  // the words.
  assert.match(
    uiSource,
    /\{isRelocatingEdit \? \(\s*<p[^>]*>\s*Moves the brick to that block&apos;s area: it gets a new ID there, its pharmacies and their open-month sales go with it, and this brick stays switched on as history\./,
    "the relocate hint only shows for a real block move, and says the old brick stays switched on",
  );
  assert.doesNotMatch(
    uiSource,
    /deactivates this one/,
    "no screen tells the owner a move deactivates the old brick: it never does",
  );

  // The history name: "<name> - <old area>" first, then dated, then counted; never the moved brick's
  // own name (the database refuses that pair).
  const candidates = historicalNameCandidates({
    brickName: "  North   Market ",
    fromAreaName: " Old Town ",
    movedOn: "18 September 2026",
    newBrickName: "North Market",
  });
  assert.equal(candidates[0], "North Market - Old Town", "the history first keeps its name with the area it left");
  assert.equal(candidates[1], "North Market - Old Town (moved 18 September 2026)", "then the same with the move date");
  assert.equal(candidates[2], "North Market - Old Town (moved 18 September 2026, 2)", "then a counter");
  assert.equal(candidates.at(-1), "North Market - Old Town (moved 18 September 2026, 20)", "the counter stops at 20");
  assert.equal(candidates.length, 21, "twenty-one names to try");
  assert.equal(new Set(candidates).size, candidates.length, "no name is offered twice");

  assert.equal(
    historicalNameCandidates({ brickName: "North Market", fromAreaName: " ", movedOn: "18 September 2026", newBrickName: "South Gate" })[0],
    "North Market (history)",
    "a brick whose old area has no name is kept as \"(history)\"",
  );

  const clash = historicalNameCandidates({
    brickName: "North Market",
    fromAreaName: "Old Town",
    movedOn: "18 September 2026",
    newBrickName: "north market -  OLD TOWN",
  });
  assert.ok(!clash.includes("North Market - Old Town"), "a history name equal to the moved brick's new name is skipped");
  assert.equal(clash[0], "North Market - Old Town (moved 18 September 2026)", "the next candidate takes its place");
}
