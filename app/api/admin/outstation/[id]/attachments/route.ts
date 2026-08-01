import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { createOutstationEvidenceSignedUrls } from "@/lib/outstation/car-evidence-storage";
import { getOutstationRequestById } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signed attachments (car-evidence photo + ticket pictures/PDFs) for a Phoenix-submitted
 * outstation request. Backs the "attached picture or PDF" view on the Expense Approvals page.
 * Returns `found: false` (200) when the source request no longer exists, so bulk-xlsx or
 * deleted-request trips degrade to "no attachment" instead of erroring.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    const requestRow = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
    if (!requestRow) {
      return NextResponse.json({ carEvidenceImageUrl: null, found: false, tickets: [] });
    }

    const ticketPaths = Array.isArray(requestRow.ticketAttachmentPaths) ? requestRow.ticketAttachmentPaths : [];
    const meta = Array.isArray(requestRow.ticketAttachmentMetadata) ? requestRow.ticketAttachmentMetadata : [];
    const signed = await createOutstationEvidenceSignedUrls(ticketPaths);
    const tickets = ticketPaths
      .map((path, index) => ({
        contentType: meta[index]?.contentType ?? "",
        name: meta[index]?.name ?? `Ticket ${index + 1}`,
        url: signed[index] ?? null,
      }))
      .filter((ticket): ticket is { contentType: string; name: string; url: string } => Boolean(ticket.url));

    return NextResponse.json({
      carEvidenceImageUrl: requestRow.carEvidenceImageUrl ?? null,
      found: true,
      tickets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load attachments.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "attachments_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
