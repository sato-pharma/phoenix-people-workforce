import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getHiringJoiners, saveHiringJoinerContact } from "@/lib/hiring-documents/joiners";
import { HiringJoinerInputError, parseHiringJoinerUpdate } from "@/lib/hiring-documents/joiners-logic";
import { hiringDocumentsErrorMessage, isHiringDocumentsSchemaMissing } from "@/lib/hiring-documents/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALLBACK = "The joiners list could not be read. Try again in a moment.";

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringDocumentsErrorMessage(error), status: 403 };
  if (error instanceof HiringJoinerInputError) return { message: error.message, status: 400 };
  if (isHiringDocumentsSchemaMissing(error)) {
    return { message: "The joiners list is not ready yet: its database table has not been created.", status: 409 };
  }
  return { message: clientSafeErrorMessage(error, FALLBACK), status: 500 };
}

/** Who is arriving, from today on, with what HR has agreed with each of them. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    return NextResponse.json(await getHiringJoiners());
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_joiners_load_failed", message }, { status });
  }
}

/** Record what was agreed with one joiner: papers confirmed, attendance day and time, a note. */
export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");

    await saveHiringJoinerContact(access, parseHiringJoinerUpdate(await request.json()));
    return NextResponse.json(await getHiringJoiners());
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_joiner_save_failed", message }, { status });
  }
}
