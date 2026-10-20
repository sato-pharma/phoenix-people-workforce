import { NextResponse } from "next/server";
import { assertApplicationVisible } from "@/lib/recruitment/workspace/fence";

import { getApplication } from "@/lib/recruitment/applications";
import { buildHireDraft } from "@/lib/recruitment/hire-draft";
import { getOffer } from "@/lib/recruitment/offers";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What HR's "Add Employee" form can already know about this hire — read by the employees page when
 * a recruiter arrives there from an application, so the CV is not retyped into a form standing
 * next to it.
 *
 * Read-only, and it creates nothing. The employee record is still made by the normal HR flow, with
 * the salary breakdown, bank and insurance details recruitment has no way to know.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "read");
    const { id } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's application answers as if absent.
    await assertApplicationVisible(access, id);

    const application = await getApplication(access, id);
    if (!application) {
      return NextResponse.json(
        { error: "not_found", message: "Application not found.", success: false },
        { status: 404 },
      );
    }
    if (!application.candidate) {
      return NextResponse.json(
        { error: "not_found", message: "This application has no candidate record.", success: false },
        { status: 404 },
      );
    }

    const offer = await getOffer(id);
    const draft = buildHireDraft({
      candidate: application.candidate,
      offer,
      requisition: application.requisition,
    });

    return NextResponse.json({
      success: true,
      draft,
      candidateName: application.candidate.fullName,
      applicationCode: application.applicationCode,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to build the hire draft.");
  }
}
