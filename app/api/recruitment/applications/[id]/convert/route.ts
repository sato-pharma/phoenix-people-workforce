import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { markApplicationHired } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  num,
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
    const access = await requireRecruitmentAccess(request, "recruitment", "approve");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);
    const employeeHrId = str(body.employeeHrId);
    if (!employeeHrId) throw new Error("employeeHrId is required.");
    const result = await markApplicationHired(id, access, {
      employeeHrId,
      startDate: str(body.startDate),
      probationMonths: num(body.probationMonths),
      // Key present but blank => clear; absent => leave whatever was tagged before untouched.
      attributedChannelCode: "attributedChannelCode" in body ? str(body.attributedChannelCode) : undefined,
    });
    return NextResponse.json({
      success: true,
      application: result.application,
      employeeHrId: result.employeeHrId,
      // Flagged, not rejected: the hire went through and a human decides what the
      // difference means. Empty array when the employee matches the approved offer.
      termMismatches: result.termMismatches,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to mark this application as hired.");
  }
}
