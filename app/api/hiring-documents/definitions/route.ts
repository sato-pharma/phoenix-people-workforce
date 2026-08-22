import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createHiringDocumentDefinition,
  filterHiringDocumentsForAccess,
  getHiringDocumentsDashboard,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
} from "@/lib/hiring-documents/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { CreateHiringDocumentDefinitionInput } from "@/lib/hiring-documents/types";

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

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    const payload = (await request.json()) as {
      document?: CreateHiringDocumentDefinitionInput;
    };

    if (!payload.document) {
      return NextResponse.json(
        { error: "missing_document", message: "Document payload is required." },
        { status: 400 },
      );
    }

    await createHiringDocumentDefinition(payload.document);
    return NextResponse.json(filterHiringDocumentsForAccess(await getHiringDocumentsDashboard(), access));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_create_failed", message }, { status });
  }
}
