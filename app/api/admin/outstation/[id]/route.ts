import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getOutstationRequestById } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");
    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }
    const requestRow = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
    if (!requestRow) {
      return NextResponse.json(
        { error: "outstation_not_found", message: "Outstation request was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ request: requestRow });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load outstation request.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_request_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
