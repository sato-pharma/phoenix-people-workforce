import { NextResponse } from "next/server";

import { parsePasswordSetupRequest } from "@/lib/admin/access-validation";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      throw unauthorizedError();
    }
    await assertPermission(access, "user_admin", "update");

    const payload = parsePasswordSetupRequest(await request.json());

    const result = await sendPasswordSetupLink({
      actorLoginId: access.loginId ?? null,
      deliveryMode: payload.deliveryMode,
      governanceReason: payload.governanceReason,
      loginId: payload.loginId,
      origin: new URL(request.url).origin,
      purpose: payload.purpose,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const apiError = toApiError(error, "Password setup link failed.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
