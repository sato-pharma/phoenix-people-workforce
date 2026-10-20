import { NextResponse } from "next/server";

import { recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError, unauthorizedError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { recruitmentFileResponse } from "@/lib/recruitment/file-response";
import { getFileForDownload, listCandidateFiles } from "@/lib/recruitment/files";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import { workspaceViewer } from "@/lib/recruitment/workspace/role-tabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CV file of one candidate, for anyone the workspace admits — the CEO included (owner,
 * 2026-10-20: "answers and optional the cv file").
 *
 * Gated by the workspace's own named rule (`workspaceViewer`), never by `candidates: read`: the CEO
 * reads the workspace and must never hold the pool's grant (`tests/ceo-account-contract.test.ts`).
 * It is READ ONLY and NARROW on purpose — the candidate's files and nothing else. Notes, the timeline
 * and the WhatsApp chat stay on the recruitment team's own routes.
 *
 *   GET                → { files }: the candidate's files, newest first.
 *   GET ?file=<id>     → that file (the viewer's own `format=` / `disposition=` modes apply), only
 *                        when it is one of THIS candidate's files.
 *
 * The Talent Acquisition fence holds here as everywhere: a hidden person answers as if absent.
 */
export async function GET(request: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) throw unauthorizedError();
    if (!workspaceViewer(access).canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");
    const { candidateId } = await params;
    // Checked before the database is asked: a malformed id is refused by Postgres as a whole query
    // (22P02), which would put a 500 where "not found" belongs.
    if (!isUuid(candidateId)) {
      return NextResponse.json({ error: "not_found", message: "Candidate not found.", success: false }, { status: 404 });
    }
    await assertCandidateVisible(access, candidateId);

    const files = await listCandidateFiles(candidateId);
    const fileId = new URL(request.url).searchParams.get("file");
    if (!fileId) {
      return NextResponse.json({ files, success: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!files.some((file) => file.id === fileId)) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    const download = await getFileForDownload(fileId);
    if (!download) {
      return NextResponse.json({ error: "not_found", message: "File not found.", success: false }, { status: 404 });
    }
    if (download.kind === "external") return NextResponse.redirect(download.url);
    return recruitmentFileResponse(request, download);
  } catch (error) {
    return recruitmentApiError(error, "The CV could not be loaded.");
  }
}
