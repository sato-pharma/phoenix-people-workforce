import { NextResponse } from "next/server";

import { assertSameOriginMutation, recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { markMrAreaNoticeSeen } from "@/lib/recruitment/mr-hiring/area-notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Got it" on the portal home's banner: a manager dismisses one notice of a Medical Rep candidate HR
// passed for his area (owner, 7 Nov 2026). Only the manager the notice was written for may — the
// domain matches the row to the caller's own HR id and answers "not found" for anyone else's.
export async function POST(request: Request, { params }: { params: Promise<{ noticeId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!access.hrId) return recruitmentProblem("Sign in again to dismiss the notice.", 401);
    await assertPermission(access, "employee_profile", "read");
    const { noticeId } = await params;
    await markMrAreaNoticeSeen(access.hrId, noticeId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Could not dismiss the notice.");
  }
}
