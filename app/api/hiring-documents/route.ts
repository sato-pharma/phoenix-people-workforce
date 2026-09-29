import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
  selectHiringDocumentEmployee,
  updateHiringDocumentEmployeeNotes,
  updateHiringDocumentStatus,
} from "@/lib/hiring-documents/service";
import type {
  UpdateHiringDocumentNotesInput,
  UpdateHiringDocumentStatusInput,
} from "@/lib/hiring-documents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: hiringDocumentsErrorMessage(error), status: 403 };
  }
  if (isHiringDocumentsSchemaMissing(error)) {
    return {
      message: "Hiring documents schema is not ready. Run the Supabase migration for hiring documents.",
      status: 409,
    };
  }
  return {
    message: hiringDocumentsErrorMessage(error),
    status: 500,
  };
}

/**
 * The checklist — the whole board, or one person's row.
 *
 * `?hrId=` IS NOT A CONVENIENCE. The employee details panel shows one person's documents, and the
 * board is company-wide: several hundred people times every tracked document, which is about a
 * megabyte of JSON to answer a question about one row. The narrow form returns the definitions and
 * that one person, so opening a details panel costs a few hundred bytes.
 *
 * IT IS THE SAME GATE EITHER WAY. The permission is asserted before anything is read, and the
 * narrow form goes through `selectHiringDocumentEmployee`, which does the scoping ITSELF rather
 * than trusting its caller to pass a filtered board — so a viewer who may not see someone gets
 * `employee: null` for them, exactly as the board would omit their row. Slicing before filtering
 * would have turned a scope boundary into a lookup by id.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    const dashboard = await getHiringDocumentsDashboard();

    const hrId = new URL(request.url).searchParams.get("hrId");
    if (!hrId) return NextResponse.json(filterHiringDocumentsForAccess(dashboard, access));

    return NextResponse.json(selectHiringDocumentEmployee(dashboard, access, hrId));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_documents_load_failed", message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    const payload = (await request.json()) as {
      notes?: UpdateHiringDocumentNotesInput;
      status?: UpdateHiringDocumentStatusInput;
      type?: "notes" | "status";
    };

    if (payload.type === "status" && payload.status) {
      await updateHiringDocumentStatus(access, payload.status);
    } else if (payload.type === "notes" && payload.notes) {
      await updateHiringDocumentEmployeeNotes(access, payload.notes);
    } else {
      return NextResponse.json(
        { error: "invalid_hiring_document_payload", message: "Status or notes payload is required." },
        { status: 400 },
      );
    }

    const dashboard = await getHiringDocumentsDashboard();
    return NextResponse.json(filterHiringDocumentsForAccess(dashboard, access));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_documents_update_failed", message }, { status });
  }
}
