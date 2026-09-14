import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listAllNativeVisits } from "@/lib/crm/native-visits/service";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?from=&to=&repHrId= = every rep's saved native visits over those days, for the Super Admin
// (crm_visit_entry `update`, the owner, 2026-09-14), and the reps he may enter a visit for.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "update");
    const params = new URL(request.url).searchParams;
    const view = await listAllNativeVisits(access, {
      from: params.get("from"),
      repHrId: params.get("repHrId"),
      to: params.get("to"),
    });
    return NextResponse.json({ view, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the saved visits.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
