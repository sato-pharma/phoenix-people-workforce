import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { sendCandidateToHiringManager } from "@/lib/recruitment/applications";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send the candidate to the position's hiring manager, on purpose.
 *
 * Until now this only ever fired as a side effect of picking a value in a dropdown, inside a
 * `catch {}` that threw the error away — so a send that failed looked exactly like a send that
 * worked. This route exists so the act is deliberate, repeatable, and answerable: it returns who
 * was notified and when, so the caller can put it on screen instead of hoping.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const result = await sendCandidateToHiringManager(access, id);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return recruitmentApiError(error, "Failed to send the candidate to the hiring manager.");
  }
}
