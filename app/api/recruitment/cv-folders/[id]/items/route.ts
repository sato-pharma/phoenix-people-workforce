import { NextResponse } from "next/server";
import { assertCandidatesVisible } from "@/lib/recruitment/workspace/fence";

import {
  fileCandidatesInCvFolder,
  removeCandidatesFromCvFolder,
  type CvFolderFileMode,
} from "@/lib/recruitment/cv-folder-tree-db";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a `candidateIds` array off a loosely-typed body, deduped and with the blanks dropped. */
function candidateIdList(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.candidateIds) ? body.candidateIds : [];
  return [...new Set(raw.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

/**
 * Push CVs into this folder — the move/copy the owner asked for on 2026-09-12.
 *
 * `mode` is `move` (the default) or `copy`, and the difference is real rather than cosmetic:
 *
 *   move   this candidate's other folder memberships are deleted first, so the CV ends up in
 *          exactly one folder however many it was in before.
 *   copy   nothing else is touched, so the same CV is now in this folder AND wherever it already
 *          was. This is the case the join table exists for.
 *
 * DEFAULTING TO `move` IS THE SAFE DIRECTION, not merely the common one. A mistyped mode that fell
 * through to `copy` would leave CVs quietly multiplying across folders, and the recruiter's own
 * count would stop matching what he filed; a mistyped mode that moves is one undo.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    const candidateIds = candidateIdList(body);
    if (candidateIds.length === 0) return recruitmentProblem("Pick at least one CV to file.", 400);

    const requested = String(body.mode ?? "move");
    if (requested !== "move" && requested !== "copy") {
      return recruitmentProblem(`"${requested}" is not a filing mode. Use move or copy.`, 400);
    }
    const mode: CvFolderFileMode = requested;

    // A batch naming someone she may not see is refused whole, as not found (owner, 2026-10-20).
    await assertCandidatesVisible(access, candidateIds);
    const result = await fileCandidatesInCvFolder(access, { candidateIds, folderId: id, mode });
    return NextResponse.json({ ...result, mode, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to file these CVs.");
  }
}

/**
 * Take CVs out of THIS folder, leaving any other folder they sit in alone.
 *
 * Deliberately NOT "return to the pool": a CV that was copied into two folders is still filed after
 * this, and still hidden from the pool, which is correct — it is still in the other folder. Putting
 * somebody back in the pool is POST /api/recruitment/cv-folders/return-to-pool, which clears every
 * membership at once, and the two are separate routes precisely so neither can be mistaken for the
 * other by a caller passing one flag differently.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    const candidateIds = candidateIdList(body);
    if (candidateIds.length === 0) return recruitmentProblem("Pick at least one CV to take out.", 400);
    await assertCandidatesVisible(access, candidateIds);

    const result = await removeCandidatesFromCvFolder({ candidateIds, folderId: id });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to take these CVs out of the folder.");
  }
}
