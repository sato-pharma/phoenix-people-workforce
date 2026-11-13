import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { openDailyDeductionDispute } from "@/lib/dispute-center/daily.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The employee disputes one of HIS released daily deductions (owner, 2026-11-13: the Deductions page
// showed them with no Dispute button). Self-only and one dispute per line — openDailyDeductionDispute
// checks both against the active snapshot before anything is written. The conversation after the
// opening lives in the Dispute Center.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const dispute = await openDailyDeductionDispute(access, {
      body: String(body.body ?? ""),
      lineId: String(body.lineId ?? "").trim(),
    });
    return NextResponse.json({ dispute, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to send this dispute.");
  }
}
