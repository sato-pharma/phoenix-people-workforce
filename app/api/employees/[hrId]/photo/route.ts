import { NextResponse } from "next/server";

import { assertPermission, canSeeEmployee, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  clearEmployeePhoto,
  employeePhotoEtag,
  readImagePayload,
  streamEmployeePhoto,
  uploadEmployeePhoto,
} from "@/lib/employees/employee-photo";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
  if (lower.includes("too large") || lower.includes("unsupported") || lower.includes("required") || lower.includes("empty")) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

async function loadTargetForScopeCheck(hrId: string) {
  const { data: target } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, manager_hr_id")
    .eq("hr_id", hrId.toUpperCase())
    .limit(1)
    .maybeSingle();
  if (!target) throw new Error(`Employee ${hrId} was not found.`);
  return target as { hr_id: string | null; manager_hr_id: string | null };
}

/**
 * HR/Admin scope guard for managing another employee's photo: requires the
 * employees:update permission and that the caller is allowed to see the target.
 */
async function assertCanManageTargetPhoto(request: Request, hrId: string) {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "employees", "update");

  const row = await loadTargetForScopeCheck(hrId);
  if (!canSeeEmployee(access, { hrId: row.hr_id ?? hrId, managerHrId: row.manager_hr_id })) {
    throw new Error("Forbidden: you do not have access to this employee.");
  }
  return access;
}

// Read-only scope guard for viewing another employee's photo: same directory-visibility
// rule as assertCanManageTargetPhoto, but without requiring employees:update — anyone who
// can see the employee in the directory can see their photo, not only editors. Without
// this, any authenticated user could fetch any other employee's photo by HR_ID.
async function assertCanViewTargetPhoto(access: AccessContext, hrId: string) {
  const row = await loadTargetForScopeCheck(hrId);
  if (!canSeeEmployee(access, { hrId: row.hr_id ?? hrId, managerHrId: row.manager_hr_id })) {
    throw new Error("Forbidden: you do not have access to this employee.");
  }
}

// Streams an employee's uploaded photo to callers who can see them in the directory
// (same access posture as the directory itself). Returns 404 when no photo is set so
// callers fall back to the bundled static photo / initials.
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
    await assertCanViewTargetPhoto(access, hrId);
    // HOW LONG THE BROWSER KEEPS IT (cache audit, 2026-10-26). A link carrying `?v=` (photoRouteFor,
    // versioned by the photo's own update time) names one picture for good, so it keeps a day. A BARE
    // link — the employee screen, the rankings and the milestone card all use one — names whatever
    // the photo is now, so it used to show a replaced or removed picture for up to a day. It must now
    // ask every time; the ETag makes that a 304 without downloading the picture again.
    const versioned = new URL(request.url).searchParams.has("v");
    const cacheControl = versioned ? "private, max-age=86400, must-revalidate" : "private, no-cache";
    const etag = await employeePhotoEtag(hrId);
    if (!etag) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { "Cache-Control": cacheControl, ETag: etag } });
    }
    const photo = await streamEmployeePhoto(hrId);
    if (!photo) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(photo.bytes), {
      status: 200,
      headers: {
        "Content-Type": photo.contentType,
        "Cache-Control": cacheControl,
        ETag: etag,
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
