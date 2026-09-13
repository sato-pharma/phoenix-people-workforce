import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getNativeVisitFormOptions } from "@/lib/crm/native-visits/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = what the signed-in rep's visit form offers: pilot days, his own AM/PM doctors, his managers.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "create");
    const options = await getNativeVisitFormOptions(access);
    return NextResponse.json({ options, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the visit form.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
