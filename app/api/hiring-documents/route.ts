import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    const dashboard = await getHiringDocumentsDashboard();

    return NextResponse.json(filterHiringDocumentsForAccess(dashboard, access));
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
