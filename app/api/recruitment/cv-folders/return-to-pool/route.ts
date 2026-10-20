import { NextResponse } from "next/server";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";

import { returnCandidatesToPoolFromCvFolders } from "@/lib/recruitment/cv-folder-tree-db";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Put CVs back in the main pool — out of EVERY hand-built folder, not one.
 *
 * ITS OWN ROUTE, not a flag on the per-folder DELETE, because the two answer different questions and
 * the difference is invisible until it bites. Taking a CV out of one folder leaves it hidden from
 * the pool when a copy of it sits in another; only this clears the last membership. A flag would
 * make "return to the pool" and "take out of this folder" one call that behaves differently
 * depending on a boolean, and the failure — a recruiter told somebody was back who is still hidden —
 * shows up as "the pool is missing people" weeks later, with nothing pointing here.
 *
 * A POST rather than a DELETE: it names candidates, not a folder, so there is no resource in the
 * path to delete, and the body carries the list.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const body = await readJsonObject(request);

    const raw = Array.isArray(body.candidateIds) ? body.candidateIds : [];
    const candidateIds = [...new Set(raw.map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (candidateIds.length === 0) return recruitmentProblem("Pick at least one CV to return.", 400);
    // The Talent Acquisition fence (owner, 2026-10-20): a batch naming an HR applicant is refused whole, as not found.
    await assertCandidatesVisible(access, candidateIds);

    const result = await returnCandidatesToPoolFromCvFolders(candidateIds);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to return these CVs to the pool.");
  }
}
