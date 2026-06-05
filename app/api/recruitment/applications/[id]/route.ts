import { NextResponse } from "next/server";

import { getApplication } from "@/lib/recruitment/applications";
import { listInterviewsForApplication } from "@/lib/recruitment/interviews";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

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
