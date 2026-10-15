import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { canBuildJobPosts } from "@/lib/recruitment/access";
import { updateJobPostTitle } from "@/lib/recruitment/job-posts/service";
import { coerceTitleDraft } from "@/lib/recruitment/job-posts/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save a job title. A WHOLE-ROW save, not a partial patch: the builder always holds the full title
 * (its two lists are edited as a whole), so the server validates exactly what it stores.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    if (!canBuildJobPosts(access)) {
      return recruitmentProblem("Job Posts is open to the Super Admin and Talent Acquisition.", 403);
    }
    const { id } = await params;
    const draft = coerceTitleDraft(await readJsonObject(request));
    const title = await updateJobPostTitle(id, draft, access.hrId ?? null);
    return NextResponse.json({ success: true, title });
  } catch (error) {
    return recruitmentApiError(error, "Failed to save the job title.");
  }
}
