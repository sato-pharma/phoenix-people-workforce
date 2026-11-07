import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import { isNonTravelExpenseType } from "@/lib/outstation/non-travel-expense";
import { submitOutstationRequest } from "@/lib/outstation/service";
import { TrainTicketRefusedError } from "@/lib/outstation/ticket-scan";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  MISSING_CAPTURED_COORDINATES,
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceMetadata,
  parseOutstationTypeFields,
} from "@/app/api/outstation/request-body";
import { logError } from "@/lib/observability/log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function outstationSubmitStatus(error: unknown) {
  if (isForbiddenError(error)) {
    return 403;
  }
  if (error instanceof TrainTicketRefusedError) {
    return 400;
  }
  if (isWorkflowRegistryTransitionError(error)) {
    return 409;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("missing") ||
    message.includes("not linked") ||
    message.includes("not available") ||
    message.includes("not eligible") ||
    message.includes("requires") ||
    message.includes("too large") ||
    message.includes("must be") ||
    message.includes("empty")
  ) {
    return 400;
  }

  return 500;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const body = (await request.json()) as Record<string, unknown>;
    const outstationTypes = parseOutstationTypeFields(body);
    if (!outstationTypes.ok) {
      return NextResponse.json(
        { error: outstationTypes.error, message: outstationTypes.message },
        { status: 400 },
      );
    }

    // The arrival position is required. Never `Number(body.capturedLatitude)`: `Number(null)` is
    // 0, so a body with no GPS fix was priced and stored as an arrival at 0°N 0°E.
    // A Meeting or Other expense takes no position at all (non-travel-expense.ts): it is priced on
    // its amounts alone, so a body without a fix is the normal shape and the service ignores the
    // 0,0 placeholder. Every other type still refuses one.
    const position = isNonTravelExpenseType(outstationTypes.expenseType)
      ? { latitude: 0, longitude: 0 }
      : readCapturedPosition(body.capturedLatitude, body.capturedLongitude);
    if (!position) {
      return NextResponse.json(MISSING_CAPTURED_COORDINATES, { status: 400 });
    }

    const rawTicketAttachments = Array.isArray(body.ticketAttachments)
      ? (body.ticketAttachments as Array<Record<string, unknown>>)
      : [];
    const ticketAttachments = rawTicketAttachments.map((entry) => ({
      ...parseOutstationTicketAttachmentDataUrl({
        dataUrl: String(entry.dataUrl ?? ""),
        fileName: String(entry.name ?? ""),
      }),
      // The signed note of the read made when the file was picked; checked against these bytes.
      scanToken: typeof entry.scanToken === "string" ? entry.scanToken : undefined,
    }));
    const result = await submitOutstationRequest(
      access,
      {
      // Never `Number(...)`: a blank accuracy is null, not a perfect 0 m fix. The service holds a
      // claim with no accuracy for Super Admin review (owner, 2026-09-18).
      capturedAccuracyMeters: readAccuracyInput(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: position.latitude,
      capturedLongitude: position.longitude,
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      expenseType: outstationTypes.expenseType,
      goTicketAmount: Number(body.goTicketAmount ?? 0),
      hasTicketAttachments: Boolean(body.hasTicketAttachments),
      kilometerReading:
        body.kilometerReading == null ? undefined : Number(body.kilometerReading),
      medicalTripHrId:
        typeof body.medicalTripHrId === "string" ? body.medicalTripHrId : undefined,
      medicalTripName:
        typeof body.medicalTripName === "string" ? body.medicalTripName : undefined,
      meetingAmount: typeof body.meetingAmount === "number" ? body.meetingAmount : 0,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      // Never taken from the request body. An offline capture is what exempts a
      // train/bus claim from carrying its ticket up front, so a client that could
      // set this flag could self-declare "offline" and land an evidence-free claim
      // in payroll. A genuinely offline draft is queued locally and replayed
      // through POST /api/outstation/sync-offline, which sets the flag server-side.
      offlineCaptured: false,
      otherAmount: typeof body.otherAmount === "number" ? body.otherAmount : 0,
      // The AM/PM visit counts are NOT taken from the request body, on either submit path.
      // They land in report_am_workload / report_pm_workload, which payroll-expense-mapping.ts
      // prefers over the resolved am_workload / pm_workload — and because both columns are
      // NOT NULL DEFAULT 0 that preference is effectively unconditional, so whatever the caller
      // sends is what an approver reads. The server resolves the real figures itself from the
      // published Double Visit Analytics snapshot (resolveOutstationWorkloadPayload), which is
      // why the wizard's editable inputs were removed; leaving the route open meant an employee
      // could still set his own visit counts by posting them directly. Omitted here, both
      // resolve to 0 — exactly what the wizard has been sending since those inputs went.
      returnTicketAmount: Number(body.returnTicketAmount ?? 0),
      carEvidenceMetadata: parseCarEvidenceMetadata(body),
      transportationType: outstationTypes.transportationType,
      tripEndDate: String(body.tripEndDate ?? ""),
      tripStartDate: String(body.tripStartDate ?? ""),
      attachmentCount: Number(body.attachmentCount ?? 0),
      carEvidenceImageDataUrl: parseCarEvidenceImageDataUrl(body),
      },
      { ticketAttachments },
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to submit outstation request.");
    const status = outstationSubmitStatus(error);
    // Every refusal used to leave no trace at all, so "she gets an error when she submits" could
    // not be answered from anything: no row is saved and the HTTP log window is minutes long.
    if (status !== 403) {
      logError("Outstation submit failed", {
        error,
        labels: { event: "outstation_submit_failed", status: String(status) },
      });
    }
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_submit_failed", message },
      { status },
    );
  }
}
