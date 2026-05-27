import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { listOutstationRequests } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");
    const requests = await listOutstationRequests({ includeCarEvidenceSignedUrls: true });
    return NextResponse.json({ requests });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load outstation requests.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_requests_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
