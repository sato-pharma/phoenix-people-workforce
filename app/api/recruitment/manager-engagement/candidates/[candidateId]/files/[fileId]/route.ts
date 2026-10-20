import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { resolveAccessContext } from "@/lib/auth/server";
import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import {
  canViewManagerCvEngagement,
  canViewManagerEngagementCandidate,
  getManagerEngagementCandidateFile,
} from "@/lib/recruitment/manager-cv-engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves the CV bytes for the report's in-place preview. SILENT: unlike the hiring-manager download
// route it records no open — the readers of this report are watching the managers, not screening the
// folder themselves, so a view here must not become an "opened" mark. Gated on the report's own
// audience, same as the file-list route beside it.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    if (!canViewManagerCvEngagement(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This report is not available to you.", success: false },
        { status: 403 },
      );
    }
    const { candidateId, fileId } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's file answers as if absent.
    await assertCandidateVisible(access, candidateId, "File not found.");
    // The report is scoped to the reader's line, so its preview must be too — see the helper.
    if (!(await canViewManagerEngagementCandidate(access, candidateId))) {
      return NextResponse.json(
        { error: "forbidden", message: "This candidate is not in your line.", success: false },
        { status: 403 },
      );
    }
    const download = await getManagerEngagementCandidateFile(candidateId, fileId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.redirect(download.url);
    }
    // Shares CvPreviewModal with every other CV surface, so it must offer the same inline / base64
    // delivery modes — see file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
