import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import {
  isNonTravelExpenseType,
  NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE,
} from "@/lib/outstation/non-travel-expense";
import { calculateOutstationExpense } from "@/lib/outstation/service";
import { NoTicketFareUnavailableError } from "@/lib/outstation/train-fare";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  MISSING_CAPTURED_COORDINATES,
  parseCarEvidenceMetadata,
  parseOutstationTypeFields,
} from "@/app/api/outstation/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A figure as a number, or as text — or null, which is what a blank box (NaN) becomes in JSON. */
const calculateNumberField = z.union([z.number(), z.string()]).nullable().optional();
const calculateTextField = z.string().nullable().optional();
const calculateFlagField = z.boolean().nullable().optional();

/**
 * What Submit Expense prices (mobile-outstation-wizard.tsx, its requestPayload). Loose: the body is handed whole
 * to parseOutstationTypeFields and parseCarEvidenceMetadata, which judge the two taxonomies and the arrival
 * photo's metadata with their own words, so every key still reaches them.
 */
const CalculateBodySchema = z.looseObject({
  amWorkload: calculateNumberField,
  attachmentCount: calculateNumberField,
  capturedAccuracyMeters: calculateNumberField,
  capturedAt: calculateTextField,
  capturedLatitude: calculateNumberField,
  capturedLongitude: calculateNumberField,
  carEvidenceMetadata: z.looseObject({}).nullable().optional(),
  claimedTotalAmount: calculateNumberField,
  expenseType: calculateTextField,
  goTicketAmount: calculateNumberField,
  hasTicketAttachments: calculateFlagField,
  kilometerReading: calculateNumberField,
  meetingAmount: calculateNumberField,
  medicalTripHrId: calculateTextField,
  medicalTripName: calculateTextField,
  notes: calculateTextField,
  offlineCaptured: calculateFlagField,
  otherAmount: calculateNumberField,
  pmWorkload: calculateNumberField,
  returnTicketAmount: calculateNumberField,
  transportationType: calculateTextField,
  travelCostAmount: calculateNumberField,
  tripEndDate: calculateTextField,
  tripStartDate: calculateTextField,
  tripType: calculateTextField,
});

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsedBody = await parseJsonBody(request, CalculateBodySchema);
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

    // The arrival position is required. Never `Number(body.capturedLatitude)`: `Number(null)` is
    // 0, so a body with no GPS fix was priced as a trip to 0°N 0°E.
    // A Meeting or Other expense takes no position at all (non-travel-expense.ts): it is priced on
    // its amounts alone, so a body without a fix is the normal shape and the service ignores the
    // 0,0 placeholder. Every other type still refuses one.
    const position = isNonTravelExpenseType(outstationTypes.expenseType)
      ? { latitude: 0, longitude: 0 }
      : readCapturedPosition(body.capturedLatitude, body.capturedLongitude);
    if (!position) {
      return NextResponse.json(MISSING_CAPTURED_COORDINATES, { status: 400 });
    }

    const result = await calculateOutstationExpense(access, {
      // Never `Number(...)`: a blank accuracy is null, not a perfect 0 m fix.
      capturedAccuracyMeters: readAccuracyInput(body.capturedAccuracyMeters),
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : undefined,
      capturedLatitude: position.latitude,
      capturedLongitude: position.longitude,
      claimedTotalAmount: Number(body.claimedTotalAmount ?? 0),
      expenseType: outstationTypes.expenseType,
      goTicketAmount: Number(body.goTicketAmount ?? 0),
      hasTicketAttachments: Boolean(body.hasTicketAttachments),
      amWorkload: optionalNumber(body.amWorkload),
      kilometerReading:
        body.kilometerReading == null ? undefined : Number(body.kilometerReading),
      medicalTripHrId:
        typeof body.medicalTripHrId === "string" ? body.medicalTripHrId : undefined,
      medicalTripName:
        typeof body.medicalTripName === "string" ? body.medicalTripName : undefined,
      meetingAmount: optionalNumber(body.meetingAmount),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      offlineCaptured: Boolean(body.offlineCaptured),
      otherAmount: optionalNumber(body.otherAmount),
      pmWorkload: optionalNumber(body.pmWorkload),
      returnTicketAmount: Number(body.returnTicketAmount ?? 0),
      carEvidenceMetadata: parseCarEvidenceMetadata(body),
      transportationType: outstationTypes.transportationType,
      travelCostAmount: optionalNumber(body.travelCostAmount),
      tripType: optionalText(body.tripType),
      tripEndDate: String(body.tripEndDate ?? ""),
      tripStartDate: String(body.tripStartDate ?? ""),
      attachmentCount: Number(body.attachmentCount ?? 0),
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to calculate outstation expense.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "outstation_calculation_failed", message },
      {
        status: isForbiddenError(error)
          ? 403
          : message === NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE || error instanceof NoTicketFareUnavailableError
            ? 400
            : 500,
      },
    );
  }
}
