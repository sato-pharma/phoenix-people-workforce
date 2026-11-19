import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { OUTSTATION_CLAIM_CHANGED_CODE, isOutstationClaimChangedError } from "@/lib/outstation/claim-revision";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { addOutstationJourneyStopAsAdmin } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";
import { cairoWallClockToIso } from "@/lib/format/cairo-zone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A system administrator adds a stop the employee missed (2026-11-03). Every rule — who may, which
 * claims, the reviewer's version, the trip's days, the stop cap — is enforced in the service
 * (addOutstationJourneyStopAsAdmin), which starts with assertOutstationAdminAccess.
 */
function adminStopStatus(error: unknown) {
  if (error instanceof ApiError && error.status === 401) return 401;
  if (isForbiddenError(error)) return 403;
  if (isOutstationClaimChangedError(error)) return 409;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("already been decided") ||
    message.includes("added to payroll") ||
    message.includes("the most one trip may carry") ||
    message.includes("changed while")
  ) {
    return 409;
  }
  if (message.includes("outstation request is not available")) return 404;
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("must") ||
    message.includes("can only") ||
    message.includes("missing") ||
    message.includes("carry no location")
  ) {
    return 400;
  }
  return 500;
}

/** A coordinate as the form's text box holds it ("30.05"), or a number; numberOrNull reads both as before. */
const coordinateField = z.union([z.number(), z.string()]).nullable().optional();

/** One ticket file for the leg, as a data URL — the upload parser caps its size and type. */
const AdminStopTicketFileSchema = z.object({
  dataUrl: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

/**
 * What Expense Approvals' "Add a missed stop" sends (trip-attachments.tsx): the place, the time, the
 * reason, the reviewer's version and, on a trip without a car, the leg's ticket and its amount
 * (owner, 2026-11-19). Every rule stays the service's.
 */
const AdminJourneyStopBodySchema = z.object({
  expectedRevision: z.string().nullable().optional(),
  latitude: coordinateField,
  longitude: coordinateField,
  reason: z.string().nullable().optional(),
  stoppedAtCairo: z.string().nullable().optional(),
  ticketAmount: coordinateField,
  tickets: z.array(AdminStopTicketFileSchema).max(4).nullable().optional(),
});

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // REC-080: the caller is judged before the id and the body — the service's own first gate, repeated here.
    assertSignedIn(access);
    await assertOutstationAdminAccess(access, "approve");
    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    const parsedBody = await parseJsonBody(request, AdminJourneyStopBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const ticketAmount = numberOrNull(body.ticketAmount) ?? 0;
    const result = await addOutstationJourneyStopAsAdmin(id, access, {
      expectedRevision: typeof body.expectedRevision === "string" ? body.expectedRevision : "",
      latitude: numberOrNull(body.latitude),
      longitude: numberOrNull(body.longitude),
      reason: typeof body.reason === "string" ? body.reason : "",
      stoppedAt: cairoWallClockToIso(body.stoppedAtCairo),
      ticket: {
        amount: ticketAmount,
        files: (body.tickets ?? []).map((entry) =>
          parseOutstationTicketAttachmentDataUrl({
            dataUrl: String(entry.dataUrl ?? ""),
            fileName: String(entry.name ?? ""),
          }),
        ),
      },
    });

    return NextResponse.json({
      claimedTotalAmount: result.request.claimedTotalAmount,
      flagReasons: result.pricing.flagReasons,
      fuelAmount: result.request.fuelAmount,
      mode: result.pricing.mode,
      payrollSynced: result.payrollSynced,
      modeReason: result.pricing.modeReason,
      requestRevision: result.request.updatedAt ?? null,
      stopGovernorate: result.stop.governorate,
      stopNumber: result.stop.stopNumber,
      success: true,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to add the stop.");
    return NextResponse.json(
      {
        error: isForbiddenError(error)
          ? "forbidden"
          : isOutstationClaimChangedError(error)
            ? OUTSTATION_CLAIM_CHANGED_CODE
            : "outstation_admin_journey_stop_failed",
        message,
      },
      { status: adminStopStatus(error) },
    );
  }
}
