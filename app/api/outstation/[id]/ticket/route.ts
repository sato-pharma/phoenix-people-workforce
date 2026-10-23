import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { attachMissingTicketsToOwnOutstationRequest } from "@/lib/outstation/service";
import {
  MISSING_TICKET_ALREADY_ATTACHED_MESSAGE,
  MISSING_TICKET_WRONG_TRANSPORT_MESSAGE,
} from "@/lib/outstation/missing-ticket";
import { OUTSTATION_CLAIM_DECIDED_MESSAGE } from "@/lib/outstation/undecided-claim";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage, errorMessageOf } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The employee attaches the ticket a train or bus claim arrived WITHOUT (missing-ticket.ts).
 * Evidence only — it carries no amount, unlike /extra-ticket, which adds a paid leg.
 */
function missingTicketStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = errorMessageOf(error);
  if (
    message === OUTSTATION_CLAIM_DECIDED_MESSAGE ||
    message === MISSING_TICKET_ALREADY_ATTACHED_MESSAGE ||
    message.toLowerCase().includes("already been added to payroll") ||
    message.toLowerCase().includes("just changed")
  ) {
    return 409;
  }
  if (message.toLowerCase().startsWith("forbidden")) return 403;
  const lower = message.toLowerCase();
  if (
    message === MISSING_TICKET_WRONG_TRANSPORT_MESSAGE ||
    lower.includes("not found") ||
    lower.includes("upload the ticket") ||
    lower.includes("invalid") ||
    lower.includes("too large") ||
    lower.includes("must be") ||
    lower.includes("empty")
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
    const rawTickets = Array.isArray(body.tickets)
      ? (body.tickets as Array<Record<string, unknown>>)
      : [];
    if (rawTickets.length === 0) {
      return NextResponse.json(
        { error: "no_tickets", message: "Upload the ticket to attach." },
        { status: 400 },
      );
    }
    const tickets = rawTickets.map((entry) =>
      parseOutstationTicketAttachmentDataUrl({
        dataUrl: String(entry.dataUrl ?? ""),
        fileName: String(entry.name ?? ""),
      }),
    );
    const result = await attachMissingTicketsToOwnOutstationRequest(id, access, { tickets });

    return NextResponse.json({ request: { attachmentCount: result.attachmentCount, id: result.id } });
  } catch (error) {
    const status = missingTicketStatus(error);
    const message = clientSafeErrorMessage(error, "Unable to attach the ticket.");
    return NextResponse.json(
      {
        error: isForbiddenError(error) || status === 403 ? "forbidden" : "outstation_missing_ticket_failed",
        message,
      },
      { status },
    );
  }
}
