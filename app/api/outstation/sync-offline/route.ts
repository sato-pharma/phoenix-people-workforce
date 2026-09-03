import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import {
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceMetadata,
  parseOutstationTypeFields,
} from "@/app/api/outstation/request-body";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { syncOfflineOutstationRequest } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

    // This body must stay a SUBSET of what /api/outstation/submit accepts, never a superset.
    // Both routes assert the same permission — the submitting employee's own `outstation:create`
    // — so anything read here that submit does not read is a field an employee can set on his own
    // claim only by replaying it as "offline", which is also the path deliberately exempted from
    // carrying a ticket attachment up front. Least evidence must not mean most control.
    //
    // Six fields were dropped on 2026-09-03 for exactly that reason. All six reach the report_*
    // override columns, which payroll-expense-mapping.ts prefers over the resolved values, and
    // none of them is sent by the real offline replay (mobile-outstation-wizard.tsx):
    //
    //   travelCostAmount  replaced the fuel formula and the go/return ticket amounts outright
    //                     (service.ts: `optionalPositiveMoney(input.travelCostAmount) ??
    //                     computedTravelCost`) and landed in report_travel_cost, which the
    //                     payroll approval mapper prefers over fuel_amount + ticket_amount.
    //   amWorkload        the AM/PM visit counts an approver reads. The wizard's editable inputs
    //   pmWorkload        were removed for this reason; the server resolves both from the
    //                     published Double Visit Analytics snapshot.
    //   hrStatus          rendered as the row's `hr` field in the approvals queue. An employee
    //   hrNotes           does not write the HR column on his own claim.
    //   tripType          a report_trip_type of "meeting" against a zero meeting_amount makes the
    //                     DISPLAYED meeting amount fall back to the whole expected total, which
    //                     then also enters componentTotal — roughly doubling the approver's total.
    //                     The server derives this label itself from the trip's own dates.
    //
    // Adding a field back requires the owner's approval and an explicit gate here — not a default.
    const result = await syncOfflineOutstationRequest(access, {
      capturedAccuracyMeters: Number(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: Number(body.capturedLatitude),
      capturedLongitude: Number(body.capturedLongitude),
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
      meetingAmount: optionalNumber(body.meetingAmount),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      offlineCaptured: true,
      otherAmount: optionalNumber(body.otherAmount),
      returnTicketAmount: Number(body.returnTicketAmount ?? 0),
      carEvidenceMetadata: parseCarEvidenceMetadata(body),
      transportationType: outstationTypes.transportationType,
      tripEndDate: String(body.tripEndDate ?? ""),
      tripStartDate: String(body.tripStartDate ?? ""),
      attachmentCount: Number(body.attachmentCount ?? 0),
      carEvidenceImageDataUrl: parseCarEvidenceImageDataUrl(body),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      clientSafeErrorMessage(error, "Unable to sync offline outstation request.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_sync_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
