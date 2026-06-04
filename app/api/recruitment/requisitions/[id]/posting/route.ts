import { NextResponse } from "next/server";

import { createJobPosting } from "@/lib/recruitment/postings";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const link = await createJobPosting(access, id);
    return NextResponse.json({ success: true, token: link.token, path: link.path });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create application link.");
  }
}
