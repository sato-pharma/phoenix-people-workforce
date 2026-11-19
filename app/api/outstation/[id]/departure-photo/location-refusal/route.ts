import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readDepartureLocationRefusalReason } from "@/lib/outstation/departure-location-refusals";
import { recordOutstationDepartureLocationRefusal } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ reason }`, the cause of the refused try (departure-photo-card.tsx). Left open on purpose: an unknown or
 * missing cause from any client is recorded as not reported by readDepartureLocationRefusalReason, never refused.
 */
const LocationRefusalBodySchema = z
  .object({
    reason: z.unknown().optional(),
  })
  .nullable();

/**
 * A departure photo refused for having no GPS location, reported by the web card or the Android
 * app with its cause, so the approver sees the try (owner, 2026-09-18: "Record refused tries").
 * Nothing else is sent: no photo is taken or kept without a location.
 *
 * Ownership is enforced in the SERVICE, as for the photo itself. An unknown or missing cause is
 * recorded as not reported, never guessed.
 */
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

    const parsedBody = await parseJsonBody(request, LocationRefusalBodySchema, { fallback: {} });
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    await recordOutstationDepartureLocationRefusal(access, {
      reason: readDepartureLocationRefusalReason(body?.reason),
      requestId: id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to record the refused departure photo.");
    const notFound = error instanceof Error && error.message.includes("not available");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_departure_refusal_failed", message },
      { status: isForbiddenError(error) ? 403 : notFound ? 404 : 500 },
    );
  }
}
