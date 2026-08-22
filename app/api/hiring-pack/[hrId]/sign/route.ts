import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  markHiringPackSigned,
} from "@/lib/hiring-pack/service";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Recording that the paper was signed, and on what date.
//
// THE DATE COMES FROM THE CALLER, NOT THE CLOCK. What matters is the date written on the document
// the employee put his pen to, which is routinely not the day somebody got round to ticking the box
// in Phoenix. A server timestamp here would quietly manufacture a signature date, and this record
// is what the hiring documents tracker then reports as done.

const DOCUMENTS = new Set<HiringPackDocument>(["contract", "form1"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringPackErrorMessage(error), status: 403 };
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "Hiring pack schema is not ready. Run the Supabase migration for employee_hiring_profile.",
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
          message: "Pass document as contract or form1.",
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
