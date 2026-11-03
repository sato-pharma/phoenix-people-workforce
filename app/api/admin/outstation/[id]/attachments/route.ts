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
import { MAX_JOURNEY_STOPS } from "@/lib/outstation/chained-journey";
import { outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { isOutstationClaimUndecided } from "@/lib/outstation/undecided-claim";

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
    // the flags, and every stop's own photo — signed like the arrival and departure photos. A stop
    // proved by its location has none, so only the stops with a photo are signed.
    const stops = requestRow.journeyStops ?? [];
    const pricing = stops.length > 0 ? requestRow.journeyPricing ?? null : null;
    // A stop a system administrator added has no photo to sign (ADMIN_ADDED_STOP_PHOTO_PATH).
    const photoPaths = stops.flatMap((stop) => {
      const path = stop.addedByAdmin ? "" : stop.photoPath;
      return path ? [path] : [];
    });
    const signedStopPhotos = photoPaths.length > 0 ? await createOutstationEvidenceSignedUrls(photoPaths) : [];
    const stopPhotoUrl = new Map(photoPaths.map((path, index) => [path, signedStopPhotos[index] ?? null]));
    const journey =
      stops.length > 0
        ? {
            flagReasons: pricing?.flagReasons ?? [],
            fuelAmount: pricing?.fuelAmount ?? null,
            legs: (pricing?.legs ?? []).map((leg) => ({
              distanceKm: leg.distanceKm,
              from: leg.from,
              fuelAmount: leg.fuelAmount,
              paid: leg.paid,
              reason: leg.reason,
              ticketAmount: leg.ticketAmount,
              to: leg.to,
            })),
            mode: pricing?.mode ?? null,
            modeReason: pricing?.modeReason ?? null,
            singleDestinationFuelAmount: pricing?.singleDestinationFuelAmount ?? null,
            stops: stops.map((stop) => ({
              accuracyMeters: stop.accuracyMeters,
              capturedAt: stop.capturedAt,
              evidence: stop.evidence,
              governorate: stop.governorate,
              locationLabel: stop.locationLabel,
              addedByAdmin: stop.addedByAdmin ?? null,
              stopNumber: stop.stopNumber,
              ticketAmount: stop.ticketAmount,
              url: stop.photoPath ? stopPhotoUrl.get(stop.photoPath) ?? null : null,
            })),
          }
        : null;

    // Whether Expense Approvals offers "Add a missed stop" (2026-11-03). Only a hint for the screen:
    // addOutstationJourneyStopAsAdmin re-checks every condition, payroll included, and the version.
    const missedStop =
      requestRow.expenseType === "traveling" &&
      requestRow.transportationType === "car" &&
      isOutstationClaimUndecided(requestRow.status) &&
      stops.length < MAX_JOURNEY_STOPS
        ? {
            nextStopNumber: Math.max(1, ...stops.map((stop) => stop.stopNumber)) + 1,
            revision: outstationClaimRevision(requestRow.updatedAt),
            tripEndDate: String(requestRow.tripEndDate || requestRow.tripStartDate).slice(0, 10),
            tripStartDate: String(requestRow.tripStartDate).slice(0, 10),
          }
        : null;

    return NextResponse.json({
      missedStop,
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
