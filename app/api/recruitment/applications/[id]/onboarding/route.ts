import { NextResponse } from "next/server";

import { listOnboardingItems } from "@/lib/recruitment/onboarding";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    const items = await listOnboardingItems(access, id);
    return NextResponse.json({ success: true, items });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load onboarding checklist.");
  }
}
