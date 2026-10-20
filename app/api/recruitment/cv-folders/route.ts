import { NextResponse } from "next/server";
import { fenceCandidateIds } from "@/lib/recruitment/workspace/fence";

import { buildCvFolderTree } from "@/lib/recruitment/cv-folder-tree";
import { createCvFolder, loadCvFolderCabinet } from "@/lib/recruitment/cv-folder-tree-db";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The whole folder tree, with what is in each folder.
 *
 * `candidates: read` and not `recruitment: read`, matching every other route that hands back
 * anything about a named applicant — these rows say which people the recruitment team is keeping in
 * reserve and under what heading.
 *
 * Returns the BUILT tree rather than the flat rows, so the client and the server-rendered page
 * cannot disagree about depth, ordering, or a folder's real (distinct) CV count. The one rule that
 * would be easy to get wrong on the client is the distinct roll-up — a copy legitimately puts one
 * person in a parent and its child, and adding the two up overstates the folder.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const cabinet = await loadCvFolderCabinet();
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is neither listed nor counted.
    const visible = await fenceCandidateIds(access, [...cabinet.members.values()].flat());
    const members = new Map([...cabinet.members].map(([folderId, ids]) => [folderId, ids.filter((id) => visible.has(id))]));
    return NextResponse.json({
      folders: buildCvFolderTree(cabinet.rows, members),
      success: true,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the CV folders.");
  }
}

/**
 * Create a folder, or a subfolder when `parentId` is given.
 *
 * `candidates: update` rather than `read` — this changes shared state that every other recruiter
 * sees. The owner chose one shared tree for the team on 2026-09-12, so a folder somebody creates is
 * a folder everybody gets.
 *
 * Every rule about the name, the depth and the sibling clash lives in cv-folder-tree.ts and is
 * applied by `createCvFolder`, which reads the tree first. Nothing is re-decided here: this route
 * coerces the body and lets the refusal come back as the sentence it already is.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const body = await readJsonObject(request);

    const folder = await createCvFolder(access, {
      name: String(body.name ?? ""),
      // `str` collapses "" to null, which is exactly what a top-level folder means here.
      parentId: str(body.parentId),
    });
    return NextResponse.json({ folder, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create the folder.");
  }
}
