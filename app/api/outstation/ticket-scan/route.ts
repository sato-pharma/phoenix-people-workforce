import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { getOutstationRequestById } from "@/lib/outstation/service";
import { readTrainTicket, signTicketScan } from "@/lib/outstation/ticket-scan";
import { judgeTrainTicket, TICKET_SCAN_NEEDS, type TicketDateContext } from "@/lib/outstation/ticket-scan-rules";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const body = (await request.json()) as Record<string, unknown>;
    const ticket = parseOutstationTicketAttachmentDataUrl({ dataUrl: String(body.dataUrl ?? ""), fileName: String(body.name ?? "") });

    let context: TicketDateContext;
    const requestId = body.requestId == null ? null : parseOutstationRequestId(String(body.requestId));
    if (requestId !== null) {
      const claim = await getOutstationRequestById(requestId);
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
    const verdict = judgeTrainTicket(scan, context);
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
