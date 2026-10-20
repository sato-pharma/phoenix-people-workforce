import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  assertMaySaveEmployeeFacts,
  factsInputForViewer,
  packForViewer,
} from "@/lib/hiring-pack/paper-access";
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
    // employee_documents as before, or a seat in SEAT_PRINTABLE_DOCUMENTS holding employees:update.
    await assertMaySaveEmployeeFacts(access);
    const { hrId } = await params;
    // The salary-blind seat never sets a salary: any base salary she sends is dropped here, and the
    // save keeps the one on record (owner, 2026-10-20).
    const payload = factsInputForViewer(access, (await request.json()) as HiringPackEmployeeFactsInput);

    // The saved pack is returned rather than an acknowledgement, so the screen redraws from what
    // the database actually holds — including the recalculated gap list — instead of from what the
    // form believed it sent. Blanked of money for the salary-blind seat.
    return NextResponse.json(
      packForViewer(access, await saveHiringPackEmployeeFacts(hrId, payload, access.hrId ?? null)),
    );
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_facts_save_failed", message }, { status });
  }
}
