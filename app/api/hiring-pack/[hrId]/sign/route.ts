import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  hiringPackErrorMessage,
  isHiringPackConflict,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  markHiringPackSigned,
} from "@/lib/hiring-pack/service";
import { SIGNABLE_DOCUMENTS } from "@/lib/hiring-pack/types";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recording that the paper was signed, and on what date.
//
// THE DATE COMES FROM THE CALLER, NOT THE CLOCK. What matters is the date written on the document
// the employee put his pen to, which is routinely not the day somebody got round to ticking the box
// in Phoenix. A server timestamp here would quietly manufacture a signature date, and this record
// is what the hiring documents tracker then reports as done.

const DOCUMENTS = new Set<HiringPackDocument>(SIGNABLE_DOCUMENTS);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringPackErrorMessage(error), status: 403 };
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  // The one-signed-exit-form rule. Nothing is broken — the request contradicts it.
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

export async function POST(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    const { hrId } = await params;
    const payload = (await request.json()) as {
      document?: HiringPackDocument;
      signedDate?: string;
    };

    if (!payload.document || !DOCUMENTS.has(payload.document)) {
      return NextResponse.json(
        {
          error: "invalid_hiring_pack_document",
          // Named against the SIGNABLE set, not every document this module prints. The custody
          // receipts are absent on purpose — one person can hold three, signed on three days, so
          // there is no single date to store against the person. See `SIGNABLE_DOCUMENTS`.
          message: `Pass document as one of ${SIGNABLE_DOCUMENTS.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    const signedDate = payload.signedDate?.trim() ?? "";
    if (!ISO_DATE.test(signedDate)) {
      return NextResponse.json(
        {
          error: "invalid_signed_date",
          message: "Pass signedDate as YYYY-MM-DD — the date written on the signed paper.",
        },
        { status: 400 },
      );
    }

    const pack = await markHiringPackSigned({
      actorHrId: access.hrId ?? null,
      document: payload.document,
      hrId,
      signedDate,
    });

    return NextResponse.json(pack);
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_sign_failed", message }, { status });
  }
}
