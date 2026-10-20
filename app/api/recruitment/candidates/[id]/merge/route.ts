import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { mergeCandidates } from "@/lib/recruitment/candidate-merge-service";
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
 * Joins a duplicate candidate into this one. `[id]` is the record that SURVIVES; the id in the
 * body is the one that is emptied and deleted.
 *
 * That direction is deliberate. The soft-duplicate flag is written onto BOTH rows of a pair, each
 * pointing at the other, so the recruiter chooses which way round it goes simply by clicking the
 * row they want gone — no extra control, and no chance of the wrong record being kept because a
 * default picked it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const body = await readJsonObject(request);

    const duplicateId = str(body.duplicateId);
    if (!duplicateId) {
      return NextResponse.json(
        { error: "validation", message: "Tell me which duplicate record to merge in.", success: false },
        { status: 400 },
      );
    }

    await assertCandidateVisible(access, duplicateId);
    const result = await mergeCandidates(access, { duplicateId, survivorId: id });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to merge the candidate records.");
  }
}
