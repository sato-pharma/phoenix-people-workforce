import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId) {
      return NextResponse.json({ message: "Not authenticated." }, { status: 401 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id, name, auth_email, hr_id, created_at")
      .eq("login_id", access.loginId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ message: "Profile not found." }, { status: 404 });

    return NextResponse.json({
      loginId: data.login_id,
      name: data.name ?? null,
      email: data.auth_email ?? null,
      role: access.role,
      hrId: data.hr_id ?? null,
      createdAt: data.created_at ?? null,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load profile.") },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId) {
      return NextResponse.json({ message: "Not authenticated." }, { status: 401 });
    }

    const body = await request.json() as { name?: string; email?: string };
    const updates: Record<string, string> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      updates.name = body.name.trim();
    }
    if (typeof body.email === "string" && body.email.trim()) {
      updates.auth_email = body.email.trim();
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ message: "No valid fields to update." }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_auth_users")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("login_id", access.loginId)
      .select("login_id, name, auth_email, hr_id, created_at")
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ message: "Profile not found." }, { status: 404 });

    await writeAuditLog({
      actorLoginId: access.loginId,
      entityId: access.loginId,
      entityType: "user",
      summary: `Profile updated by ${access.loginId}: ${Object.keys(updates).join(", ")}`,
    }).catch(() => undefined);

    return NextResponse.json({
      loginId: data.login_id,
      name: data.name ?? null,
      email: data.auth_email ?? null,
      role: access.role,
      hrId: data.hr_id ?? null,
      createdAt: data.created_at ?? null,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to update profile.") },
      { status: 500 },
    );
  }
}
