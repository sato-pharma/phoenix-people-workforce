import { NextResponse } from "next/server";

import { approveSeniorOffer } from "@/lib/recruitment/applications";
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
    // Route gate is recruitment:approve; the service further restricts the
    // actual sign-off to Super Admin.
    const access = await requireRecruitmentAccess(request, "recruitment", "approve");
    const { id } = await params;
    const application = await approveSeniorOffer(id, access);
    return NextResponse.json({ success: true, application });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record senior sign-off.");
  }
}
