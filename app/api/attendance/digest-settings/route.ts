import { NextResponse } from "next/server";

import { getDigestSettings, saveDigestSettings } from "@/lib/attendance/digest-recipients";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    return NextResponse.json(await getDigestSettings());
  } catch (error) {
    return apiResponse(error, "Digest settings failed to load.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");
    if (!access.hrId && !access.loginId) throw validationError("No actor identity on session.");

    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw validationError("Settings payload must be an object.");
    }

    const settings = await saveDigestSettings({
      ...(payload as Record<string, unknown>),
      updatedBy: access.hrId ?? access.loginId ?? "system",
    });
    return NextResponse.json(settings);
  } catch (error) {
    return apiResponse(error, "Digest settings failed to save.");
  }
}
