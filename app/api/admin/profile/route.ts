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

    // The display NAME is the only field a person changes here (audit point 3, 2026-10-26). The
    // sign-in email is not theirs to set: until this fix any signed-in user could write a colleague's
    // address into their own `auth_email`, and internal messages typed to that address were
    // delivered to them. A sent `email` is ignored; the sign-in email is managed from the users screen.
    const body = await request.json() as { name?: unknown };
    const updates: { name?: string } = {};
    if (typeof body.name === "string" && body.name.trim()) {
      updates.name = body.name.trim();
    }

    if (Object.keys(updates).length === 0) {
      // A blank name is the common case here; the email wording is only for a caller that sent one.
      const sentEmail = Object.prototype.hasOwnProperty.call(body, "email");
      return NextResponse.json(
        {
          message: sentEmail && body.name === undefined
            ? "Only the display name can be changed here. Ask HR to change your sign-in email."
            : "Enter a display name.",
        },
        { status: 400 },
      );
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
