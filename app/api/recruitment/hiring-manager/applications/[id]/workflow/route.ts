import { NextResponse } from "next/server";

import { runApplicationTransition } from "@/lib/recruitment/applications";
import type { RecruitmentActionKey } from "@/lib/recruitment/types";
import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Gated on `hiring_interviews` (not `recruitment`) — see hiring-manager-view.ts. Deliberately
// whitelists only the two actions a hiring manager's own decision maps to — "proceed to second
// interview" (hands off to Talent Acquisition's final-selection stage) or "not qualified".
// Everything else in the 26-stage pipeline stays reachable only from the Talent Acquisition
// workspace (/api/recruitment/applications/:id/workflow), which still requires `recruitment`.
const allowedActions = new Set<RecruitmentActionKey>(["app_record_hm_interview", "app_reject"]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "update");
    const { id } = await params;
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const action = str(body.action) as RecruitmentActionKey | null;
    if (!action || !allowedActions.has(action)) {
      return NextResponse.json(
        { error: "invalid_request", message: "Only proceed/not-qualified decisions are allowed here.", success: false },
        { status: 400 },
      );
    }
    const application = await runApplicationTransition(id, action, access, { reason: str(body.reason) });
    return NextResponse.json({ success: true, application });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record your decision.");
  }
}
