import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { getMarketingAllRequestsWorkspace } from "@/lib/marketing-requests/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Company-wide marketing request register — Marketing Manager / SFE Manager / Super Admin. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingAllRequestsWorkspace(access));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const apiError = toApiError(error, "Unable to load the marketing request register.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
