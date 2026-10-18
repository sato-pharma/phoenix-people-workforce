import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { addExtraTicketsToOwnOutstationRequest } from "@/lib/outstation/service";
import { OUTSTATION_CLAIM_DECIDED_MESSAGE } from "@/lib/outstation/undecided-claim";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extraTicketStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  // HR has already decided the claim: a conflict with its current state, not a malformed request.
  if (error instanceof Error && error.message === OUTSTATION_CLAIM_DECIDED_MESSAGE) return 409;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("already been added to payroll")) return 409;
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must be") ||
    message.includes("too large") ||
    message.includes("empty") ||
    message.includes("greater than zero") ||
    message.includes("can only") ||
    message.includes("cannot accept") ||
    message.includes("not found") ||
    message.includes("refresh")
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
        { error: "no_tickets", message: "Upload at least one ticket to add." },
        { status: 400 },
      );
    }
    const tickets = rawTickets.map((entry) => ({
      ticket: parseOutstationTicketAttachmentDataUrl({
        dataUrl: String(entry.dataUrl ?? ""),
        fileName: String(entry.name ?? ""),
      }),
      amount: Number(entry.amount ?? 0),
    }));
    const result = await addExtraTicketsToOwnOutstationRequest(id, access, {
      destination: String(body.destination ?? ""),
      reason: String(body.reason ?? ""),
      tickets,
    });

    return NextResponse.json({ request: result });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to add the extra ticket.");
    const status = extraTicketStatus(error);
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_extra_ticket_failed",
        message,
      },
      { status },
    );
  }
}
