import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertMayPrintPaper, assertMayUseHrForms, packForViewer } from "@/lib/hiring-pack/paper-access";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { fileSignedPaper, type FilingOutcome } from "@/lib/hiring-pack/paper-filing-store";
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
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ONE CONFIRM, TWO OUTCOMES. Confirming a signature now also files a copy of the paper into the
// employee's hiring documents, where it can be found, opened and reprinted. The owner asked for
// exactly this: the paper he confirms should go two ways, to the printer and to the record.
//
// THE SIGNATURE IS WRITTEN FIRST AND THE FILING CANNOT UNDO IT. Rendering a PDF means launching
// Chromium, which can fail for reasons that have nothing to do with the fact being recorded — and
// losing "this contract was signed on the 3rd" because a browser would not start would be a far
// worse failure than not having a copy on file. So `markHiringPackSigned` commits, and only then
// does the copy get made; a filing that refuses comes back as a sentence beside a signature that
// was recorded perfectly well.
//
// THE RESPONSE IS `{ pack, filing }`, not the pack alone. The client needs to say which of the
// three things happened — signed and filed, signed but not filed and why, or signed with the print
// blocked — and it cannot tell those apart from a 200 with a pack in it.

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
    // employee_documents:update as before, or a seat in SEAT_PRINTABLE_DOCUMENTS on its update
    // grants — and then only for its own papers, checked below once the document is known.
    await assertMayUseHrForms(access, "update");
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
    // The HR Operations Specialist records a signature on her own leaving papers only — the
    // resignation, the mutual termination and the two clearances (owner, 2026-10-20). A contract,
    // Form 1, Form 6 or the NDA stays with the seats that hold employee_documents.
    await assertMayPrintPaper(access, payload.document, "update");

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

    // Wrapped, and never rethrown. `fileSignedPaper` already returns its ordinary refusals as
    // words; this catch is for the genuine faults it lets through — a storage outage, a database
    // error — which must still not turn a recorded signature into a 500 the caller reads as
    // "nothing happened". The signature is already committed by this line.
    let filing: FilingOutcome;
    try {
      filing = await fileSignedPaper({
        access,
        document: payload.document,
        hrId,
        signedDate,
        uploadedByHrId: access.hrId ?? null,
      });
    } catch (error) {
      filing = {
        filed: false,
        why: `The signature was recorded, but the copy could not be filed: ${hiringPackErrorMessage(error)}`,
      };
    }

    return NextResponse.json({ filing, pack: packForViewer(access, pack) });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_sign_failed", message }, { status });
  }
}
