import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { sameLegAgainRefusal } from "@/lib/outstation/return-ticket";
import { getOutstationRequestById, readTicketReuseRefusal } from "@/lib/outstation/service";
import { readTrainTicket, signTicketScan } from "@/lib/outstation/ticket-scan";
import { judgeTrainTicket, TICKET_SCAN_NEEDS, type TicketDateContext, type TicketVerdict } from "@/lib/outstation/ticket-scan-rules";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the ticket reader sends (train-ticket-scan.tsx): the picked file as a data URL — any size, the upload
 * parser caps it — and its name, with either the claim's id (a late upload) or the wizard's arrival time
 * and trip days. The dates are still judged below, with the route's own words.
 */
const TicketScanBodySchema = z.object({
  arrivalAt: z.string().nullable().optional(),
  dataUrl: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  requestId: z.union([z.number(), z.string()]).nullable().optional(),
  tripEndDate: z.string().nullable().optional(),
  tripStartDate: z.string().nullable().optional(),
});

/**
 * Reads one train ticket the moment the employee picks it (owner, 2026-11-07; ticket-scan-rules.ts), and
 * answers at once: accepted with what was read, or refused with why and what to change in the photo. The
 * answer carries a signed note of the read, which the submit and the missing-ticket upload check against
 * the same bytes — this route stores nothing and decides nothing on its own.
 *
 * The dates it judges against: a claim's own arrival and departure photos when `requestId` names the
 * caller's claim (the late upload); otherwise the wizard's arrival photo time and trip days, which the
 * submit judges again from the claim itself.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");
    const hrId = normalizeHrIdForAccess(access.hrId);
    if (!hrId) {
      return NextResponse.json({ error: "not_linked", message: "Your session is not linked to an employee. Please sign in again." }, { status: 400 });
    }

    const parsedBody = await parseJsonBody(request, TicketScanBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const ticket = parseOutstationTicketAttachmentDataUrl({ dataUrl: String(body.dataUrl ?? ""), fileName: String(body.name ?? "") });

    let context: TicketDateContext;
    let claim: Awaited<ReturnType<typeof getOutstationRequestById>> = null;
    const requestId = body.requestId == null ? null : parseOutstationRequestId(String(body.requestId));
    if (requestId !== null) {
      claim = await getOutstationRequestById(requestId);
      if (!claim || normalizeHrIdForAccess(claim.employeeHrId) !== hrId) {
        return NextResponse.json({ error: "forbidden", message: "You can only attach a ticket to your own expense request." }, { status: 403 });
      }
      context = {
        arrivalAt: claim.carEvidenceMetadata?.capturedAt ?? null,
        departureAt: claim.departureCapturedAt ?? null,
        tripEndDate: String(claim.tripEndDate ?? "").slice(0, 10),
        tripStartDate: String(claim.tripStartDate ?? "").slice(0, 10),
      };
    } else {
      const tripStartDate = String(body.tripStartDate ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tripStartDate)) {
        return NextResponse.json({ error: "trip_dates", message: "Choose the trip dates before attaching the ticket." }, { status: 400 });
      }
      const tripEndDate = String(body.tripEndDate ?? "").slice(0, 10);
      context = {
        arrivalAt: typeof body.arrivalAt === "string" && body.arrivalAt ? body.arrivalAt : null,
        departureAt: null,
        tripEndDate: /^\d{4}-\d{2}-\d{2}$/.test(tripEndDate) ? tripEndDate : tripStartDate,
        tripStartDate,
      };
    }

    const scan = await readTrainTicket(ticket);
    let verdict: TicketVerdict = judgeTrainTicket(scan, context);
    // The second leg of a claim that pays a fare each way: a copy of the leg already on it is refused here, at
    // the pick, so the card says which ticket is wanted instead of "attached" (return-ticket.ts).
    if (claim && verdict.accepted && scan.status === "read") {
      const refusal = sameLegAgainRefusal({
        candidates: [{ fromStation: scan.fromStation, matchedTo: verdict.matchedTo, toStation: scan.toStation, travelDate: verdict.travelDate }],
        returnAmount: claim.returnTicketAmount,
        tickets: claim.ticketAttachmentMetadata,
        transportation: claim.transportationType,
      });
      if (refusal) verdict = { accepted: false, ...refusal };
    }
    // A ticket is claimed once (owner, 2026-11-28, zero leniency): the same train or bus number on the same
    // day, already on this claim or on another live claim of hers, is refused at the pick.
    if (verdict.accepted && scan.status === "read") {
      const reuse = await readTicketReuseRefusal({
        candidates: [{ matchedTo: verdict.matchedTo, trainNumber: scan.trainNumber, travelDate: verdict.travelDate }],
        employeeHrId: claim?.employeeHrId ?? hrId,
        excludeRequestId: claim?.id,
        onThisClaim: claim?.ticketAttachmentMetadata,
        tripEndDate: context.tripEndDate,
        tripStartDate: context.tripStartDate,
      });
      if (reuse) verdict = { accepted: false, ...reuse };
    }
    return NextResponse.json({
      needs: TICKET_SCAN_NEEDS,
      scan,
      token: signTicketScan({ bytes: ticket.bytes, hrId, scan }),
      verdict,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You cannot attach tickets." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Unable to read the ticket.");
    const lower = message.toLowerCase();
    const status = lower.includes("must be") || lower.includes("too large") || lower.includes("empty") ? 400 : 500;
    return NextResponse.json({ error: "ticket_scan_failed", message }, { status });
  }
}
