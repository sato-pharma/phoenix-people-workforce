import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace, phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { notificationRoleKeys, updateNotificationRolePolicy, type NotificationRoleKey } from "@/lib/notifications/role-recipients";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isNotificationRoleKey(value: string): value is NotificationRoleKey {
  return (notificationRoleKeys as readonly string[]).includes(value);
}

// Super Admin only — see the comment in access-registry.ts. Which roles get pinged about a
// resignation-SLA breach or an attendance-ingestion stall is at least as consequential as an
// IP block (also Super-Admin-only in this codebase).
export async function POST(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "notification-recipients:update",
      windowMs: 60_000,
    });

    const { key } = await context.params;
    if (!isNotificationRoleKey(key)) {
      return NextResponse.json({ message: `"${key}" is not a recognized notification.` }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as { roles?: unknown; enabled?: unknown };
    const roles = body.roles === undefined ? undefined : sanitizeRolesInput(body.roles);
    if (body.roles !== undefined && !roles) {
      return NextResponse.json({ message: "roles must be an array of valid role names." }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ message: "enabled must be a boolean." }, { status: 400 });
    }

    const policy = await updateNotificationRolePolicy(key, { roles: roles ?? undefined, enabled: body.enabled as boolean | undefined }, access);
    return NextResponse.json({ ok: true, policy });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many recipient updates — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Failed to update notification recipients." },
      { status: 500 },
    );
  }
}

function sanitizeRolesInput(value: unknown): PhoenixRole[] | null {
  if (!Array.isArray(value)) return null;
  const roles = value.filter((role): role is PhoenixRole => typeof role === "string" && (phoenixRoles as readonly string[]).includes(role));
  // Every entry must be a real role — a garbage entry silently dropped would let the admin
  // believe they saved a role that never actually got persisted.
  if (roles.length !== value.length) return null;
  return roles;
}
