import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

// The three defects the recruitment folders audit found (2026-09-12), pinned in source because each
// one lives behind a live Supabase client and none of them can run here without one.

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

/** Source with comment lines removed, so a pin can never be satisfied by the comment explaining it. */
function codeOnly(source: string): string {
  return stripComments(source);
}

/** One top-level function, from its signature to its closing brace. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 2);
}

export function runCvCabinetAuditFixTests() {
  // ── 1. THE REPORT PREVIEW LEAKED EVERY CV IN THE COMPANY ──────────────────────────────────────
  //
  // The manager-engagement report is scoped to the reader's line; its two preview routes checked
  // only "may you read the report at all". A National Sales Manager could open any candidate's CV by
  // id. Both routes must now ask the per-candidate scope BEFORE touching a file, and answer 403.
  const engagement = codeOnly(read("src/lib/recruitment/manager-cv-engagement.ts"));
  const scopeCheck = functionBody(engagement, "export async function canViewManagerEngagementCandidate(");
  for (const landmark of [
    "canViewManagerCvEngagement(access)",
    "canSeeAllRecruitment(access)",
    "resolveHiringManagerScopeHrIds(access)",
    // The same three routes the report counts a candidate through.
    '"manager_notified_hr_id"',
    "MANAGER_SENDS_TABLE",
    "loadAllDistrictBoards()",
  ]) {
    assert.ok(scopeCheck.includes(landmark), `the per-candidate scope must use ${landmark}`);
  }
  // An NSM whose line resolves to nobody sees nobody — never everybody.
  assert.match(scopeCheck, /if \(scopeKeys\.size === 0\) return false;/);
  // And a candidate held by none of the routes is refused.
  assert.match(scopeCheck, /return false;\n\}$/, "the scope check must end by refusing");

  const routes = [
    {
      call: "listManagerEngagementCandidateFiles(candidateId)",
      file: "app/api/recruitment/manager-engagement/candidates/[candidateId]/files/route.ts",
    },
    {
      call: "getManagerEngagementCandidateFile(candidateId, fileId)",
      file: "app/api/recruitment/manager-engagement/candidates/[candidateId]/files/[fileId]/route.ts",
    },
  ];
  for (const route of routes) {
    const source = codeOnly(read(route.file));
    const checkAt = source.indexOf("canViewManagerEngagementCandidate(access, candidateId)");
    const fileAt = source.indexOf(route.call);
    assert.ok(checkAt > 0, `${route.file} must check the candidate is in the reader's line`);
    assert.ok(fileAt > 0, `${route.file} must still serve the file`);
    assert.ok(checkAt < fileAt, `${route.file} must check the scope BEFORE reading the file`);
    assert.match(source.slice(checkAt, fileAt), /status: 403/, `${route.file} must refuse an out-of-line candidate with 403`);
  }

  // ── 2. A DELETED OR MERGED CANDIDATE LEFT A GHOST FILING ──────────────────────────────────────
  //
  // `ats_cv_folder_items` has no foreign key, on purpose, so nothing removed a filing when its
  // candidate went. A folder went on counting a CV nobody could open.
  const candidates = codeOnly(read("src/lib/recruitment/candidates.ts"));
  const deleteBody = functionBody(candidates, "export async function deleteCandidate(");
  const filingDeleteAt = deleteBody.indexOf('.from("ats_cv_folder_items").delete().eq("candidate_id", id)');
  const candidateDeleteAt = deleteBody.indexOf('.from("ats_candidates").delete()');
  assert.ok(filingDeleteAt > 0, "deleting a candidate must delete their folder filings");
  assert.ok(candidateDeleteAt > 0, "deleting a candidate must still delete the candidate");
  assert.ok(
    filingDeleteAt < candidateDeleteAt,
    "the filings go FIRST — a failure part-way then leaves a visible unfiled candidate, never a ghost",
  );

  const merge = codeOnly(read("src/lib/recruitment/candidate-merge-service.ts"));
  const deduped = merge.slice(merge.indexOf("const dedupedChildTables"), merge.indexOf("];", merge.indexOf("const dedupedChildTables")));
  assert.match(
    deduped,
    /identityColumn: "id",\s*keyColumn: "folder_id",\s*onlyWhen: null,\s*orphansOnDelete: true,[\s\S]{0,120}table: "ats_cv_folder_items",/,
    "a merge must carry the duplicate's filings across — unique on (folder_id, candidate_id), no foreign key, so blocked rows are removed",
  );
  // Never a plain move: a folder BOTH records sit in would raise 23505 half-way through the merge.
  const plainMoves = merge.slice(merge.indexOf("const childTables"), merge.indexOf("] as const;", merge.indexOf("const childTables")));
  assert.ok(!plainMoves.includes("ats_cv_folder_items"), "folder filings must not be a plain re-point");

  // ── 3. THE MEMBERSHIP READS STOPPED AT 1,000 ROWS ─────────────────────────────────────────────
  //
  // An unbounded PostgREST select returns 1,000 rows with no marker. Past that, a folder silently
  // loses members and those CVs reappear in the main pool while still filed.
  const attach = functionBody(candidates, "function attachCvFolderMemberships(");
  assert.match(attach, /readAllFolderItemsOnce\(\)/, "the pool's membership read must go through the folder tree's paged reader");
  assert.doesNotMatch(attach, /from\("ats_cv_folder_items"\)/, "the pool must not keep a second filings read of its own");
  assert.match(attach, /\.sort\(\(left, right\) => compareFilingIds\(left\.id, right\.id\)\)/, "the shared rows must be grouped in id order, as the pool always grouped them");
  assert.doesNotMatch(attach, /\.select\("folder_id,candidate_id"\);/, "no unbounded membership select may remain");

  const tree = codeOnly(read("src/lib/recruitment/cv-folder-tree-db.ts"));
  const cabinetLoad = functionBody(tree, "export async function loadCvFolderCabinet(");
  assert.ok(cabinetLoad.includes("readAllFolderItemsOnce()"), "the folder tree must read its filings through the paged reader");
  assert.ok(
    tree.includes("export const readAllFolderItemsOnce = cache(async () => readAllFolderItems(recruitmentDb()));"),
    "the reader shared for the render must be the paged reader itself",
  );
  assert.doesNotMatch(cabinetLoad, /from\("ats_cv_folder_items"\)/, "the folder tree must not keep an unbounded filings select");
  const pagedRead = functionBody(tree, "async function readAllFolderItems(");
  assert.match(pagedRead, /\.range\(/, "the folder tree's filings read must be paged");
  assert.match(pagedRead, /\.order\("id"/, "filed_at ties must be broken on id so no page repeats or skips a row");
}
