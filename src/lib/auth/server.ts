import { cache } from "react";

import {
  parseRoleStrict,
  createAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  refreshAppSessionIdle,
  validateAppSession,
  type AppSessionRow,
  type AppSessionRejectionReason,
} from "@/lib/auth/app-sessions";
import {
  accessContextFromDevPreviewToken,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import {
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
  type SessionPayload,
  verifySessionToken,
} from "@/lib/auth/session";
import { writeAuthAudit } from "@/lib/auth/audit";
import {
  evaluateEmployeeLifecycleGate,
  type SessionLifecycleGate,
} from "@/lib/auth/session-lifecycle";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cookies, headers } from "next/headers";

function isDevHeaderEnabled() {
  return process.env.PHOENIX_ENABLE_DEV_AUTH_HEADERS === "true";
}

function isLocalDevelopment() {
  return process.env.NODE_ENV === "development";
}

function isLocalHostname(value: string | null | undefined) {
  const hostname = String(value ?? "")
    .trim()
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function isLocalDevHeaderRequest(headerStore: Pick<Headers, "get">) {
  if (!isDevHeaderEnabled() || !isLocalDevelopment()) {
    return false;
  }

  return isLocalDevelopmentRequest(headerStore);
}

function isLocalDevelopmentRequest(headerStore: Pick<Headers, "get">) {
  if (!isLocalDevelopment()) {
    return false;
  }

  const forwardedHost = headerStore.get("x-forwarded-host");
  const host = headerStore.get("host");

  return isLocalHostname(forwardedHost) || isLocalHostname(host);
}

const anonymousAccessContext = createAccessContext({
  hrId: null,
  role: "Employee",
  source: "guest",
});

type SessionUserRow = {
  hr_id: string | null;
  is_active: boolean;
  login_id: string;
  name?: string | null;
  role: string;
  session_version?: number | null;
};

export type ViewerIdentity = {
  displayName: string;
  initials: string;
  roleLabel: string;
  /** Profile photo for the signed-in user, or null to fall back to initials. */
  imageUrl?: string | null;
};

export type ResolvedSessionState = {
  access: AccessContext;
  appSession: AppSessionRow;
  payload: SessionPayload;
};

/**
 * Read-only evaluation of the linked employee's lifecycle gate.
 *
 * Distinguishes three cases so governance fails CLOSED on uncertainty but does
 * not lock out intentionally-supported accounts:
 *   - no linked hr_id / employee row not found -> ALLOW (unlinked/system account)
 *   - unexpected query/DB error or thrown exception -> DENY (`employee_lookup_failed`)
 *   - row found -> classify status (terminal -> DENY, active/on_leave/unset -> ALLOW)
 *
 * Read-only; never mutates employees or app_auth_users.
 */
async function resolveEmployeeLifecycleGate(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  hrId: string | null | undefined,
): Promise<SessionLifecycleGate> {
  const linkedHrId = String(hrId ?? "").trim();
  if (!linkedHrId) return { allowed: true };

  try {
    const { data, error } = await supabase
      .from("employees")
      .select("employment_status")
      .eq("hr_id", linkedHrId)
      .maybeSingle();

    // Unexpected query error -> fail closed (do not silently allow).
    if (error) return { allowed: false, reason: "employee_lookup_failed" };
    // Employee row not found -> intentionally supported (unlinked/system account).
    if (!data) return { allowed: true };

    return evaluateEmployeeLifecycleGate({
      lookupFailed: false,
      employmentStatus: (data as { employment_status?: string | null }).employment_status ?? null,
    });
  } catch {
    // Thrown exception (network/driver) -> fail closed.
    return { allowed: false, reason: "employee_lookup_failed" };
  }
}

async function auditSessionRejection(input: {
  entityId: string | null;
  loginId: string | null;
  newValues: Record<string, unknown>;
  oldValues?: Record<string, unknown>;
  summary: string;
}) {
  await writeAuthAudit({
    actorLoginId: input.loginId,
    entityId: input.entityId,
    newValues: input.newValues,
    oldValues: input.oldValues,
    summary: input.summary,
  }).catch(() => undefined);
}

function appSessionRejectionSummary(reason: AppSessionRejectionReason) {
  switch (reason) {
    case "absolute_expired":
      return "Session rejected: absolute expiry reached";
    case "idle_expired":
      return "Session rejected: idle expiry reached";
    case "login_id_mismatch":
      return "Session rejected: app session login mismatch";
    case "missing_app_session":
      return "Session rejected: app session not found";
    case "revoked":
      return "Session rejected: app session revoked";
    case "role_changed":
      return "Session rejected: app session role changed";
    case "session_version_mismatch":
      return "Session rejected: app session version mismatch";
    default:
      return "Session rejected: app session invalid";
  }
}

export async function resolveSessionState(
  token: string | null | undefined,
  options: { refreshIdle?: boolean } = {},
): Promise<ResolvedSessionState | null> {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  const appSession = await validateAppSession(payload);
  if (!appSession.ok) {
    await auditSessionRejection({
      entityId: payload.loginId,
      loginId: payload.loginId,
      newValues: {
        reason: appSession.reason,
        revokedReason: appSession.row?.revoked_reason ?? null,
        sessionId: payload.sid,
        sessionVersion: payload.ver,
      },
      summary: appSessionRejectionSummary(appSession.reason),
    });
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id, hr_id, role, is_active, session_version")
    .eq("login_id", payload.loginId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as SessionUserRow | null;
  if (!row) {
    await auditSessionRejection({
      entityId: payload.loginId,
      loginId: payload.loginId,
      newValues: {
        reason: "missing_user",
        sessionId: payload.sid,
        sessionVersion: payload.ver,
      },
      summary: "Session rejected: account not found",
    });
    return null;
  }

  const role = parseRoleStrict(row.role);
  const sessionVersion = Number.isFinite(row.session_version) ? Number(row.session_version) : 1;
  if (!row.is_active) {
    await auditSessionRejection({
      entityId: row.login_id,
      loginId: row.login_id,
      newValues: {
        reason: "inactive_user",
        sessionId: payload.sid,
      },
      oldValues: {
        role,
      },
      summary: "Session rejected: account inactive",
    });
    return null;
  }

  if (role !== payload.role) {
    await auditSessionRejection({
      entityId: row.login_id,
      loginId: row.login_id,
      newValues: {
        currentRole: role,
        previousRole: payload.role,
        reason: "role_changed",
        sessionId: payload.sid,
      },
      summary: "Session rejected: role changed",
    });
    return null;
  }

  if (sessionVersion !== payload.ver) {
    await auditSessionRejection({
      entityId: row.login_id,
      loginId: row.login_id,
      newValues: {
        currentVersion: sessionVersion,
        previousVersion: payload.ver,
        reason: "session_version_mismatch",
        sessionId: payload.sid,
      },
      summary: "Session rejected: session version mismatch",
    });
    return null;
  }

  // Read-time lifecycle governance: do not rely on app_auth_users.is_active alone.
  // Reject the session if the linked employee is terminal (resigned/terminated/
  // non-renewed/inactive) while is_active is stale, OR if the lifecycle lookup
  // fails unexpectedly (fail closed — never silently allow when it cannot verify).
  // Missing employee row / unset status remain allowed. See
  // src/lib/auth/session-lifecycle.ts. (Read-only; no mutation.)
  const lifecycleGate = await resolveEmployeeLifecycleGate(supabase, row.hr_id);
  if (!lifecycleGate.allowed) {
    await auditSessionRejection({
      entityId: row.login_id,
      loginId: row.login_id,
      newValues: {
        ...(lifecycleGate.employmentStatus ? { employmentStatus: lifecycleGate.employmentStatus } : {}),
        reason: lifecycleGate.reason,
        sessionId: payload.sid,
      },
      oldValues: {
        role,
      },
      summary:
        lifecycleGate.reason === "employee_terminal"
          ? "Session rejected: linked employee is no longer active"
          : "Session rejected: employee lifecycle lookup failed",
    });
    return null;
  }

  if (options.refreshIdle) {
    const refreshed = await refreshAppSessionIdle({
      idleTimeoutSeconds: sessionIdleTimeoutSecondsForRole(role),
      sessionId: payload.sid,
    });
    if (!refreshed) {
      await auditSessionRejection({
        entityId: row.login_id,
        loginId: row.login_id,
        newValues: {
          reason: "refresh_rejected",
          sessionId: payload.sid,
        },
        summary: "Session rejected: app session refresh failed",
      });
      return null;
    }
    appSession.row.idle_expires_at = refreshed.idleExpiresAt;
    appSession.row.absolute_expires_at = refreshed.absoluteExpiresAt;
  }

  const access = createAccessContext({
    hrId: row.hr_id,
    loginId: row.login_id,
    role,
    source: "session",
  });

  return {
    access,
    appSession: appSession.row,
    payload,
  };
}

export async function resolveSessionAccessContext(token: string | null | undefined) {
  const state = await resolveSessionState(token);
  return state?.access ?? null;
}

export async function resolveAccessContext(request: Request): Promise<AccessContext> {
  const cookieHeader = request.headers.get("cookie");
  const sessionContext = await resolveSessionAccessContext(
    getCookieValue(cookieHeader, phoenixSessionCookieName),
  );

  if (sessionContext) {
    return sessionContext;
  }

  if (isLocalDevelopmentRequest(request.headers)) {
    const devPreviewContext = accessContextFromDevPreviewToken(
      getCookieValue(cookieHeader, phoenixDevPreviewCookieName),
    );
    if (devPreviewContext) {
      return devPreviewContext;
    }
  }

  if (!isLocalDevHeaderRequest(request.headers)) {
    return anonymousAccessContext;
  }

  const role = request.headers.get("x-phoenix-role");
  const hrId = request.headers.get("x-phoenix-hr-id");

  if (!role && !hrId) {
    return anonymousAccessContext;
  }

  return createAccessContext({
    hrId,
    role,
    source: "dev-header",
  });
}

// Per-request memoized: the admin/portal layout, the page it renders, and AppShell all resolve the
// access context on the same request. React cache() dedupes them to ONE session validation + one
// set of employees/app_auth_users reads per request (was re-run per call → the bulk of the ~154k
// employee reads). cache() is request-scoped, so it never leaks a session across requests and stays
// correct under force-dynamic; the session-version / role / active / lifecycle checks still run
// (once) and their rejection audits still fire (once).
export const resolveAccessContextFromPage = cache(async (): Promise<AccessContext> => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieValue = cookieStore.get(phoenixSessionCookieName)?.value;
  const sessionContext = await resolveSessionAccessContext(cookieValue);

  if (sessionContext) {
    return sessionContext;
  }

  if (isLocalDevelopmentRequest(headerStore)) {
    const devPreviewContext = accessContextFromDevPreviewToken(
      cookieStore.get(phoenixDevPreviewCookieName)?.value,
    );
    if (devPreviewContext) {
      return devPreviewContext;
    }
  }

  if (!isLocalDevHeaderRequest(headerStore)) {
    return anonymousAccessContext;
  }

  const role = headerStore.get("x-phoenix-role");
  const hrId = headerStore.get("x-phoenix-hr-id");

  if (!role && !hrId) {
    return anonymousAccessContext;
  }

  return createAccessContext({
    hrId,
    role,
    source: "dev-header",
  });
});

function buildInitials(input: string) {
  const parts = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) return "US";
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

export const resolveViewerIdentityFromPage = cache(async (accessContext?: AccessContext): Promise<ViewerIdentity> => {
  const access = accessContext ?? await resolveAccessContextFromPage();
  const fallbackName = access.loginId || formatHrIdForDisplay(access.hrId) || "User";
  const fallbackRole = access.role;

  if (access.source === "dev-header" || (!access.loginId && !access.hrId)) {
    return {
      displayName: fallbackName,
      initials: buildInitials(fallbackName),
      roleLabel: fallbackRole,
      imageUrl: employeeProfileImageForHrId(access.hrId),
    };
  }

  const supabase = getSupabaseAdmin();
  let row: SessionUserRow | null = null;

  if (access.loginId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("login_id, hr_id, role, is_active, session_version, name")
      .eq("login_id", access.loginId)
      .maybeSingle();
    row = (data as SessionUserRow | null) ?? null;
  }

  if (!row && access.hrId) {
    const { data } = await supabase
      .from("app_auth_users")
      .select("login_id, hr_id, role, is_active, session_version, name")
      .eq("hr_id", access.hrId)
      .maybeSingle();
    row = (data as SessionUserRow | null) ?? null;
  }

  const displayName = row?.name?.trim() || fallbackName;
  const roleLabel = row?.role?.trim() || fallbackRole;

  return {
    displayName,
    initials: buildInitials(displayName),
    roleLabel,
    imageUrl: employeeProfileImageForHrId(row?.hr_id ?? access.hrId),
  };
});

export async function resolveCurrentUserDisplay(
  loginId: string | null | undefined,
): Promise<{ name: string; loginId: string }> {
  const fallback = { name: loginId ?? "User", loginId: loginId ?? "" };
  if (!loginId) return fallback;
  try {
    const { data } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("name")
      .eq("login_id", loginId)
      .maybeSingle();
    return { name: (data as { name?: string | null } | null)?.name ?? loginId, loginId };
  } catch {
    return fallback;
  }
}

export function isForbiddenError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().startsWith("forbidden:");
}
