import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import {
  MISSING_CAPTURED_COORDINATES,
  parseCarEvidenceImageDataUrl,
  parseCarEvidenceMetadata,
  parseOutstationTypeFields,
} from "@/app/api/outstation/request-body";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import { parseOutstationTicketAttachmentDataUrl } from "@/lib/outstation/car-evidence-storage";
import { NoTicketFareUnavailableError } from "@/lib/outstation/train-fare";
import { syncOfflineOutstationRequest } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A claim saved on the phone with no signal and replayed later (mobile-outstation-wizard.tsx), or posted here
 * when the phone reports itself offline. The replayed draft can come from an OLDER version of the app, so the
 * schema holds it only to being an object: every field below is read by the same permissive readers as
 * before (readCapturedPosition, readAccuracyInput, Number, String, typeof), and a field this route never reads
 * is accepted and ignored. Listed so the accepted body is visible here; the subset rule further down decides
 * what may be read, never this list.
 */
const SyncOfflineBodySchema = z.looseObject({
  attachmentCount: z.unknown().optional(),
  capturedAccuracyMeters: z.unknown().optional(),
  capturedAt: z.unknown().optional(),
  capturedLatitude: z.unknown().optional(),
  capturedLongitude: z.unknown().optional(),
  carEvidenceImageDataUrl: z.unknown().optional(),
  carEvidenceMetadata: z.unknown().optional(),
  claimedTotalAmount: z.unknown().optional(),
  expenseType: z.unknown().optional(),
  goTicketAmount: z.unknown().optional(),
  hasTicketAttachments: z.unknown().optional(),
  kilometerReading: z.unknown().optional(),
  medicalTripHrId: z.unknown().optional(),
  medicalTripName: z.unknown().optional(),
  meetingAmount: z.unknown().optional(),
  notes: z.unknown().optional(),
  otherAmount: z.unknown().optional(),
  returnTicketAmount: z.unknown().optional(),
  ticketAttachments: z.unknown().optional(),
  transportationType: z.unknown().optional(),
  tripEndDate: z.unknown().optional(),
  tripStartDate: z.unknown().optional(),
});

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

    const parsedBody = await parseJsonBody(request, SyncOfflineBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const outstationTypes = parseOutstationTypeFields(body);
    if (!outstationTypes.ok) {
      return NextResponse.json(
        { error: outstationTypes.error, message: outstationTypes.message },
        { status: 400 },
      );
    }

    // The arrival position is required, exactly as on submit. Never `Number(body.capturedLatitude)`:
    // `Number(null)` is 0, so a draft with no GPS fix was replayed as an arrival at 0°N 0°E.
    const position = readCapturedPosition(body.capturedLatitude, body.capturedLongitude);
    if (!position) {
      return NextResponse.json(MISSING_CAPTURED_COORDINATES, { status: 400 });
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
    //   hrNotes           does not write the HR column on his own claim. Both were then removed
    //                     everywhere on 2026-09-19 (owner), columns included.
    //   tripType          a report_trip_type of "meeting" against a zero meeting_amount makes the
    //                     DISPLAYED meeting amount fall back to the whole expected total, which
    //                     then also enters componentTotal — roughly doubling the approver's total.
    //                     The server derives this label itself from the trip's own dates.
    //
    // Adding a field back requires the owner's approval and an explicit gate here — not a default.
    //
    // ticketAttachments IS read (owner, 2026-10-22 — "the offline ticket gap"), parsed exactly as
    // submit parses it. A phone can report no signal while its request still arrives, and the
    // ticket it carried used to be dropped here, holding a train claim whose ticket was in hand.
    // It is evidence the SERVER counts from the files it received, never a flag, so it widens
    // nothing an employee controls. A replay from the phone's own storage sends none.
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
      source: entry.source === "live_camera" ? ("live_camera" as const) : ("file" as const),
    }));
    const result = await syncOfflineOutstationRequest(access, {
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
    }, { ticketAttachments });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      clientSafeErrorMessage(error, "Unable to sync offline outstation request.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_sync_failed", message },
      { status: isForbiddenError(error) ? 403 : error instanceof NoTicketFareUnavailableError ? 400 : 500 },
    );
  }
}
