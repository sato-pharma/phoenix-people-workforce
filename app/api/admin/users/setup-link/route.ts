import { NextResponse } from "next/server";

import { parsePasswordSetupRequest } from "@/lib/admin/access-validation";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function requestPublicOrigin(request: Request) {
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto")) ?? "https";

  if (forwardedHost) {
    return new URL("/", `${forwardedProto}://${forwardedHost}`).origin;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      // Fall back to request.url below.
    }
  }

  return new URL(request.url).origin;
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
