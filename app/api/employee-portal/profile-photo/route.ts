import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clearEmployeePhoto, readImagePayload, uploadEmployeePhoto } from "@/lib/employees/employee-photo";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorStatus(error: unknown): { message: string; status: number } {
  const message = clientSafeErrorMessage(error, "Unexpected error.");
  if (isForbiddenError(error)) return { message, status: 403 };
  const lower = message.toLowerCase();
  if (lower.includes("not authenticat") || lower.includes("unauthenticat")) {
    return { message, status: 401 };
  }
  if (lower.includes("not found")) return { message, status: 404 };
  if (lower.includes("too large") || lower.includes("unsupported") || lower.includes("required") || lower.includes("empty") || lower.includes("not linked")) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

// Self-service: an employee changes their own profile photo from the profile tab.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "update");
    if (!access.hrId) {
      throw new Error("Your account is not linked to an employee record.");
    }
    const { bytes, contentType } = await readImagePayload(request);
    await uploadEmployeePhoto(access.hrId, bytes, contentType);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "profile_photo_upload_failed", message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "update");
    if (!access.hrId) {
      throw new Error("Your account is not linked to an employee record.");
    }
    await clearEmployeePhoto(access.hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "profile_photo_clear_failed", message }, { status });
  }
}
