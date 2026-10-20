import { NextResponse } from "next/server";

import { revealPhoneToViewer } from "@/lib/recruitment/candidate-call-claims";
import { loadCallClaim } from "@/lib/recruitment/candidate-call-claims-db";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { downloadHiringManagerCandidateFile, isCandidateSentToCaller } from "@/lib/recruitment/hiring-manager-view";
import { recruitmentApiError, requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a manager is told when he asks this route for the file of a CV nobody sent him. */
const DOWNLOAD_BLOCKED = "This CV was not sent to you, so its file is read on screen only.";

/**
 * The delivery modes that are a RENDER rather than a file. Every manager in scope gets these.
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
// ── THE FILE GOES TO THE MANAGER A PERSON SENT IT TO, AND TO THE ONE HOLDING A RESERVATION ──────
//
// OWNER, 2026-10-16: once a CV has reached a manager from Talent Acquisition there is "no restriction
// — he can download, see the number, do anything". So a CV sent to the caller (his folders ARE his
// sends) is served as the file itself, with no "I will call" first. The reservation route below is
// kept for the other case this route still serves — a CV the caller reaches by seniority or by an
// application he owns — where the number stays hidden until he asks for it.
//
// What follows is the earlier rule, which now covers only those CVs:
//
// The owner blocked the manager's download on 2026-09-09 (*"the download to be blocked of the cv"*)
// and, on 2026-10-13, asked for managers to be able to download any CV from wherever they find it.
// Asked which way round, with the original file carrying the very phone number the "I will call"
// rule hides, he chose: download only after "I will call". So the rule is the phone number's own —
// `revealPhoneToViewer`, the one place that decides who may see a number — and it is asked HERE, on
// the server. A card that offers a Download link while this URL serves the file to anyone has
// blocked nothing, and that URL is one right-click away.
//
//   • a RENDER (`format=base64` / `doc-text`) — any manager in scope, as ever; the page paints the
//     phone numbers out of it until the reservation is taken;
//   • the FILE (the bare URL, a save-file prompt; or `?disposition=inline`, the open-in-a-new-tab
//     link) — only the manager whose reservation stands on this candidate.
//
// AN EXTERNAL FILE IS STILL REFUSED. A redirect hands over the raw document at somebody else's
// origin, where nothing here reaches. Measured on production 2026-09-09: all 1,188 rows in ats_files
// carry a drive_file_id and NOT ONE is external-only, so this refuses nothing that exists today.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ candidateId: string; fileId: string }> },
) {
  try {
    const access = await requireRecruitmentAccess(request, "hiring_interviews", "read");
    const { candidateId, fileId } = await params;
    await assertCandidateVisible(access, candidateId);

    // Asked BEFORE the file is fetched. A refusal that first downloads several megabytes out of
    // Drive is the same refusal with a bill attached.
    const format = new URL(request.url).searchParams.get("format");
    const isRender = Boolean(format && RENDER_ONLY_FORMATS.has(format));
    if (
      !isRender &&
      !(await isCandidateSentToCaller(access, candidateId)) &&
      !revealPhoneToViewer(await loadCallClaim(candidateId), access.hrId)
    ) {
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
    // A render format returns the plain-text encoding of the bytes or the lines of a legacy .doc —
    // no document content-type, no filename, no Content-Disposition. Any other mode reaches here
    // only for the reservation holder and is the real file. See file-response.ts.
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "File download failed.");
  }
}
