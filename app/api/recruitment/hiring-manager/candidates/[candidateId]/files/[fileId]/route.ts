import { NextResponse } from "next/server";

import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { downloadHiringManagerCandidateFile } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a manager is told when he asks this route for the file itself rather than for the render. */
const DOWNLOAD_BLOCKED =
  "CVs are read on screen here. Ask the recruitment team if you need a copy of this document.";

/**
 * The delivery modes that are a RENDER rather than a file, and so the only ones this route serves.
 *
 * Both hand the browser something to paint and neither hands over a document: no filename, no
 * document content-type, no Content-Disposition, nothing a save-file prompt or a download-manager
 * extension can act on (file-response.ts).
 *
 *   • `base64` — the bytes as plain text, decoded in the page and painted onto a canvas (PDF) or
 *     into real DOM (a modern .docx).
 *   • `doc-text` — the lines of a Word 97-2003 binary .doc, read on the server because no browser
 *     can open that format at all. Added 2026-09-27: without it the ONE format the manager's
 *     screen cannot render had nowhere to go, and his card said so in a sentence.
 */
const RENDER_ONLY_FORMATS = new Set(["base64", "doc-text"]);

// Gated on the narrow `hiring_interviews` resource (not `recruitment`/`candidates`) — see
// hiring-manager-view.ts for why.
//
// ── THIS ROUTE NO LONGER HANDS OVER A FILE ─────────────────────────────────────────────────────
//
// The owner, 2026-09-09: *"the download to be blocked of the cv"*. So of file-response.ts's four
// delivery modes this route serves only the two that are a RENDER — see RENDER_ONLY_FORMATS above.
// The two that are a FILE are refused:
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
    const format = new URL(request.url).searchParams.get("format");
    if (!format || !RENDER_ONLY_FORMATS.has(format)) {
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
    // Reached only with a render format, so this returns the plain-text encoding of the bytes or
    // the lines of a legacy .doc — no document content-type, no filename, no Content-Disposition
    // either way. See file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
