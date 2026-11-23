import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { loadTripAttachments } from "@/lib/outstation/trip-attachments-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signed attachments (the arrival and departure photos + ticket pictures/PDFs) for a
 * Phoenix-submitted outstation request. Backs the photos and attachments on the Expense Approvals
 * page, where the Super Admin approves. What it sends is composed in
 * `src/lib/outstation/trip-attachments-data.ts` (moved there 2026-11-23, unchanged, so the rebuilt
 * reviewer reads it in the same request as the claim). Returns `found: false` (200) when the source
 * request no longer exists, so bulk-xlsx or deleted-request trips degrade to "no attachment"
 * instead of erroring.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // An expired session must not be reported as a missing permission (see
    // api-session-response.ts). A guest is already denied everything, so this only changes
    // how the denial reads, never who gets through.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    return NextResponse.json(await loadTripAttachments(id));
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load attachments.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "attachments_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
