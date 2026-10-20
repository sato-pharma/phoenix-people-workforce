import { NextResponse } from "next/server";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";

import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror";
import { listCandidateFiles, uploadCandidateFile } from "@/lib/recruitment/files";
import { validationError } from "@/lib/http/api-errors";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "candidates", "read");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const files = await listCandidateFiles(id);
    return NextResponse.json({ success: true, files });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load files.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "update");
    const { id } = await params;
    await assertCandidateVisible(access, id);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw validationError("A file is required.");
    }
    const bytes = await file.arrayBuffer();
    const uploaded = await uploadCandidateFile(access, {
      candidateId: id,
      applicationId: str(formData.get("applicationId")),
      kind: str(formData.get("kind")),
      fileName: file.name || "upload",
      mimeType: file.type || "application/octet-stream",
      bytes,
      origin: "ats_upload",
      sizeBytes: file.size,
    });
    // Mirrored from HERE, because no inbound worker will ever see this file. Best-effort and
    // swallowed: the upload itself has already succeeded and the response must not fail on Drive.
    // `mirrorCandidateCvsToDrive` filters to `kind = "cv"` itself, so a non-CV attachment costs one
    // query and uploads nothing.
    await mirrorCandidateCvsToDrive(id).catch(() => {});
    return NextResponse.json({ success: true, file: uploaded }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "File upload failed.");
  }
}
