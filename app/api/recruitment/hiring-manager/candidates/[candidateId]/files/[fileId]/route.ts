import { NextResponse } from "next/server";

import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { downloadHiringManagerCandidateFile } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a manager is told when he asks this route for the file itself rather than for the render. */
const DOWNLOAD_BLOCKED =
  "CVs are read on screen here. Ask the recruitment team if you need a copy of this document.";

// Gated on the narrow `hiring_interviews` resource (not `recruitment`/`candidates`) — see
// hiring-manager-view.ts for why.
//
// ── THIS ROUTE NO LONGER HANDS OVER A FILE ─────────────────────────────────────────────────────
//
// The owner, 2026-09-09: *"the download to be blocked of the cv"*. So of file-response.ts's three
// delivery modes this route now serves exactly ONE — `?format=base64`, the plain-text encoding the
// in-page renderer decodes and paints onto a canvas. The other two are refused:
//
//   • the bare URL (Content-Disposition: attachment) — a save-file prompt, which is the download;
//   • `?disposition=inline` — the open-in-a-new-tab escape hatch, which is the same bytes with the
//     same filename and one keystroke from being saved. Blocking one and not the other blocks
//     nothing, and the inline URL is the one a curious manager finds first because the preview's own
//     failure notice used to link to it.
//
// THE PORTAL IS THE ONLY CALLER OF THIS ROUTE, so nothing else loses anything: the recruitment
// workspace, screening and the CV database all read the sibling route under /api/recruitment/, which
// is unchanged and still downloads. This is the manager's copy of the door, and only this one is
// shut.
//
// AN EXTERNAL FILE IS REFUSED TOO, for the same reason and with the same wording. A redirect hands
// the manager the raw document at somebody else's origin, where nothing here reaches — the one shape
// of this route that could still produce a saved file. Measured on production 2026-09-09: all 1,188
// rows in ats_files carry a drive_file_id and NOT ONE is external-only, so this refuses nothing that
// exists today. It exists so that the day an external CV is created, the block does not quietly stop
// applying to it.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId, fileId } = await params;

    // Asked BEFORE the file is fetched. A refusal that first downloads several megabytes out of
    // Drive is the same refusal with a bill attached.
    if (new URL(request.url).searchParams.get("format") !== "base64") {
      return NextResponse.json(
        { error: "forbidden", message: DOWNLOAD_BLOCKED, success: false },
        { status: 403 },
      );
    }

    const download = await downloadHiringManagerCandidateFile(access, candidateId, fileId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") {
      return NextResponse.json(
        { error: "forbidden", message: DOWNLOAD_BLOCKED, success: false },
        { status: 403 },
      );
    }
    // Reached only with format=base64, so this returns the plain-text encoding — no document
    // content-type, no filename, no Content-Disposition. See file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
