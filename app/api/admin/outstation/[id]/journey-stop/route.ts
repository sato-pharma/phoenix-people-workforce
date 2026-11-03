import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { OUTSTATION_CLAIM_CHANGED_CODE, isOutstationClaimChangedError } from "@/lib/outstation/claim-revision";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import { addOutstationJourneyStopAsAdmin } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { cairoWallClockToIso } from "@/lib/format/cairo-zone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A system administrator adds a stop the employee missed (2026-11-03). Every rule — who may, which
 * claims, the reviewer's version, the trip's days, the stop cap — is enforced in the service
 * (addOutstationJourneyStopAsAdmin), which starts with assertOutstationAdminAccess.
 */
function adminStopStatus(error: unknown) {
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
    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const result = await addOutstationJourneyStopAsAdmin(id, access, {
      expectedRevision: typeof body.expectedRevision === "string" ? body.expectedRevision : "",
      latitude: numberOrNull(body.latitude),
      longitude: numberOrNull(body.longitude),
      reason: typeof body.reason === "string" ? body.reason : "",
      stoppedAt: cairoWallClockToIso(body.stoppedAtCairo),
    });

    return NextResponse.json({
      claimedTotalAmount: result.request.claimedTotalAmount,
      flagReasons: result.pricing.flagReasons,
      fuelAmount: result.request.fuelAmount,
      mode: result.pricing.mode,
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
