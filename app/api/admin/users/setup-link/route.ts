import { NextResponse } from "next/server";

import { parsePasswordSetupRequest } from "@/lib/admin/access-validation";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { clientSafeErrorMessage, toApiError, unauthorizedError } from "@/lib/http/api-errors";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The origin used to build the emailed password-setup/reset link MUST be an
// allow-listed Phoenix origin — never the raw X-Forwarded-Host. A forged
// forwarded host would otherwise poison the highest-value email link (host-header
// injection). trustedOriginForRedirect validates every candidate against
// allowedPhoenixOrigins() and falls back to the canonical production URL, exactly
// like the login redirect path.
function requestPublicOrigin(request: Request) {
  return trustedOriginForRedirect(request);
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      throw unauthorizedError();
    }
    await assertPermission(access, "user_admin", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Forbidden: only Super Admin can manage user access." },
        { status: 403 },
      );
    }

    const payload = parsePasswordSetupRequest(await request.json());

    const result = await sendPasswordSetupLink({
      actorLoginId: access.loginId ?? null,
      deliveryMode: payload.deliveryMode,
      governanceReason: payload.governanceReason,
      loginId: payload.loginId,
      origin: requestPublicOrigin(request),
      purpose: payload.purpose,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const apiError = toApiError(error, "Password setup link failed.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
