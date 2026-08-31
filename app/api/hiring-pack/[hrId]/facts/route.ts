import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  saveHiringPackEmployeeFacts,
} from "@/lib/hiring-pack/service";
import type { HiringPackEmployeeFactsInput } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "What Phoenix already knows" — separate from the hiring/offboarding profile routes because this
// one writes `employees` itself rather than a satellite table. Same `employee_documents`
// permission as the rest of `/api/hiring-pack/**`, for the reason given on the sibling routes:
// whoever can fill this screen's own fields can also correct the record those fields sit next to.

function apiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: hiringPackErrorMessage(error), status: 403 };
  }
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.",
      status: 409,
    };
  }
  const message = hiringPackErrorMessage(error);
  if (
    message.includes("required") ||
    message.includes("Invalid HR_ID") ||
    message.includes("format is invalid") ||
    message.includes("already exists") ||
    message.includes("already assigned") ||
    message.includes("immutable") ||
    message.includes("not allowed")
  ) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

export async function PUT(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    const { hrId } = await params;
    const payload = (await request.json()) as HiringPackEmployeeFactsInput;

    // The saved pack is returned rather than an acknowledgement, so the screen redraws from what
    // the database actually holds — including the recalculated gap list — instead of from what the
    // form believed it sent.
    return NextResponse.json(await saveHiringPackEmployeeFacts(hrId, payload, access.hrId ?? null));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_facts_save_failed", message }, { status });
  }
}
