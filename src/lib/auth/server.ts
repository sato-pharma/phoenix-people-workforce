import {
  parseRoleStrict,
  createAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  getCookieValue,
  phoenixSessionCookieName,
  type SessionPayload,
  verifySessionToken,
} from "@/lib/auth/session";
import { writeAuthAudit } from "@/lib/auth/audit";
import { normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cookies, headers } from "next/headers";

function isDevHeaderEnabled() {
  return process.env.PHOENIX_ENABLE_DEV_AUTH_HEADERS === "true";
}

function isLocalDevelopment() {
  return process.env.NODE_ENV === "development" && !process.env.VERCEL_ENV;
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

  const forwardedHost = headerStore.get("x-forwarded-host");
  const host = headerStore.get("host");

  return isLocalHostname(forwardedHost) || isLocalHostname(host);
}

const anonymousAccessContext = createAccessContext({
  hrId: null,
  role: "Employee",
  source: "session",
});

type SessionUserRow = {
  auth_user_id?: string | null;
  force_password_reset?: boolean | null;
  hr_id: string | null;
  is_active: boolean;
  login_id: string;
  role: string;
  session_version?: number | null;
};

type SessionProfileRow = {
  auth_user_id?: string | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  login_id?: string | null;
  phoenix_role?: string | null;
};

type ResolvedSessionAccess = {
  access: AccessContext;
  payload: SessionPayload;
};

function normalizedIdentity(value: string | null | undefined) {
  return normalizeHrId(value);
}

function sameRoleValue(left: string | null | undefined, right: string | null | undefined) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

async function resolveSessionAccessContext(token: string | null | undefined): Promise<ResolvedSessionAccess | null> {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  const supabase = getSupabaseAdmin();
  const [{ data, error }, profileResult] = await Promise.all([
    supabase
      .from("app_auth_users")
      .select("login_id, hr_id, role, is_active, session_version, auth_user_id, force_password_reset")
      .eq("login_id", payload.loginId)
      .maybeSingle(),
    payload.authUserId
      ? supabase
          .from("user_access_profiles")
          .select("auth_user_id, login_id, hr_id, is_active, phoenix_role")
          .eq("auth_user_id", payload.authUserId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (error) {
    throw error;
  }

  const row = data as SessionUserRow | null;
  if (!row) {
    await writeAuthAudit({
      actorLoginId: payload.loginId,
      entityId: payload.loginId,
      newValues: {
        reason: "missing_user",
        sessionId: payload.sid,
        sessionVersion: payload.ver,
      },
      summary: "Session rejected: account not found",
    }).catch(() => undefined);
    return null;
  }

  const role = parseRoleStrict(row.role);
  const sessionVersion = Number.isFinite(row.session_version) ? Number(row.session_version) : 1;
  const currentHrId = normalizedIdentity(row.hr_id ?? row.login_id);
  const payloadHrId = normalizedIdentity(payload.hrId ?? payload.loginId);

  if (!row.is_active) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      entityId: row.login_id,
      newValues: {
        reason: "inactive_user",
        sessionId: payload.sid,
      },
      oldValues: {
        role,
      },
      summary: "Session rejected: account inactive",
    }).catch(() => undefined);
    return null;
  }

  if (row.force_password_reset) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      actorHrId: row.hr_id,
      actorRole: role,
      entityId: row.login_id,
      newValues: {
        reason: "force_password_reset",
        sessionId: payload.sid,
      },
      oldValues: {
        role,
      },
      summary: "Session rejected: password reset required",
    }).catch(() => undefined);
    return null;
  }

  if (role !== payload.role) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      entityId: row.login_id,
      newValues: {
        currentRole: role,
        previousRole: payload.role,
        reason: "role_changed",
        sessionId: payload.sid,
      },
      summary: "Session rejected: role changed",
    }).catch(() => undefined);
    return null;
  }

  if (!row.auth_user_id || row.auth_user_id !== payload.authUserId) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      actorHrId: row.hr_id,
      actorRole: role,
      entityId: row.login_id,
      newValues: {
        currentAuthUserId: row.auth_user_id ?? null,
        previousAuthUserId: payload.authUserId,
        reason: "auth_user_link_mismatch",
        sessionId: payload.sid,
      },
      summary: "Session rejected: auth user linkage changed",
    }).catch(() => undefined);
    return null;
  }

  if (!currentHrId || !payloadHrId || currentHrId !== payloadHrId) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      actorHrId: row.hr_id,
      actorRole: role,
      entityId: row.login_id,
      newValues: {
        currentHrId,
        previousHrId: payloadHrId,
        reason: "hr_id_link_mismatch",
        sessionId: payload.sid,
      },
      summary: "Session rejected: employee linkage changed",
    }).catch(() => undefined);
    return null;
  }

  if (sessionVersion !== payload.ver) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      entityId: row.login_id,
      newValues: {
        currentVersion: sessionVersion,
        previousVersion: payload.ver,
        reason: "session_version_mismatch",
        sessionId: payload.sid,
      },
      summary: "Session rejected: session version mismatch",
    }).catch(() => undefined);
    return null;
  }

  const profileRow = (profileResult.data as SessionProfileRow | null) ?? null;
  if (
    profileResult.error ||
    !profileRow ||
    normalizedIdentity(profileRow.hr_id ?? profileRow.login_id) !== currentHrId ||
    !profileRow.is_active ||
    !sameRoleValue(profileRow.phoenix_role, row.role)
  ) {
    await writeAuthAudit({
      actorLoginId: row.login_id,
      actorHrId: row.hr_id,
      actorRole: role,
      entityId: row.login_id,
      newValues: {
        profileLoginId: profileRow?.login_id ?? null,
        profileRole: profileRow?.phoenix_role ?? null,
        profileHrId: profileRow?.hr_id ?? null,
        reason: "access_profile_mismatch",
        sessionId: payload.sid,
      },
      summary: "Session rejected: access profile mismatch",
    }).catch(() => undefined);
    return null;
  }

  return {
    access: createAccessContext({
      hrId: row.hr_id,
      loginId: row.login_id,
      role,
      source: "session",
    }),
    payload,
  };
}

export async function resolveAccessContext(request: Request): Promise<AccessContext> {
  const sessionContext = await resolveSessionAccessContext(
    getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName),
  );

  if (sessionContext) {
    return sessionContext.access;
  }

  if (!isLocalDevHeaderRequest(request.headers)) {
    return anonymousAccessContext;
  }

  const role = request.headers.get("x-phoenix-role");
  const hrId = request.headers.get("x-phoenix-hr-id");

  if (!role && !hrId) {
    return anonymousAccessContext;
  }

  console.warn("[phoenix-auth] Development auth headers accepted for local request.");

  return createAccessContext({
    hrId,
    role,
    source: "dev-header",
  });
}

export async function resolveAccessContextFromPage(): Promise<AccessContext> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieValue = cookieStore.get(phoenixSessionCookieName)?.value;
  const sessionContext = await resolveSessionAccessContext(cookieValue);

  if (sessionContext) {
    return sessionContext.access;
  }

  if (!isLocalDevHeaderRequest(headerStore)) {
    return anonymousAccessContext;
  }

  const role = headerStore.get("x-phoenix-role");
  const hrId = headerStore.get("x-phoenix-hr-id");

  if (!role && !hrId) {
    return anonymousAccessContext;
  }

  console.warn("[phoenix-auth] Development auth headers accepted for local page request.");

  return createAccessContext({
    hrId,
    role,
    source: "dev-header",
  });
}

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

export function getSessionPayloadFromRequest(request: Request) {
  return verifySessionToken(
    getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName),
  );
}

export async function assertRecentAuthentication(
  request: Request,
  maxAgeSeconds = 15 * 60,
) {
  const resolved = await resolveSessionAccessContext(
    getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName),
  );

  if (!resolved) {
    throw new Error("Forbidden: recent sign-in required.");
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - resolved.payload.iat;
  if (ageSeconds > maxAgeSeconds) {
    throw new Error("Forbidden: recent sign-in required.");
  }

  return resolved;
}
