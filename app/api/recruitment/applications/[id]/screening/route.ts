import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { recordScreeningOutcome, type ScreeningStage } from "@/lib/recruitment/screening";
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
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);
    const body = await readJsonObject(request);

    const stage = str(body.stage);
    if (stage !== "cv" && stage !== "phone" && stage !== "hm") {
      return NextResponse.json({ error: "validation", message: "Screening stage must be 'cv', 'phone', or 'hm'.", success: false }, { status: 400 });
    }
    const outcome = str(body.outcome);
    if (!outcome) {
      return NextResponse.json({ error: "validation", message: "An outcome is required.", success: false }, { status: 400 });
    }

    await recordScreeningOutcome(access, id, stage as ScreeningStage, {
      outcome,
      score: (body.score ?? null) as Record<string, unknown> | null,
      notes: str(body.notes),
      reason: str(body.reason),
      currentEmployer: str(body.currentEmployer),
      expectedSalary: num(body.expectedSalary),
      noticePeriod: str(body.noticePeriod),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to record screening outcome.");
  }
}
