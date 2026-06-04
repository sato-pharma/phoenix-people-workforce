import { NextResponse } from "next/server";

import { importCandidatesWorkbook } from "@/lib/recruitment/candidates";
import { validationError } from "@/lib/http/api-errors";
import {
  assertSameOriginMutation,
  recruitmentApiError,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "candidates", "import");
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw validationError("A spreadsheet file is required.");
    }
    const buffer = await file.arrayBuffer();
    const summary = await importCandidatesWorkbook(buffer, access);
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    return recruitmentApiError(error, "Candidate import failed.");
  }
}
