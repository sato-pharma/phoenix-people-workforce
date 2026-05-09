import {
  parseRoleStrict,
  createAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  getCookieValue,
  phoenixSessionCookieName,
  verifySessionToken,
} from "@/lib/auth/session";
import { writeAuthAudit } from "@/lib/auth/audit";
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
  hr_id: string | null;
  is_active: boolean;
  login_id: string;
  role: string;
  session_version?: number | null;
};

async function resolveSessionAccessContext(token: string | null | undefined) {
  const payload = verifySessionToken(token);
  if (!payload) return null;

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

  return createAccessContext({
    hrId: row.hr_id,
    loginId: row.login_id,
    role,
    source: "session",
  });
}

export async function resolveAccessContext(request: Request): Promise<AccessContext> {
  const sessionContext = await resolveSessionAccessContext(
    getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName),
  );

  if (sessionContext) {
    return sessionContext;
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

export async function resolveAccessContextFromPage(): Promise<AccessContext> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const cookieValue = cookieStore.get(phoenixSessionCookieName)?.value;
  const sessionContext = await resolveSessionAccessContext(cookieValue);

  if (sessionContext) {
    return sessionContext;
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
}

export function isForbiddenError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().startsWith("forbidden:");
}
