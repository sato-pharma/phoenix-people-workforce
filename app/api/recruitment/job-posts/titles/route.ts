import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { canBuildJobPosts } from "@/lib/recruitment/access";
import { createJobPostTitle, listJobPostTitles } from "@/lib/recruitment/job-posts/service";
import { coerceTitleDraft } from "@/lib/recruitment/job-posts/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_YOURS = "Job Posts is open to the Super Admin and Talent Acquisition.";

/** Every job title the Job Posts page can build from, switched-off ones included (that is how one is switched back on). */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    if (!canBuildJobPosts(access)) return recruitmentProblem(NOT_YOURS, 403);
    const titles = await listJobPostTitles({ includeInactive: true });
    return NextResponse.json({ success: true, titles });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the job titles.");
  }
}

/** Add a job title, with its duties and requirements. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "create");
    if (!canBuildJobPosts(access)) return recruitmentProblem(NOT_YOURS, 403);
    const draft = coerceTitleDraft(await readJsonObject(request));
    const title = await createJobPostTitle(draft, access.hrId ?? null);
    return NextResponse.json({ success: true, title });
  } catch (error) {
    return recruitmentApiError(error, "Failed to add the job title.");
  }
}
