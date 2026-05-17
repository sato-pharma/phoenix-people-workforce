import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  deleteHiringDocumentDefinition,
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
} from "@/lib/hiring-documents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringDocumentsErrorMessage(error), status: 403 };
  if (isHiringDocumentsSchemaMissing(error)) {
    return {
      message: "Hiring documents schema is not ready. Run the Supabase migration for hiring documents.",
      status: 409,
    };
  }
  return { message: hiringDocumentsErrorMessage(error), status: 500 };
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    const { id } = await params;

    await deleteHiringDocumentDefinition(id);
    return NextResponse.json(filterHiringDocumentsForAccess(await getHiringDocumentsDashboard(), access));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_delete_failed", message }, { status });
  }
}
