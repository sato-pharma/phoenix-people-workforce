import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { runApplicationTransition } from "@/lib/recruitment/applications";
import type { RecruitmentActionKey } from "@/lib/recruitment/types";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const action = str(body.action) as RecruitmentActionKey | null;
    if (!action) {
      return NextResponse.json({ error: "invalid_request", message: "An action is required.", success: false }, { status: 400 });
    }
    const application = await runApplicationTransition(id, action, access, { reason: str(body.reason) });
    return NextResponse.json({ success: true, application });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update application.");
  }
}
