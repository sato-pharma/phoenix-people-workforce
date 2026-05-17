import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createVacationRequest,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const result = await createVacationRequest(
      access,
      {
        dayPart: body.dayPart,
        endDate: body.endDate,
        startDate: body.startDate,
        vacationType: body.vacationType,
      },
      { baseUrl: new URL(request.url).origin },
    );

    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to submit vacation request.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_request_failed", message, success: false }, { status: 400 });
  }
}
