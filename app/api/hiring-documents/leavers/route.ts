import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getHiringLeavers } from "@/lib/hiring-documents/leavers";
import { hiringDocumentsErrorMessage, isHiringDocumentsSchemaMissing } from "@/lib/hiring-documents/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALLBACK = "The leavers list could not be read. Try again in a moment.";

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringDocumentsErrorMessage(error), status: 403 };
  if (isHiringDocumentsSchemaMissing(error)) {
    return { message: "The leavers list is not ready yet: a database table it needs has not been created.", status: 409 };
  }
  return { message: clientSafeErrorMessage(error, FALLBACK), status: 500 };
}

/** The people who have left, with their exit papers, newest last working day first. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    return NextResponse.json(await getHiringLeavers(access));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_leavers_load_failed", message }, { status });
  }
}
