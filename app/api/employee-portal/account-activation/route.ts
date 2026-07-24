import { NextResponse } from "next/server";

import { listAccountActivationEligibleUsers, setAccountActiveForRecruiting } from "@/lib/recruitment/account-activation";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, unauthorizedError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    return NextResponse.json({ users: await listAccountActivationEligibleUsers() });
  } catch (error) {
    const apiError = toApiError(error, "Failed to load accounts.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);

    const payload = (await request.json()) as { isActive?: unknown; loginId?: unknown };
    const loginId = typeof payload.loginId === "string" ? payload.loginId.trim() : "";
    if (!loginId) throw validationError("loginId is required.");
    if (typeof payload.isActive !== "boolean") throw validationError("isActive must be a boolean.");

    await setAccountActiveForRecruiting(access, loginId, payload.isActive);
    return NextResponse.json({ users: await listAccountActivationEligibleUsers() });
  } catch (error) {
    const apiError = toApiError(error, "Failed to update account status.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
