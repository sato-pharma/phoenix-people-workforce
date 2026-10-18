import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { createOutstationEvidenceSignedUrls } from "@/lib/outstation/car-evidence-storage";
import { getOutstationRequestById } from "@/lib/outstation/service";
import { approverTripPhotos } from "@/lib/outstation/trip-evidence-photos";
import { formatEmployeeDisplayName } from "@/lib/utils";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signed attachments (the arrival and departure photos + ticket pictures/PDFs) for a
 * Phoenix-submitted outstation request. Backs the photos and attachments on the Expense Approvals
 * page, where the Super Admin approves. `photos` always holds both captures, arrival first: the
 * departure photo was never returned here until 2026-09-18, so the approver saw the arrival alone.
 * Returns `found: false` (200) when the source request no longer exists, so bulk-xlsx or
 * deleted-request trips degrade to "no attachment" instead of erroring.
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

    const requestRow = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
    if (!requestRow) {
      return NextResponse.json({
        carEvidenceImageUrl: null,
        departureEvidenceImageUrl: null,
        employeeName: null,
        found: false,
        journey: null,
        photos: [],
        tickets: [],
      });
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

    // The chained journey's stops (owner rule, 2026-10-18): each drive, whether it is paid and why,
    // the flags, and every stop's own photo — signed like the arrival and departure photos.
    const stops = requestRow.journeyStops ?? [];
    const pricing = stops.length > 0 ? requestRow.journeyPricing ?? null : null;
    const stopUrls = stops.length > 0 ? await createOutstationEvidenceSignedUrls(stops.map((stop) => stop.photoPath)) : [];
    const journey =
      stops.length > 0
        ? {
            flagReasons: pricing?.flagReasons ?? [],
            fuelAmount: pricing?.fuelAmount ?? null,
            legs: (pricing?.legs ?? []).map((leg) => ({
              distanceKm: leg.distanceKm,
              from: leg.from,
              paid: leg.paid,
              reason: leg.reason,
              to: leg.to,
            })),
            modeReason: pricing?.modeReason ?? null,
            singleDestinationFuelAmount: pricing?.singleDestinationFuelAmount ?? null,
            stops: stops.map((stop, index) => ({
              accuracyMeters: stop.accuracyMeters,
              capturedAt: stop.capturedAt,
              governorate: stop.governorate,
              locationLabel: stop.locationLabel,
              stopNumber: stop.stopNumber,
              url: stopUrls[index] ?? null,
            })),
          }
        : null;

    return NextResponse.json({
      carEvidenceImageUrl: requestRow.carEvidenceImageUrl ?? null,
      departureEvidenceImageUrl: requestRow.departureEvidenceImageUrl ?? null,
      employeeName: formatEmployeeDisplayName(requestRow.employeeName) || null,
      found: true,
      journey,
      photos: approverTripPhotos(requestRow),
      tickets,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load attachments.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "attachments_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
