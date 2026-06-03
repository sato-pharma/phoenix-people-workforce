import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  getVacationControlData,
  isVacationSchemaMissing,
  updateVacationWeeklyOffPolicy,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getVacationControlData(access));
  } catch (error) {
    const message = vacationErrorMessage(error) || "Vacation control failed.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_control_failed", message, success: false }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = await request.json();
    const policy = await updateVacationWeeklyOffPolicy(access, {
      friday: body.friday,
      jobTitle: body.jobTitle,
      saturday: body.saturday,
      thursday: body.thursday,
    });

    return NextResponse.json({ policy, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Vacation control update failed.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_control_update_failed", message, success: false }, { status: 400 });
  }
}
