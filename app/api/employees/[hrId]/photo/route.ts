import { NextResponse } from "next/server";

import { assertPermission, canSeeEmployee } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  clearEmployeePhoto,
  readImagePayload,
  streamEmployeePhoto,
  uploadEmployeePhoto,
} from "@/lib/employees/employee-photo";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorStatus(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  if (isForbiddenError(error)) return { message, status: 403 };
  const lower = message.toLowerCase();
  if (lower.includes("not authenticat") || lower.includes("unauthenticat")) {
    return { message, status: 401 };
  }
  if (lower.includes("not found")) return { message, status: 404 };
  if (lower.includes("too large") || lower.includes("unsupported") || lower.includes("required") || lower.includes("empty")) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

/**
 * HR/Admin scope guard for managing another employee's photo: requires the
 * employees:update permission and that the caller is allowed to see the target.
 */
async function assertCanManageTargetPhoto(request: Request, hrId: string) {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "employees", "update");

  const { data: target } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, manager_hr_id")
    .eq("hr_id", hrId.toUpperCase())
    .limit(1)
    .maybeSingle();
  if (!target) throw new Error(`Employee ${hrId} was not found.`);

  const row = target as { hr_id: string | null; manager_hr_id: string | null };
  if (!canSeeEmployee(access, { hrId: row.hr_id ?? hrId, managerHrId: row.manager_hr_id })) {
    throw new Error("Forbidden: you do not have access to this employee.");
  }
  return access;
}

// Streams an employee's uploaded photo to any authenticated user (same access
// posture as the directory). Returns 404 when no photo is set so callers fall
// back to the bundled static photo / initials.
export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // resolveAccessContext() never throws for a missing/invalid session — it falls back to a
    // valid anonymousAccessContext (source: "guest") instead, matching every other
    // access-control check in this codebase (see auth/permissions.ts canAccess). Without this
    // check, an unauthenticated request would silently pass through as that guest context and
    // stream any employee's photo.
    if (access.source === "guest") {
      throw new Error("Not authenticated.");
    }
    const { hrId } = await params;
    const photo = await streamEmployeePhoto(hrId);
    if (!photo) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(photo.bytes), {
      status: 200,
      headers: {
        "Content-Type": photo.contentType,
        "Cache-Control": "private, max-age=86400, must-revalidate",
      },
    });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_photo_failed", message }, { status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { hrId } = await params;
    await assertCanManageTargetPhoto(request, hrId);
    const { bytes, contentType } = await readImagePayload(request);
    await uploadEmployeePhoto(hrId, bytes, contentType);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_photo_upload_failed", message }, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { hrId } = await params;
    await assertCanManageTargetPhoto(request, hrId);
    await clearEmployeePhoto(hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_photo_clear_failed", message }, { status });
  }
}
