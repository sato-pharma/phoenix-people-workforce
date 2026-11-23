/**
 * One trip's photos, tickets, journey and road route, signed for the approver.
 *
 * Moved out of `app/api/admin/outstation/[id]/attachments/route.ts` on 2026-11-23, unchanged, so the
 * rebuilt Expense Approvals reviewer can read it in the SAME request as the claim (it made four
 * requests a trip). The attachments route still answers with exactly this. The caller checks the
 * approver's gate (`assertOutstationAdminAccess(access, "approve")`) before calling: nothing here
 * decides who may see a photo.
 *
 * `photos` always holds both captures, arrival first: the departure photo was never returned until
 * 2026-09-18, so the approver saw the arrival alone. `found: false` when the source request no
 * longer exists, so a sheet or deleted-request trip degrades to "no attachment" instead of erroring.
 */

import { createOutstationEvidenceSignedUrls } from "@/lib/outstation/car-evidence-storage";
import { MAX_JOURNEY_STOPS } from "@/lib/outstation/chained-journey";
import { outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { approverTripRoute } from "@/lib/outstation/day-route-line";
import { adminMissedStopRule, isJourneyStopOpen } from "@/lib/outstation/journey-stop-rules";
import { getOutstationRequestById } from "@/lib/outstation/service";
import { approverTripPhotos } from "@/lib/outstation/trip-evidence-photos";
import { formatEmployeeDisplayName } from "@/lib/utils";

export async function loadTripAttachments(id: number) {
  const requestRow = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
  if (!requestRow) {
    return {
      carEvidenceImageUrl: null,
      departureEvidenceImageUrl: null,
      employeeName: null,
      found: false,
      journey: null,
      photos: [],
      tickets: [],
      tripRoute: null,
    };
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
            // The stop's own position, so the approver's trip map can pin it (2026-11-07).
            latitude: stop.latitude,
            locationLabel: stop.locationLabel,
            longitude: stop.longitude,
            addedByAdmin: stop.addedByAdmin ?? null,
            stopNumber: stop.stopNumber,
            ticketAmount: stop.ticketAmount,
            url: stop.photoPath ? stopPhotoUrl.get(stop.photoPath) ?? null : null,
          })),
        }
      : null;

  // Whether Expense Approvals offers "Add a missed stop" (2026-11-03; a trip without a car and a
  // National Sales Manager's system-accepted claim since 2026-11-19), and whether it asks the leg's
  // ticket. Only a hint for the screen: addOutstationJourneyStopAsAdmin re-checks every condition,
  // payroll included, and the version.
  const missedStop =
    requestRow.expenseType === "traveling" &&
    isJourneyStopOpen(requestRow.status, requestRow.employeeRole) &&
    stops.length < MAX_JOURNEY_STOPS
      ? {
          nextStopNumber: Math.max(1, ...stops.map((stop) => stop.stopNumber)) + 1,
          revision: outstationClaimRevision(requestRow.updatedAt),
          ticket: adminMissedStopRule({
            employeeRole: requestRow.employeeRole,
            transportationType: requestRow.transportationType,
          }).ticket,
          tripEndDate: String(requestRow.tripEndDate || requestRow.tripStartDate).slice(0, 10),
          tripStartDate: String(requestRow.tripStartDate).slice(0, 10),
        }
      : null;

  return {
    missedStop,
    carEvidenceImageUrl: requestRow.carEvidenceImageUrl ?? null,
    departureEvidenceImageUrl: requestRow.departureEvidenceImageUrl ?? null,
    employeeName: formatEmployeeDisplayName(requestRow.employeeName) || null,
    found: true,
    journey,
    photos: approverTripPhotos(requestRow),
    tickets,
    // The trip's road route from home, so each end day's map draws it (owner, 2026-11-07).
    tripRoute: approverTripRoute(requestRow),
  };
}

export type TripAttachmentsPayload = Awaited<ReturnType<typeof loadTripAttachments>>;
