import { NextResponse } from "next/server";

import { updateOnboardingItem, type UpdateOnboardingItemInput } from "@/lib/recruitment/onboarding";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    const body = await readJsonObject(request);

    const input: UpdateOnboardingItemInput = {};
    if ("status" in body) input.status = str(body.status);
    if ("fileId" in body) input.fileId = str(body.fileId);
    if ("notes" in body) input.notes = str(body.notes);

    const item = await updateOnboardingItem(access, id, input);
    return NextResponse.json({ success: true, item });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update onboarding item.");
  }
}
