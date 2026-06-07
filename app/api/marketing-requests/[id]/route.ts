import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getMarketingRequestDetail } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const detail = await getMarketingRequestDetail(id, access);
    return NextResponse.json({ detail, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden.", success: false }, { status: 403 });
    }
    const apiError = toApiError(error, "Marketing request detail failed.");
    return NextResponse.json(
      { error: apiError.code, message: apiError.message, success: false },
      { status: apiError.status },
    );
  }
}
