import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getMarketingRequestCaseFile } from "@/lib/marketing-requests/case-file-service";

// One consolidated read of a single marketing request. GET only — nothing here writes, and the
// capability booleans on `caseFile.viewer.can` are affordances the acting routes (decision,
// comment, resubmit) each re-enforce for themselves. Access is settled inside
// getMarketingRequestCaseFile, which fails closed on a missing HR_ID and on a failed lookup.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const caseFile = await getMarketingRequestCaseFile(id, access);
    return NextResponse.json({ caseFile, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden.", success: false }, { status: 403 });
    }
    const apiError = toApiError(error, "Marketing request case file failed.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message, success: false },
      { status: apiError.status },
    );
  }
}
