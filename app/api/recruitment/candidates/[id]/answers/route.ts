import { NextResponse } from "next/server";

import { isUuid } from "@/lib/http/uuid";
import { assertCandidateVisible, CANDIDATE_NOT_FOUND } from "@/lib/recruitment/workspace/fence";
import { loadPlacingForm, placeWithAnswers } from "@/lib/recruitment/workspace/placing";
import { assertWorkspaceWorker } from "@/lib/recruitment/workspace/candidate-actions";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Place this candidate" (owner, 20 Oct 2026): HR picks what the person is applying for, the region
 * and that region's area, and types the WhatsApp answers the bot never got; the person is filed from
 * them. The rules are src/lib/recruitment/workspace/placing.ts.
 *
 * GET `?family=` — the form: the roles this viewer may file, that role's questions, its regions and
 * areas, and every answer already on record. PUT — `{ roleFamily, regionCode, areaCode, answers }`,
 * `answers` holding only what HR changed; answers with every tab the person is now filed in.
 *
 * `candidates: update` (Super Admin and Talent Acquisition), the workspace's own work gate (the CEO
 * reads, never files), and the Talent Acquisition fence by person before any read or write — the form
 * itself never offers her an HR role, and the server refuses one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);
    const family = str(new URL(request.url).searchParams.get("family"));
    const form = await loadPlacingForm(access, id, family);
    return NextResponse.json({ ...form, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the placing form.");
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    assertWorkspaceWorker(access);
    const { id } = await params;
    if (!isUuid(id)) return recruitmentProblem(CANDIDATE_NOT_FOUND, 404);
    await assertCandidateVisible(access, id);

    const body = await readJsonObject(request);
    const rawAnswers = body.answers;
    if (rawAnswers !== undefined && (rawAnswers === null || typeof rawAnswers !== "object" || Array.isArray(rawAnswers))) {
      return recruitmentProblem("The answers are a list of question and answer.", 400);
    }
    const result = await placeWithAnswers(access, id, {
      answers: (rawAnswers ?? {}) as Record<string, string | null>,
      areaCode: str(body.areaCode),
      regionCode: str(body.regionCode),
      roleFamily: str(body.roleFamily),
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not place this CV.");
  }
}
