import { NextResponse } from "next/server";

import { deleteApplication, getApplication } from "@/lib/recruitment/applications";
import { listInterviewsForApplication } from "@/lib/recruitment/interviews";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const application = await getApplication(access, id);
    if (!application) {
      return NextResponse.json({ error: "not_found", message: "Application not found.", success: false }, { status: 404 });
    }
    const interviews = await listInterviewsForApplication(access, id);
    return NextResponse.json({ success: true, application, interviews });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load application.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "delete");
    const { id } = await params;
    await deleteApplication(access, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to delete application.");
  }
}
