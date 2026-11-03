import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { readDeparturePhotoPosition } from "@/lib/outstation/departure-evidence";
import { captureOutstationJourneyStop } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A STOP on a trip — the next place of a journey (owner rules, 2026-10-18 and 2026-11-03; pricing in
 * chained-journey.ts, what each person owes in journey-stop-rules.ts). Posted by the employee from
 * the place itself, with GPS and whatever evidence the rule asks: a live photo, a ticket, or neither.
 *
 * Every rule that matters — the caller owns the trip, still open and out of payroll, inside the trip
 * window, the evidence the rule asks with a position, at most six stops — is enforced in the SERVICE.
 * The permission check below only establishes that the caller may touch the outstation module at all.
 */
function journeyStopStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // The trip moved on (decided, in payroll, full, or written in between): not a bad payload.
  if (
    message.includes("already been decided") ||
    message.includes("added to payroll") ||
    message.includes("the most one trip may carry") ||
    message.includes("changed while")
  ) {
    return 409;
  }
  // The trip itself is missing — checked before the 400 list, whose "not available" would catch it.
  if (message.includes("outstation request is not available")) return 404;
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must be") ||
    message.includes("can only") ||
    message.includes("too large") ||
    message.includes("empty") ||
    message.includes("not available") ||
    message.includes("missing") ||
    message.includes("carry no location") ||
    message.includes("captured inside the app")
  ) {
    return 400;
  }
  return 500;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json(
        { error: "invalid_outstation_id", message: "Request id is invalid." },
        { status: 400 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const imageDataUrl = typeof body.imageDataUrl === "string" && body.imageDataUrl ? body.imageDataUrl : null;
    const rawTickets = Array.isArray(body.tickets) ? (body.tickets as Array<Record<string, unknown>>) : [];
    const ticketAmount = Number(body.ticketAmount ?? 0);

    // Read here, judged in the service: a stop with no position, or with the wrong evidence, is
    // refused there before anything is uploaded. Never cast the raw body field to a number:
    // `Number(null)` is 0, a fix at 0,0.
    const { latitude, longitude } = readDeparturePhotoPosition(body);

    const result = await captureOutstationJourneyStop(access, {
      accuracyMeters: readAccuracyInput(body.accuracyMeters),
      captureKey: typeof body.captureKey === "string" ? body.captureKey.slice(0, 64) : null,
      imageDataUrl,
      latitude,
      locationLabel: typeof body.locationLabel === "string" ? body.locationLabel : null,
      longitude,
      requestId: id,
      ticket: {
        amount: Number.isFinite(ticketAmount) ? ticketAmount : 0,
        files: rawTickets.map((entry) =>
          parseOutstationTicketAttachmentDataUrl({
            dataUrl: String(entry.dataUrl ?? ""),
            fileName: String(entry.name ?? ""),
          }),
        ),
      },
    });

    // The flag WORDING stays with the approver: telling the employee "Google needs about 58
    // minutes" is telling a forger the line to stay under (risk review, 2026-10-18).
    return NextResponse.json({
      claimedTotalAmount: result.request.claimedTotalAmount,
      flagged: result.pricing.flags.length > 0,
      fuelAmount: result.request.fuelAmount,
      legs: result.pricing.legs.map((leg) => ({
        distanceKm: leg.distanceKm,
        from: leg.from,
        fuelAmount: leg.fuelAmount,
        paid: leg.paid,
        reason: leg.reason,
        ticketAmount: leg.ticketAmount,
        to: leg.to,
      })),
      mode: result.pricing.mode,
      modeReason: result.pricing.modeReason,
      payrollSynced: result.payrollSynced,
      stopGovernorate: result.stop.governorate,
      stopNumber: result.stop.stopNumber,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to save the stop.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_journey_stop_failed",
        message,
      },
      { status: journeyStopStatus(error) },
    );
  }
}
