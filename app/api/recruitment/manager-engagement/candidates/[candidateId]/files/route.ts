import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import {
  canViewManagerCvEngagement,
  canViewManagerEngagementCandidate,
  listManagerEngagementCandidateFiles,
} from "@/lib/recruitment/manager-cv-engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The silent manager-engagement report's OWN CV preview — deliberately NOT the hiring-manager file
// routes next door. Those record an open (which would pollute the very "opened" signal this report
// measures) and gate on `hiring_interviews`, a grant the CEO and the NSMs may not hold. The boundary
// here is the report's own audience — Super Admin, CEO, the three NSMs — and listing a CV records
// nothing. See manager-cv-engagement.ts for the full reasoning.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    if (!canViewManagerCvEngagement(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This report is not available to you.", success: false },
        { status: 403 },
      );
    }
    const { candidateId } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant answers as if absent.
    await assertCandidateVisible(access, candidateId);
    // The report is scoped to the reader's line, so its preview must be too — see the helper.
    if (!(await canViewManagerEngagementCandidate(access, candidateId))) {
      return NextResponse.json(
        { error: "forbidden", message: "This candidate is not in your line.", success: false },
        { status: 403 },
      );
    }
    const files = await listManagerEngagementCandidateFiles(candidateId);
    return NextResponse.json({ success: true, files });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load candidate files.");
  }
}
