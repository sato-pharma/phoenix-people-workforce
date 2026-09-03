import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { submitOutstationRequest } from "@/lib/outstation/service";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceMetadata,
} from "@/app/api/outstation/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function outstationSubmitStatus(error: unknown) {
  if (isForbiddenError(error)) {
    return 403;
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
    const rawTicketAttachments = Array.isArray(body.ticketAttachments)
      ? (body.ticketAttachments as Array<Record<string, unknown>>)
      : [];
    const ticketAttachments = rawTicketAttachments.map((entry) =>
      parseOutstationTicketAttachmentDataUrl({
        dataUrl: String(entry.dataUrl ?? ""),
        fileName: String(entry.name ?? ""),
      }),
    );
    const result = await submitOutstationRequest(
      access,
      {
      capturedAccuracyMeters: Number(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: Number(body.capturedLatitude),
      capturedLongitude: Number(body.capturedLongitude),
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      expenseType: String(body.expenseType ?? "traveling") as OutstationExpenseType,
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
      transportationType: String(body.transportationType ?? "car") as OutstationTransportationType,
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
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_submit_failed", message },
      { status },
    );
  }
}
