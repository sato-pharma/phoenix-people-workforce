import { NextResponse } from "next/server";

import { recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { loadMrCvAndApplication, loadMrCvFile } from "@/lib/recruitment/mr-hiring/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Medical Rep candidate's CV and application, at every step and for everyone involved (owner,
// 7 Nov 2026: "the cv and application must appear and be appearing in all steps for every one"):
// the HR Manager, Talent Acquisition, the CEO, and every manager on one of the candidate's interviews,
// sent the CV, or above the manager who was — exactly who reads the journey (`mayReadMrJourney`).
// Anyone else is told the candidate is not there. READ ONLY and NARROW: the files and the answers.
//
//   GET                → { files, application, phonesHidden }
//   GET ?file=<id>     → that file (the viewer's own `format=` / `disposition=` modes apply), only when
//                        it is one of THIS candidate's files.
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) return recruitmentProblem("Sign in again to open the CV.", 401);
    const { candidateId } = await params;
    if (!isUuid(candidateId)) return recruitmentProblem("Candidate not found.", 404);
    await assertCandidateVisible(access, candidateId);

    const fileId = new URL(request.url).searchParams.get("file");
    if (!fileId) {
      const body = await loadMrCvAndApplication(access, candidateId);
      return NextResponse.json({ ...body, success: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const download = await loadMrCvFile(access, candidateId, fileId);
    if (!download) return recruitmentProblem("File not found.", 404);
    if (download.kind === "external") return NextResponse.redirect(download.url);
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "The CV could not be loaded.");
  }
}
