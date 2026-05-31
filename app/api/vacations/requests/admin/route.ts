import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  createVacationRequestAsAdmin,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = await request.json();
    const result = await createVacationRequestAsAdmin(access, body);

    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to create vacation request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_admin_create_failed", message, success: false }, { status: 400 });
  }
}
