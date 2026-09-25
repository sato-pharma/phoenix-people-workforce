import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  brickCorrectionHref,
  followMovedBrick,
  followMovedPicks,
  pickedBrick,
  type MappingBrickReference,
} from "@/lib/sales/normalizer/brick-area";
import {
  areaChoices,
  blockChoicesInArea,
  blockName,
  brickCorrectionSubject,
  type BrickMasterRows,
} from "@/lib/sales/master-data/brick-correction";
import {
  BRICK_MOVES_CHANNEL,
  describeBrickMoveRefresh,
  describeBrickRelocation,
  describeBrickSalesMove,
  parseBrickMoveRefresh,
  parseBrickRelocation,
  parseBrickSalesMove,
} from "@/lib/sales/master-data/brick-move-result";
import { stripComments } from "./support/comment-strip.ts";

// "Correct in database" (owner request, 2026-09-18). The Source Normalizer shows the area of every
// brick it maps a code to, read-only, and links a wrong one to the Database Mapping page, where the
// brick moves to the area it really belongs to and "it is actually fixed in database".
//
// A brick's area is its block's, so the fix is a MOVE: sos_relocate_brick makes the brick again in
// the right block, keeps the old one switched on as history (published months keep their numbers),
// and carries its pharmacies, their references and their sales in every file that touches no locked
// month. A pharmacy the mapping guard holds waits for the owner; approving it moves its sales in the
// same transaction (owner decision 2026-09-18, "Wait on Mapping guard"). The files whose sales moved
// have their totals rebuilt one at a time afterwards.
//
// The database half is migrations CI never runs, so their text is pinned here; the pure halves run.

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} has a body`);
  return sql.slice(start, end);
}

function count(source: string, pattern: RegExp): number {
  return (source.match(new RegExp(pattern.source, "g")) ?? []).length;
}

function pinMigrations() {
  const moveSql = read("supabase/migrations/20260918150000_sos_brick_move_carries_its_sales.sql");

  // The ledger of files whose sales moved: server-only.
  assert.match(moveSql, /create table if not exists public\.source_of_sales_brick_move_files \(/, "the moved-files ledger exists");
  assert.match(moveSql, /alter table public\.source_of_sales_brick_move_files enable row level security;/, "the ledger has RLS on");
  assert.match(moveSql, /revoke all on table public\.source_of_sales_brick_move_files from anon, authenticated;/, "no browser role reads the ledger");
  assert.match(
    moveSql,
    /grant select, insert, update, delete on table public\.source_of_sales_brick_move_files to service_role;/,
    "only the server writes the ledger",
  );

  const signatures = [
    "sos_move_brick_sales(text)",
    "sos_relocate_brick(text, text, text, text, text, text, text)",
    "sos_move_brick_sales_after_hold(bigint)",
    "sos_claim_brick_move_file(text)",
    "sos_finish_brick_move_file(text, uuid, timestamptz, boolean)",
  ];
  for (const signature of signatures) {
    const escaped = signature.replace(/[()]/g, "\\$&");
    assert.match(
      moveSql,
      new RegExp(`revoke execute on function public\\.${escaped} from public, anon, authenticated;`),
      `${signature} is taken away from every browser role`,
    );
    assert.match(
      moveSql,
      new RegExp(`grant execute on function public\\.${escaped} to service_role;`),
      `${signature} runs for the server only`,
    );
  }
  assert.doesNotMatch(moveSql, /grant [^;]* to (?:anon|authenticated|public)\b/, "nothing in the move is granted to a browser role");

  for (const name of ["sos_move_brick_sales", "sos_relocate_brick", "sos_move_brick_sales_after_hold"]) {
    const body = functionBody(moveSql, name);
    assert.match(body, /security definer/, `${name} runs as its owner, past the guard's grants`);
    assert.match(body, /set search_path to 'public'/, `${name} pins its search path`);
    assert.match(body, /set statement_timeout to '120s'/, `${name} has two minutes, not the API's eight seconds`);
  }

  const relocate = functionBody(moveSql, "sos_relocate_brick");
  for (const [refusal, why] of [
    ["'% is switched off. Switch it back on before moving it.'", "a switched-off brick is not moved"],
    ["'% is kept only as history: it has already moved. Correct the brick it moved to instead.'", "a history brick never moves again"],
    ["'The block % is switched off. Switch it back on before moving a brick into it.'", "no brick moves into a switched-off block"],
    ["'% is already in that block.'", "a move to its own block is refused"],
    ["'% has % change(s) waiting for you on the Mapping guard. Decide those first, then move it.'", "a brick with undecided holds waits for the owner"],
    ["'Another brick is already named %. Pick a different name.'", "brick names stay unique"],
  ] as const) {
    assert.ok(relocate.includes(refusal), `sos_relocate_brick refuses: ${why}`);
  }
  assert.match(
    relocate,
    /values \(\s*v_new, btrim\(p_brick_name\), p_normalized_brick_name, v_block\.block_code, v_block\.area_code, v_block\.region_code,/,
    "the new brick takes the block's area and region",
  );
  assert.match(relocate, /superseded_by_brick_id = v_new,/, "the old brick points at the brick that replaced it");
  assert.match(relocate, /set brick_name\s+= btrim\(p_historical_name\),/, "the old brick keeps the history name");
  assert.doesNotMatch(relocate, /active\s*=\s*false/, "the old brick is never switched off (owner rule)");
  assert.match(
    relocate,
    /update public\.source_of_sales_customer_map m\s*set brick_id\s*= v_new,/,
    "the pharmacies move through the mapping guard, in the same transaction",
  );
  assert.match(
    relocate,
    /from public\.sos_map_change_holds h\s*where h\.status = 'pending'/,
    "the held pharmacies are counted from the holds: the guard drops a held row silently",
  );
  for (const table of [
    "public.source_of_sales_territory_aliases",
    "public.direct_order_pharmacies",
    "public.direct_order_pharmacy_distributor_codes",
    "public.source_of_sales_customer_ai_answers",
  ]) {
    assert.match(relocate, new RegExp(`update ${table.replace(/\./g, "\\.")} `), `${table} follows the brick`);
  }
  assert.match(relocate, /v_sales := public\.sos_move_brick_sales\(v_old\.brick_id\);/, "the sales move in the same transaction");

  // 20260918150100: each file is judged against the locked months ONCE, not once per row (the per-row
  // form would be cut off at eight seconds for a big pharmacy group).
  const judgedOnce = functionBody(read("supabase/migrations/20260918150100_sos_move_brick_sales_judges_each_file_once.sql"), "sos_move_brick_sales");
  assert.match(
    judgedOnce,
    /from unnest\(v_batches\) as f\(batch_id\)\s*where public\.sos_import_batch_touches_locked_closing\(f\.batch_id\);/,
    "the files touching a locked month are found once each",
  );
  assert.doesNotMatch(judgedOnce, /sos_import_batch_touches_locked_closing\(r\.batch_id\)/, "no sales row is judged on its own");
  assert.match(judgedOnce, /and r\.batch_id <> all \(v_frozen\)/, "a file touching a locked month is left whole");
  assert.match(
    judgedOnce,
    /and m\.brick_id is distinct from v_new\.brick_id/,
    "a row whose pharmacy's live mapping points elsewhere (held, or kept on the old brick) does not move",
  );
  assert.match(judgedOnce, /security definer/, "the redefinition keeps security definer");
  assert.match(judgedOnce, /set statement_timeout to '120s'/, "the redefinition keeps its two minutes");

  const decideSql = read("supabase/migrations/20260918150200_sos_map_guard_decide_moves_brick_sales.sql");
  const decide = functionBody(decideSql, "sos_map_guard_decide_and_move_sales");
  assert.match(decide, /v_result := public\.sos_map_guard_decide\(p_hold_id, p_decision, p_actor\);/, "the owner's decision still goes through the guard");
  assert.match(
    decide,
    /if p_decision = 'approved' and coalesce\(\(v_result->>'ok'\)::boolean, false\) then\s*v_move := public\.sos_move_brick_sales_after_hold\(p_hold_id\);/,
    "only an approval that went through moves the pharmacy's sales",
  );
  assert.match(
    decide,
    /return coalesce\(v_result, '\{\}'::jsonb\) \|\| jsonb_build_object\('brickMove', v_move\);/,
    "the answer is the guard's own, plus what moved",
  );
  assert.match(decide, /security definer/, "the wrapper runs as its owner");
  assert.match(decide, /set statement_timeout to '120s'/, "the whole decision has two minutes");
  assert.match(
    decideSql,
    /revoke execute on function public\.sos_map_guard_decide_and_move_sales\(bigint, text, text\) from public, anon, authenticated;/,
    "no browser role can decide a hold",
  );
  assert.match(
    decideSql,
    /grant execute on function public\.sos_map_guard_decide_and_move_sales\(bigint, text, text\) to service_role;/,
    "only the server decides a hold",
  );
}

function pinServerCode() {
  const guard = read("src/lib/sales/mapping-guard.ts");
  assert.match(guard, /\.rpc\("sos_map_guard_decide_and_move_sales", \{/, "a decision goes through the wrapper that moves the sales too");
  assert.doesNotMatch(guard, /\.rpc\("sos_map_guard_decide", \{/, "no decision skips the sales move");
  assert.match(guard, /brickMove: parseBrickSalesMove\(result\.brickMove\)/, "the decision says what moved");

  const decideRoute = read("app/api/sales/mapping-guard/decide/route.ts");
  assert.match(
    decideRoute,
    /if \(\(error as \{ code\?: unknown \} \| null\)\?\.code === "P0001"\) \{\s*return NextResponse\.json\(\{ success: false, error: `\$\{errorMessageOf\(error\)\} Nothing was decided\.` \}, \{ status: 409 \}\);/,
    "a refusal the database wrote reaches the screen, and says nothing was decided",
  );
  assert.match(decideRoute, /brickMove: result\.brickMove/, "the decide route hands back what moved");

  const refreshRoute = read("app/api/sales/brick-moves/refresh/route.ts");
  assert.equal(
    count(refreshRoute, /if \(access\.role !== "Super Admin" && access\.scope !== "system"\) \{/),
    2,
    "both the count and the rebuild are Super Admin only",
  );
  assert.equal(count(refreshRoute, /await assertPermission\(access, "sales", "import"\);/), 2, "both need sales:import");
  assert.match(refreshRoute, /refreshMovedBrickFiles\(\{ budgetMs: REFRESH_BUDGET_MS \}\)/, "the rebuild is time-boxed per call");

  const registry = read("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /audit: \{ classification: "mutation", required: true \}, methods: \["POST"\], pattern: "\/api\/sales\/database-mapping\/bricks\/:key\/relocate", permission: \{ resource: "sales", action: "update" \}/,
    "the move is registered as an audited mutation needing sales:update",
  );
  assert.match(
    registry,
    /audit: \{ classification: "mutation", required: true \}, methods: \["GET", "POST"\], pattern: "\/api\/sales\/brick-moves\/refresh", permission: \{ resource: "sales", action: "import" \}/,
    "the rebuild is registered as an audited mutation needing sales:import",
  );

  // A brick kept only as history credits the area it left, so nothing new may land on it.
  for (const path of ["app/api/sales/monthly-import/ai-suggest/route.ts", "app/api/sales/normalizer/mappings/ai-suggest/route.ts"]) {
    const source = read(path);
    assert.match(source, /kind === "territory" \? loadMovedBricks\(\)/, `${path} reads the moved bricks for a territory question`);
    assert.match(
      source,
      /\(refs\.bricks \?\? \[\]\)\.filter\(\(b\) => !movedBricks\.has\(b\.brickId\)\)/,
      `${path} never offers the AI a history brick`,
    );
  }
  const customerSuggest = read("src/lib/sales/normalizer/customer-suggest.ts");
  assert.match(
    customerSuggest,
    /const liveBricks = \(refs\.bricks \?\? \[\]\)\.filter\(\(b\) => !movedBricks\.has\(b\.brickId\)\);/,
    "the customer suggestions see the live bricks only",
  );
  assert.match(customerSuggest, /const brickMap = new Map\(liveBricks\.map\(/, "a history brick is not a live answer");
  assert.match(customerSuggest, /if \(!r \|\| !c \|\| !isLiveBrick\(c\)\) return;/, "no example steers the AI toward a history brick");

  const mapping = read("src/lib/sales/normalizer/mapping.ts");
  assert.match(
    mapping,
    /return `\$\{from\} is kept only as history: it moved to \$\{successor\}\. Pick \$\{successor\} instead\.`;/,
    "a save onto a history brick is refused, naming the brick it moved to",
  );
  assert.equal(count(mapping, /historyReason\(code\)/), 2, "both customer and territory saves are refused");

  const moves = read("src/lib/sales/master-data/brick-moves.ts");
  assert.match(moves, /\.rpc\("sos_claim_brick_move_file", \{ p_old_brick: null \}\)/, "each file is claimed before it is rebuilt");
  assert.match(moves, /await refreshBatchRollups\(supabase, claim\.batchId,/, "the rebuild is the importer's own");
  assert.match(moves, /\.rpc\("sos_finish_brick_move_file", \{/, "a rebuilt file is marked done");
  assert.doesNotMatch(moves, /failure = [^;]*\.message/, "no database message reaches the screen");

  const customerMap = read("src/lib/sales/normalizer/customer-map.ts");
  assert.match(
    customerMap,
    /export async function refreshBatchRollups\(/,
    "the history heal and the brick-move rebuild share one rebuild sequence",
  );
}

function pinScreens() {
  const normalizer = read("src/components/sales/normalizer-workspace.tsx");
  assert.match(normalizer, /href=\{brickCorrectionHref\(brick\.id\)\}/, "the Area links to that brick's correction");
  assert.match(normalizer, /rel="noopener"\s*target="_blank"/, "the correction opens in a new tab, so the picks here survive");
  assert.match(normalizer, />\s*Correct in database\s*<\/a>/, "the link says what it does, in the owner's words");
  assert.match(
    normalizer,
    /const stackTable = "block w-full text-left text-sm md:table md:table-fixed";/,
    "the territory and customer tables are fixed-layout on a desktop and stack on a phone",
  );
  assert.ok(
    count(normalizer, /<table className=\{stackTable\}>\s*<colgroup className=\{stackCols\}>/) >= 2,
    "both tables carry a colgroup, so the new Area column never pushes them wider than the page",
  );
  assert.ok(count(normalizer, /<BrickAreaCell brick=\{pickedBrick\(/) >= 2, "the Area sits beside every territory and customer pick");
  assert.match(normalizer, /useBrickMovesListener\(\(\) => router\.refresh\(\)\);/, "a move in another tab reloads the bricks here");
  assert.equal(
    count(normalizer, /followMovedPicks\(current, movedBricks, isBrickPick\)/),
    2,
    "picks and AI picks both follow a moved brick",
  );
  assert.match(
    normalizer,
    /function isBrickPick\(key: string\) \{\s*return key\.startsWith\("t:"\) \|\| key\.startsWith\("c:"\);/,
    "only territory and customer picks name a brick",
  );

  const panel = read("src/components/sales/brick-area-correction.tsx");
  // The code only: the file's own comments explain why it avoids the rounded shared Button.
  const panelCode = stripComments(panel);
  assert.doesNotMatch(panelCode, /rounded/, "the correction panel has square edges (owner's golden rule)");
  assert.doesNotMatch(panelCode, /overflow-x-auto/, "the correction panel never scrolls sideways");
  assert.doesNotMatch(panelCode, /min-w-\[/, "no fixed minimum width pushes the panel past a phone");
  assert.match(
    panel,
    /`\/api\/sales\/database-mapping\/bricks\/\$\{encodeURIComponent\(subject\.brickId\)\}\/relocate`/,
    "the correction moves the brick through the same route as the row editor",
  );
  assert.match(panel, /JSON\.stringify\(\{ brickName: brickName\.trim\(\), newBlockCode: blockCode \}\)/, "the panel sends the block and the name");
  assert.match(panel, /onOpenBrick\(subject\.successorId\)/, "a history brick leads to the brick it moved to");

  const page = read("app/(admin)/sales/database-mapping/page.tsx");
  assert.match(page, /const initialBrickId = firstParam\(params\.brick\) \|\| null;/, "the page reads the brick the link names");
  assert.match(page, /const initialTab: MasterKey = initialBrickId\s*\?\s*"bricks"/, "a brick link opens the Bricks tab");
  assert.match(page, /initialBrickId=\{initialBrickId\}/, "the page hands the brick to the workspace");
  assert.match(page, /initialTab=\{initialTab\}/, "the page hands the tab to the workspace");
  assert.match(page, /initialPendingMoveFiles=\{await pendingMoveFiles\}/, "a rebuild left half-done resumes when the page opens");
  assert.ok(
    page.indexOf('accessContext.role !== "Super Admin"') < page.indexOf("await searchParams"),
    "the Super Admin gate runs before the link is read",
  );

  const workspace = read("src/components/sales/database-mapping-workspace.tsx");
  assert.match(
    workspace,
    /const correctingBrickId = activeTab === "bricks" \? correctionBrickId : null;/,
    "the correction shows on the Bricks tab only",
  );
  assert.match(workspace, /<BrickAreaCorrection\s*brickId=\{correctingBrickId\}/, "the workspace renders the correction panel");
  assert.match(
    workspace,
    /window\.history\.replaceState\(null, "", brickId \? brickCorrectionHref\(brickId\) : "\/sales\/database-mapping\?tab=bricks"\);/,
    "the address follows the brick being corrected, so a reload lands on it",
  );
  assert.match(
    workspace,
    /announceBrickMoves\(\);\s*if \(pendingFiles > 0\) void rebuildMovedFiles\(\);/,
    "every move tells the other tabs, then rebuilds the files its sales moved in",
  );
  assert.match(workspace, /if \(initialPendingMoveFiles > 0\) void rebuildMovedFiles\(\);/, "the page resumes a rebuild left waiting");
  assert.match(workspace, /<BrickMoveRefreshStatus refresh=\{moveRefresh\} \/>/, "the page says how the rebuild is going");
  assert.match(
    workspace,
    /name = \[blockName\(row, brickNames\), area\]\.filter\(Boolean\)\.join\(" — "\);/,
    "the row editor's block picker shows names, not codes",
  );

  const review = read("src/components/sales/mapping-guard-review.tsx");
  assert.match(review, /const brickMove = parseBrickSalesMove\(payload\.brickMove\);/, "the Mapping guard reads what an approval moved");
  assert.match(review, /if \(brickMove\.pendingFiles > 0\) void rebuildMovedFiles\(\);/, "and rebuilds the files the sales moved in");
}

function checkBrickArea() {
  assert.equal(brickCorrectionHref("GZ3-2"), "/sales/database-mapping?tab=bricks&brick=GZ3-2", "the link lands on the Bricks tab, on that brick");
  assert.equal(
    brickCorrectionHref("A B&C/1"),
    "/sales/database-mapping?tab=bricks&brick=A%20B%26C%2F1",
    "an id with spaces or symbols is encoded, never split",
  );

  const moved = { "CA1-2": "GZ3-1", "GZ3-1": "GZ3-2" };
  assert.equal(followMovedBrick("CA1-2", moved), "GZ3-2", "a brick moved twice resolves to where it is now");
  assert.equal(followMovedBrick("GZ3-2", moved), "GZ3-2", "a live brick is itself");
  assert.equal(followMovedBrick("CA1-2", undefined), "CA1-2", "no move list: the brick is itself");
  assert.equal(followMovedBrick("", { "": "GZ3-2" }), "", "nothing picked stays nothing");
  assert.equal(followMovedBrick("A", { A: "A" }), "A", "a brick pointing at itself ends there");
  assert.ok(["A", "B"].includes(followMovedBrick("A", { A: "B", B: "A" })), "a looping history ends instead of hanging");

  const palm: MappingBrickReference = { areaName: "River Side", id: "GZ3-2", name: "Palm Street", regionName: "Giza" };
  const bricksById = new Map([[palm.id, palm]]);
  assert.equal(pickedBrick(undefined, bricksById, moved), null, "no pick, no area");
  assert.equal(pickedBrick("", bricksById, moved), null, "an empty pick, no area");
  assert.equal(pickedBrick("CA1-2", bricksById, moved), palm, "a pick of a moved brick shows the area of the brick it moved to");
  assert.equal(pickedBrick("XX-9", bricksById, moved), null, "a brick missing from the master shows no area");

  const isBrickKey = (key: string) => key.startsWith("t:") || key.startsWith("c:");
  const picks = { "c:D1|C9": "GZ3-2", "p:ITEM": "CA1-2", "t:OLD TOWN": "CA1-2" };
  const followed = followMovedPicks(picks, moved, isBrickKey);
  assert.deepEqual(
    followed,
    { "c:D1|C9": "GZ3-2", "p:ITEM": "CA1-2", "t:OLD TOWN": "GZ3-2" },
    "brick picks follow the move; a product pick is never touched",
  );
  assert.equal(picks["t:OLD TOWN"], "CA1-2", "the old picks are not changed in place");
  const settled = { "t:OLD TOWN": "GZ3-2" };
  assert.equal(followMovedPicks(settled, moved, isBrickKey), settled, "nothing to follow returns the same object, so React skips the update");
  assert.equal(followMovedPicks(picks, {}, isBrickKey), picks, "no moved brick returns the same object");
  assert.equal(followMovedPicks(picks, undefined, isBrickKey), picks, "no move list returns the same object");
}

function checkMoveResults() {
  assert.equal(BRICK_MOVES_CHANNEL, "phoenix.sales.brick-moves", "every tab listens on one channel");

  assert.equal(parseBrickSalesMove(null), null, "no answer is not a move");
  assert.equal(parseBrickSalesMove([]), null, "a list is not a move");
  assert.equal(parseBrickSalesMove("moved"), null, "text is not a move");
  assert.deepEqual(
    parseBrickSalesMove({ movedFiles: 2.9, movedRows: "12", pendingFiles: 1, publishedRows: -3, toBrickId: " GZ3-2 ", waitingRows: "many" }),
    { movedFiles: 2, movedRows: 12, pendingFiles: 1, publishedRows: 0, toBrickId: "GZ3-2", waitingRows: 0 },
    "counts are whole and never negative; the brick id is trimmed",
  );
  assert.equal(parseBrickRelocation({ movedRows: 3 }), null, "a move without the new brick is not a relocation");

  const relocation = parseBrickRelocation({
    aliasesMoved: 1,
    customersHeld: 1,
    customersMoved: "4",
    fromAreaName: "Old Town",
    historicalName: "Palm Street - Old Town",
    movedFiles: 2,
    movedRows: 10,
    newBrickId: " GZ3-2 ",
    newBrickName: "Palm Street",
    pendingFiles: 2,
    switchedOffMoved: 1,
    toAreaName: "River Side",
    toBlockLabel: "River block",
  });
  assert.ok(relocation, "a relocation with its new brick is read");
  assert.equal(relocation.newBrickId, "GZ3-2", "the new brick id is trimmed");
  assert.equal(relocation.customersMoved, 4, "a count sent as text is read as a number");
  assert.equal(relocation.directCodesMoved, 0, "a count the answer leaves out is zero");
  assert.deepEqual(
    describeBrickRelocation(relocation),
    [
      "Palm Street moved from Old Town to River Side (block River block).",
      "The old brick stays as history under the name Palm Street - Old Town, so published months keep their numbers.",
      "Moved with it: 4 pharmacies, 1 switched-off pharmacy, 1 territory name.",
      "1 pharmacy waits for you on the Mapping guard and stays on the old brick until you approve it.",
      "10 sales rows in 2 files now credit River Side.",
      "2 files still need their totals rebuilt. This page does that now.",
    ],
    "a finished move reads headline first, in names and counts",
  );

  const quiet = { movedFiles: 0, movedRows: 0, pendingFiles: 0, publishedRows: 0, toBrickId: "GZ3-2", waitingRows: 0 };
  assert.deepEqual(describeBrickSalesMove(quiet), [], "no sales row touched says nothing");
  assert.deepEqual(
    describeBrickSalesMove({ ...quiet, movedFiles: 1, movedRows: 1 }, "River Side"),
    ["1 sales row in 1 file now credits River Side."],
    "one row reads in the singular",
  );
  assert.deepEqual(
    describeBrickSalesMove({ movedFiles: 3, movedRows: 1200, pendingFiles: 3, publishedRows: 2, toBrickId: "GZ3-2", waitingRows: 1 }),
    [
      "1,200 sales rows in 3 files moved with it.",
      "2 sales rows stay where they were: their files include a published month, which never changes.",
      "1 sales row waits with the pharmacies on the Mapping guard, and moves when you approve them.",
      "3 files still need their totals rebuilt. This page does that now.",
    ],
    "every part of a sales move is said, with published months named as never changing",
  );

  assert.deepEqual(parseBrickMoveRefresh(undefined), { failure: null, refreshed: 0, remaining: 0 }, "no answer rebuilt nothing");
  assert.deepEqual(
    parseBrickMoveRefresh({ failure: " A moved file's totals could not be rebuilt. ", refreshed: 2, remaining: "1" }),
    { failure: "A moved file's totals could not be rebuilt.", refreshed: 2, remaining: 1 },
    "a pass is read with its failure trimmed",
  );
  assert.equal(
    describeBrickMoveRefresh({ failure: "A moved file's totals could not be rebuilt.", refreshed: 1, remaining: 1 }),
    "Rebuilt 1 moved file. A moved file's totals could not be rebuilt. 1 file is still waiting; a file that failed is tried again after five minutes.",
    "a failed pass says what was done, what failed and when it is tried again",
  );
  assert.equal(
    describeBrickMoveRefresh({ failure: null, refreshed: 0, remaining: 2 }),
    "2 moved files wait to be rebuilt. Another open page may be rebuilding them now; a file that failed is tried again after five minutes.",
    "a pass that could claim nothing says another page may hold the files",
  );
  assert.equal(
    describeBrickMoveRefresh({ failure: null, refreshed: 2, remaining: 1 }),
    "Rebuilt 2 moved files; 1 is still waiting.",
    "progress reads as done and waiting",
  );
  assert.equal(
    describeBrickMoveRefresh({ failure: null, refreshed: 3, remaining: 0 }),
    "Rebuilt 3 moved files. Every total is up to date.",
    "the last pass says every total is up to date",
  );
  assert.equal(describeBrickMoveRefresh({ failure: null, refreshed: 0, remaining: 0 }), "Every moved file's totals are up to date.", "nothing waiting says so");
}

function checkBrickCorrection() {
  const rows: BrickMasterRows = {
    areas: [
      { active: true, area_code: "CA1", area_name: "Old Town", region_code: "CA" },
      { active: true, area_code: "GZ3", area_name: "River Side", region_code: "GZ" },
      { active: true, area_code: "GZ4", area_name: "Hill Top", region_code: "GZ" },
      { active: false, area_code: "GZ9", area_name: "Closed Area", region_code: "GZ" },
    ],
    blocks: [
      { active: true, area_code: "CA1", block_code: "CA1", description: "", display_name: "", master_brick_id: "CA1-1", region_code: "CA" },
      { active: true, area_code: "CA1", block_code: "CA1B", description: null, display_name: "East Block", master_brick_id: null, region_code: "CA" },
      { active: true, area_code: "GZ3", block_code: "GZ3", description: "River block", display_name: null, master_brick_id: null, region_code: "GZ" },
      { active: true, area_code: "GZ3", block_code: "GZ3Z", description: null, display_name: null, master_brick_id: null, region_code: "GZ" },
      { active: false, area_code: "GZ4", block_code: "GZ4", description: null, display_name: "Hill block", master_brick_id: null, region_code: "GZ" },
      { active: true, area_code: "GZ9", block_code: "GZ9", description: null, display_name: "Closed block", master_brick_id: null, region_code: "GZ" },
    ],
    bricks: [
      { active: true, area_code: "CA1", block_code: "CA1", brick_id: "CA1-1", brick_name: "North Market", region_code: "CA", superseded_by_brick_id: null },
      { active: true, area_code: "CA1", block_code: "CA1", brick_id: "CA1-2", brick_name: "Palm Street - Old Town", region_code: "CA", superseded_by_brick_id: "GZ3-1" },
      { active: true, area_code: "GZ3", block_code: "GZ3", brick_id: "GZ3-1", brick_name: "Palm Street - River Side", region_code: "GZ", superseded_by_brick_id: "GZ3-2" },
      { active: true, area_code: "GZ3", block_code: "GZ3", brick_id: "GZ3-2", brick_name: "Palm Street", region_code: "GZ", superseded_by_brick_id: null },
      { active: false, area_code: "CA1", block_code: "CA1", brick_id: "CA1-3", brick_name: "Closed Lane", region_code: "CA", superseded_by_brick_id: null },
    ],
    regions: [
      { region_code: "CA", region_name: "Cairo" },
      { region_code: "GZ", region_name: "Giza" },
    ],
  };

  const names = new Map([["CA1-1", "North Market"]]);
  assert.equal(blockName({ block_code: "B", description: "d", display_name: " Shown ", master_brick_id: "CA1-1" }, names), "Shown", "a block's own name wins");
  assert.equal(blockName({ block_code: "B", description: "d", display_name: "", master_brick_id: "CA1-1" }, names), "North Market", "then the brick it is named after");
  assert.equal(blockName({ block_code: "B", description: " d ", display_name: null, master_brick_id: "XX-9" }, names), "d", "then its description");
  assert.equal(blockName({ block_code: " B7 " }, names), "B7", "the code only when nothing names it");

  assert.deepEqual(
    areaChoices(rows, "CA1"),
    [
      { label: "Old Town — Cairo (where it is now)", name: "Old Town", value: "CA1" },
      { label: "River Side — Giza", name: "River Side", value: "GZ3" },
    ],
    "the areas are named with their region, the current one marked; an area that is switched off, or has no block to move into, is left out",
  );
  assert.deepEqual(
    blockChoicesInArea(rows, "ca1", "CA1"),
    [{ label: "East Block", value: "CA1B" }],
    "the brick's own block is not offered",
  );
  assert.deepEqual(
    blockChoicesInArea(rows, "GZ3", "CA1"),
    [
      { label: "GZ3Z", value: "GZ3Z" },
      { label: "River block", value: "GZ3" },
    ],
    "the blocks of the picked area, by name, sorted",
  );
  assert.deepEqual(blockChoicesInArea(rows, "GZ4", "CA1"), [], "a switched-off block is not offered");
  assert.deepEqual(blockChoicesInArea(rows, "", "CA1"), [], "no area picked, no block");

  assert.deepEqual(brickCorrectionSubject(rows, ""), { kind: "missing" }, "no brick in the link");
  assert.deepEqual(brickCorrectionSubject(rows, "XX-9"), { kind: "missing" }, "a brick not in the master");
  assert.deepEqual(
    brickCorrectionSubject(rows, "CA1-2"),
    { brickName: "Palm Street - Old Town", kind: "history", successorId: "GZ3-2", successorName: "Palm Street" },
    "a history brick leads to where it is now, past every later move",
  );
  assert.deepEqual(brickCorrectionSubject(rows, "CA1-3"), { brickName: "Closed Lane", kind: "off" }, "a switched-off brick is named as such");
  assert.deepEqual(
    brickCorrectionSubject(rows, " CA1-1 "),
    {
      areaCode: "CA1",
      areaName: "Old Town",
      blockCode: "CA1",
      blockName: "North Market",
      brickId: "CA1-1",
      brickName: "North Market",
      kind: "live",
      regionName: "Cairo",
    },
    "a live brick is shown with its area, region and block by name",
  );
}

export function runSalesBrickMoveSalesTests() {
  pinMigrations();
  pinServerCode();
  pinScreens();
  checkBrickArea();
  checkMoveResults();
  checkBrickCorrection();
}
