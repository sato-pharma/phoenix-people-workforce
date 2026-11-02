import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertMayUseHrForms, packForViewer } from "@/lib/hiring-pack/paper-access";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  hiringPackErrorMessage,
  isHiringPackConflict,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  saveOffboardingProfile,
} from "@/lib/hiring-pack/service";
import type { OffboardingProfileInput } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The exit half of the pack: the fields Form 6 and the two Ministry of Labour templates ask for.
//
// A SEPARATE ROUTE FROM THE HIRING PROFILE, ON PURPOSE. They write different tables, months or
// years apart, and the split is the safety property: no request to this endpoint can reach a value
// the signed employment contract was printed from. One PUT taking both halves would put that one
// mistyped field name away from being possible.
//
// Same permission as everything else under `/api/hiring-pack/**` — `employee_documents` — because
// this is the same workflow seen at the other end, and a separate resource would let the two drift
// so that somebody could print a Form 6 for an employee whose checklist they cannot open.

function apiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: hiringPackErrorMessage(error), status: 403 };
  }
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackConflict(error)) {
    return { message: hiringPackErrorMessage(error), status: 409 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.",
      status: 409,
    };
  }
  return { message: hiringPackErrorMessage(error), status: 500 };
}

export async function PUT(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // employee_documents as before, or a seat in SEAT_PRINTABLE_DOCUMENTS on its update grants. These
    // are the exit details the leaving papers print.
    await assertMayUseHrForms(access, "update");
    const { hrId } = await params;
    const payload = (await request.json()) as OffboardingProfileInput;

    // The whole pack is returned rather than an acknowledgement, so the screen redraws from what
    // the database actually holds — including the recalculated gap list and the resolved last
    // working day — instead of from what the form believed it sent. Blanked of money for the
    // salary-blind seat.
    return NextResponse.json(
      packForViewer(access, await saveOffboardingProfile(hrId, payload, access.hrId ?? null)),
    );
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "offboarding_profile_save_failed", message }, { status });
  }
}
