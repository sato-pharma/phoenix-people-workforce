import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { openDailyDeductionDispute } from "@/lib/dispute-center/daily.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { validationError } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Dispute box under a released daily line sends `{ explanation, lineId }` — the reason picked from
 * the list (`{ reasonCode, confirmerHrId, detailText }`) and the line's id. Both are optional here so an
 * empty body still reaches openDailyDeductionDispute's own checks (self-only, one per line, a reason);
 * the explanation is handed over exactly as sent.
 */
const DailyDisputeBodySchema = z.object({
  explanation: z.unknown().optional(),
  lineId: z.string().nullish(),
});

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
    const parsed = await parseJsonBody(request, DailyDisputeBodySchema, { fallback: {} });
    if (!parsed.ok) throw validationError(parsed.message);
    const body = parsed.data;
    const dispute = await openDailyDeductionDispute(access, {
      explanation: body.explanation,
      lineId: String(body.lineId ?? "").trim(),
    });
    return NextResponse.json({ dispute, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to send this dispute.");
  }
}
