import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { listExplanationConfirmers } from "@/lib/dispute-center/explanations";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who the signed-in employee may name to confirm an explanation: his own manager chain and the
// Training Managers. Only ever his own list — the HR id comes from the session, never the request.
// Asked from the calendar and from the Deductions page, so it asks for the employee-profile read every
// employee holds (the Deductions page's own gate), not the calendar's attendance read.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");
    const employeeHrId = resolveEmployeeIdentityId(access);
    const confirmers = employeeHrId ? await listExplanationConfirmers(employeeHrId) : [];
    return NextResponse.json({ data: confirmers, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load who can confirm this.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
