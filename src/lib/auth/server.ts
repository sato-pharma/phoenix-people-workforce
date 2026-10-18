import { cache } from "react";

import {
  parseRoleStrict,
  createAccessContext,
  type AccessContext,
  type PhoenixRole,
  type TestPersonaLink,
} from "@/lib/auth/permissions";
import { assertNotTestAccount, assertTestAccountMayRun, canBeMirrored } from "@/lib/auth/test-persona";
import {
  evaluateAppSessionRow,
  refreshAppSessionIdle,
  type AppSessionRow,
  type AppSessionRejectionReason,
} from "@/lib/auth/app-sessions";
import {
  accessContextFromDevPreviewToken,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import { bearerTokenFromRequest } from "@/lib/auth/native-session";
import {
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
  type SessionPayload,
  verifySessionToken,
} from "@/lib/auth/session";
import { writeAuthAudit } from "@/lib/auth/audit";
import { displayTitleForAccount } from "@/lib/auth/account-job-titles";
import {
  evaluateEmployeeLifecycleGate,
  sessionGateOutcome,
  SessionVerificationUnavailableError,
  type SessionLifecycleGate,
} from "@/lib/auth/session-lifecycle";
import { uploadedEmployeePhotoUrl } from "@/lib/employees/employee-photo";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { ApiError } from "@/lib/http/api-errors";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import {
  forgetRememberedBundle,
  recallRememberedBundle,
  rememberAcceptedBundle,
  sessionBundleCacheKey,
  withRefreshedSessionExpiry,
} from "@/lib/auth/session-bundle-cache";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cookies, headers } from "next/headers";

function isDevHeaderEnabled() {
  return process.env.PHOENIX_ENABLE_DEV_AUTH_HEADERS === "true";
}

function isLocalDevelopment() {
  return process.env.NODE_ENV === "development";
}

const SESSION_BUNDLE_RETRY_DELAY_MS = 500;

/** Gateway / edge statuses that mean the request never got a real answer from PostgREST. */
const TRANSIENT_BUNDLE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

type BundleSettled =
  | { ok: true; value: { error: unknown; status?: number } }
  | { ok: false; error: unknown };

/**
 * True when the session bundle call failed for an infrastructure reason rather than a database
 * verdict: a thrown transport error, a client-side timeout, or an edge/gateway answer. postgrest-js
 * reports both a timed-out fetch ("AbortError: Supabase request timed out.") and a non-JSON edge page
 * as an error with an EMPTY code; every real PostgREST/Postgres error carries one (PGRST…, 42…, …).
 */
function isTransientBundleFailure(settled: BundleSettled): boolean {
  if (!settled.ok) return true;
  const error = settled.value.error;
  if (!error) return false;
  if (typeof settled.value.status === "number" && TRANSIENT_BUNDLE_STATUSES.has(settled.value.status)) return true;
  const record = typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : String(error).toLowerCase();
  return code === "" || message.includes("timed out") || message.includes("<!doctype html");
}

/** A short, non-identifying description of a bundle failure for the log line. */
function describeBundleFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
        ? String((error as { message: string }).message)
        : String(error);
  return message.toLowerCase().includes("<!doctype html") ? "edge error page (html)" : message.slice(0, 200);
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

export type SessionUserRow = {
  hr_id: string | null;
  is_active: boolean;
  is_test_persona?: boolean | null;
  login_id: string;
  name?: string | null;
  role: string;
  session_version?: number | null;
  test_persona_of_hr_id?: string | null;
};

/**
 * A test account's link, or the reason it cannot have one. It is refused, never downgraded to an
 * ordinary session: a test row with no mirror, with an HR id of its own, or pointed at a role outside
 * the employee portal would otherwise sign in as something nobody chose (src/lib/auth/test-persona.ts).
 */
export function resolveTestPersonaLink(
  row: SessionUserRow,
  role: PhoenixRole,
): { ok: true; link: TestPersonaLink } | { ok: false; reason: string } {
  const mirrorsHrId = String(row.test_persona_of_hr_id ?? "").trim();
  if (!mirrorsHrId) return { ok: false, reason: "test_persona_without_mirror" };
  if (String(row.hr_id ?? "").trim()) return { ok: false, reason: "test_persona_with_own_hr_id" };
  if (!canBeMirrored(role)) return { ok: false, reason: "test_persona_role_outside_portal" };
  return { ok: true, link: { loginId: row.login_id, mirrorsHrId } };
}

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

/** The employees columns the lifecycle gate needs, as phx_auth_session_bundle returns them. */
type BundledEmployeeRow = { employment_status?: string | null; last_working_date?: string | null };

/** One call's worth of the auth trio: three rows, no decisions. */
export type AuthSessionBundle = {
  appSession: AppSessionRow | null;
  authUser: SessionUserRow | null;
  employee: BundledEmployeeRow | null;
  /** True when the employees lookup itself failed — the gate must then fail CLOSED. */
  employeeLookupFailed: boolean;
  /** The hr_id the RPC actually keyed the employees lookup on, or null if it had none. */
  employeeKey: string | null;
};

/**
 * Reads the phx_auth_session_bundle payload into the three rows.
 *
 * A malformed or absent payload is treated as "no rows found", never as "allowed": a missing
 * app_session is a rejected session two checks later, so the fail-closed direction is kept
 * without this function needing to know any of the rules.
 */
export function parseAuthSessionBundle(payload: unknown): AuthSessionBundle {
  const bundle = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const objectOrNull = <T,>(value: unknown): T | null =>
    typeof value === "object" && value !== null ? (value as T) : null;

  const employeeKey = typeof bundle.employee_key === "string" ? bundle.employee_key.trim() : "";
  return {
    appSession: objectOrNull<AppSessionRow>(bundle.app_session),
    authUser: objectOrNull<SessionUserRow>(bundle.auth_user),
    employee: objectOrNull<BundledEmployeeRow>(bundle.employee),
    employeeLookupFailed: bundle.employee_lookup_failed === true,
    employeeKey: employeeKey === "" ? null : employeeKey,
  };
}

/**
 * Read-only evaluation of the linked employee's lifecycle gate.
 *
 * Still the entry point when the effective HR id differs from the key the bundle RPC used —
 * a test account mirroring another employee. The ordinary path never reaches it, because the
 * RPC already keyed the lookup on the fresh account row's hr_id.
 *
 * Distinguishes three cases so governance fails CLOSED on uncertainty but does
 * not lock out intentionally-supported accounts:
 *   - no linked hr_id / employee row not found -> ALLOW (unlinked/system account)
 *   - unexpected query/DB error or thrown exception -> DENY (`employee_lookup_failed`)
 *   - row found -> classify status and DATE (departure in effect -> DENY, active/on_leave/unset
 *     or a departure whose last working day is still ahead -> ALLOW)
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
      .select("employment_status, last_working_date")
      .eq("hr_id", linkedHrId)
      .maybeSingle();

    // Unexpected query error -> fail closed (do not silently allow).
    if (error) return { allowed: false, reason: "employee_lookup_failed" };
    // Employee row not found -> intentionally supported (unlinked/system account).
    if (!data) return { allowed: true };

    const row = data as { employment_status?: string | null; last_working_date?: string | null };
    return evaluateEmployeeLifecycleGate({
      lookupFailed: false,
      employmentStatus: row.employment_status ?? null,
      // A departure dated in the FUTURE has not happened yet — see isEmploymentAccessRevoked.
      lastWorkingDate: row.last_working_date ?? null,
      todayCairo: currentCairoDateOnlyIso(),
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
  options: {
    /**
     * False for anything that leaves lasting access behind (a passkey, a new password) or writes: it then
     * never accepts the last-accepted copy, and an unreadable bundle throws as it did before the copy
     * existed. Left out, the copy may stand in (session-bundle-cache.ts).
     */
    allowRecentCopy?: boolean;
    refreshIdle?: boolean;
  } = {},
): Promise<ResolvedSessionState | null> {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  // CI smoke mode: the login route issues a real signed JWT but deliberately
  // skips inserting an app_sessions row so CI never pollutes production audit
  // tables. All subsequent Supabase admin lookups would therefore fail (session
  // not found, missing key, etc.). Short-circuit here using the already-verified
  // JWT payload — verifySessionToken above has already checked the HMAC
  // signature and token expiry, so the payload is trustworthy.
  // Gated identically to the ciSmokeMode check in app/api/auth/login/route.ts
  // (APP_ENV !== "production" && PHOENIX_CI_SMOKE_LOGIN === "true") so it can
  // never activate in a real production deployment.
  if (process.env.APP_ENV !== "production" && process.env.PHOENIX_CI_SMOKE_LOGIN === "true") {
    const now = new Date().toISOString();
    const syntheticAppSession: AppSessionRow = {
      absolute_expires_at: new Date(payload.exp * 1000).toISOString(),
      created_at: now,
      hr_id: payload.hrId,
      id: payload.sid,
      idle_expires_at: new Date(payload.exp * 1000).toISOString(),
      last_seen_at: now,
      login_id: payload.loginId,
      revoked_at: null,
      revoked_reason: null,
      role: payload.role,
      session_version: payload.ver,
      supabase_session_available: null,
      supabase_session_required: null,
    };
    return {
      access: createAccessContext({
        hrId: payload.hrId,
        loginId: payload.loginId,
        role: payload.role,
        source: "session",
      }),
      appSession: syntheticAppSession,
      payload,
    };
  }

  const supabase = getSupabaseAdmin();

  // ONE ROUND TRIP FOR THE THREE READS. These three lookups (app_sessions, app_auth_users,
  // the employees lifecycle row) are each keyed off the signed token payload alone, are all
  // read-only, and were 36% of every PostgREST round trip Phoenix makes — 64,032 of 176,110
  // in a 118-minute production window, for 0.2 ms of SQL — because each was its own HTTPS
  // call from Railway (europe-west4) to Supabase (eu-central-1).
  //
  // Promise.all made them concurrent, which fixed the LATENCY (1 RTT instead of 3) but not
  // the COUNT. phx_auth_session_bundle returns all three rows in a single call.
  //
  // THE RPC RETURNS ROWS, NOT DECISIONS. Every rejection check below still runs in EXACTLY
  // the original order with identical audit logging — app_sessions first, then the
  // app_auth_users error/missing/inactive/role/version checks, then the employees lifecycle
  // gate — using the same rule functions as before (evaluateAppSessionRow is the body
  // validateAppSession runs, and evaluateEmployeeLifecycleGate is unchanged).
  //
  // One behaviour deliberately differs, and it is strictly safer: the gate is keyed on the
  // FRESH account row's hr_id inside the RPC rather than speculatively on payload.hrId, so
  // the old "guess, then re-read on a mismatch" fourth round trip is gone for the ordinary
  // case. The RPC reports the key it actually used, and the check below re-reads only when
  // the effective HR id differs from it (a test persona mirroring another employee).
  //
  // payload.hrId is deliberately NOT passed: the RPC keys on the account row alone, which is
  // the same expression effectiveHrId uses below. Handing it the token's hr_id as a fallback
  // made the two keys disagree on 203 of 823 real production sessions (admin accounts whose
  // app_auth_users.hr_id is NULL) for no change in the decision -- see the migration.
  const callBundle = () =>
    supabase
      .rpc("phx_auth_session_bundle", {
        p_sid: payload.sid,
        p_login_id: payload.loginId,
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

  // A TRANSIENT failure (timeout, transport error, Cloudflare edge page) is retried ONCE — the RPC
  // is read-only, so a repeat is safe. If it still fails, it is raised as
  // SessionVerificationUnavailableError rather than the raw PostgREST error object: "could not
  // reach the database" is not a verdict on the session (see that class), and a plain object
  // thrown into a server render surfaced only as Next's opaque digest error (PHOENIX-WORKFORCE-9,
  // 2026-10-17: field-crm renders failing with "Supabase request timed out.").
  // When this read BEGAN, so a slow answer that finally arrives after a newer one (or a revocation made
  // here) cannot store its older picture of the session as the copy.
  const bundleReadStartedAt = Date.now();
  let bundleSettled = await callBundle();
  if (isTransientBundleFailure(bundleSettled)) {
    await new Promise((resolve) => setTimeout(resolve, SESSION_BUNDLE_RETRY_DELAY_MS));
    bundleSettled = await callBundle();
  }
  // THE LAST ACCEPTED BUNDLE MAY STAND IN FOR A READ THAT FAILED, for ten minutes at most (owner,
  // 18 Oct 2026; src/lib/auth/session-bundle-cache.ts has the rules and the incident). Live is always
  // tried first, so this branch is reached only after the call AND its retry both failed for an
  // infrastructure reason; a copy goes through every check below exactly as a live bundle does.
  const bundleCacheKey = sessionBundleCacheKey({ sid: payload.sid, loginId: payload.loginId });
  let bundleData: unknown;
  let servedFromRecentCopy = false;
  if (isTransientBundleFailure(bundleSettled)) {
    const cause = bundleSettled.ok ? bundleSettled.value.error : bundleSettled.error;
    const recentCopy = options.allowRecentCopy === false ? null : recallRememberedBundle(bundleCacheKey);
    if (!recentCopy) {
      logError("Session verification unavailable — session bundle could not be read", {
        labels: { event: "session_verification_unavailable", loginId: payload.loginId },
        context: { sessionId: payload.sid, reason: describeBundleFailure(cause) },
      });
      throw new SessionVerificationUnavailableError({ cause });
    }
    logWarning("Session verification served from a recent copy — session bundle could not be read", {
      labels: { event: "session_verification_served_from_recent_copy", loginId: payload.loginId },
      context: { sessionId: payload.sid, reason: describeBundleFailure(cause) },
    });
    bundleData = recentCopy;
    servedFromRecentCopy = true;
  } else {
    // A non-transient PostgREST-level error is still thrown first, before any other check.
    if (!bundleSettled.ok) throw bundleSettled.error;
    if (bundleSettled.value.error) throw bundleSettled.value.error;
    bundleData = bundleSettled.value.data;
    // A live answer replaces whatever was held for this session, and it is held again only if every
    // check below accepts it -- so a rejection can never be undone by a later outage.
    forgetRememberedBundle(bundleCacheKey, bundleReadStartedAt);
  }
  const bundle = parseAuthSessionBundle(bundleData);

  // Never rejects: the RPC reports an unreadable employees row as a FLAG, so the gate still
  // fails CLOSED with employee_lookup_failed instead of throwing. That distinction is what
  // keeps one unreachable row from reading as a resignation (see the 2026-10-10 logout).
  const speculativeLifecycleGate: SessionLifecycleGate = bundle.employeeLookupFailed
    ? { allowed: false, reason: "employee_lookup_failed" }
    : bundle.employee
      ? evaluateEmployeeLifecycleGate({
          lookupFailed: false,
          employmentStatus: bundle.employee.employment_status ?? null,
          // A departure dated in the FUTURE has not happened yet — see isEmploymentAccessRevoked.
          lastWorkingDate: bundle.employee.last_working_date ?? null,
          todayCairo: currentCairoDateOnlyIso(),
        })
      : // No hr_id to look up, or no employees row -> intentionally supported (unlinked/system
        // account), exactly as resolveEmployeeLifecycleGate returns for both cases.
        { allowed: true };

  const appSession = evaluateAppSessionRow(bundle.appSession, payload);
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

  // The account row arrived in the same call as the session row. A read error on it was
  // already thrown above, where the bundle call's error is handled — there is one error for
  // one call now, instead of one per read.
  const row = bundle.authUser;
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

  // A TEST ACCOUNT reads as the employee it mirrors (src/lib/auth/test-persona.ts). Anything short of
  // a clean link is a rejected session, audited like every other rejection here.
  let testPersona: TestPersonaLink | null = null;
  if (row.is_test_persona === true) {
    const link = resolveTestPersonaLink(row, role);
    if (!link.ok) {
      await auditSessionRejection({
        entityId: row.login_id,
        loginId: row.login_id,
        newValues: { reason: link.reason, sessionId: payload.sid },
        oldValues: { role },
        summary: "Session rejected: test account is not linked to an employee-portal employee",
      });
      return null;
    }
    testPersona = link.link;
  }
  const effectiveHrId = testPersona ? testPersona.mirrorsHrId : row.hr_id;

  // Read-time lifecycle governance: do not rely on app_auth_users.is_active alone.
  // Reject the session if the linked employee is terminal (resigned/terminated/
  // non-renewed/inactive) while is_active is stale, OR if the lifecycle lookup
  // fails unexpectedly (fail closed — never silently allow when it cannot verify).
  // Missing employee row / unset status remain allowed. See
  // src/lib/auth/session-lifecycle.ts. (Read-only; no mutation.)
  // The gate must be evaluated on the FRESH app_auth_users hr_id — for a test account, on the
  // employee it mirrors, so a test account stops the day that person leaves.
  //
  // The bundle RPC already keyed its employees lookup on the fresh account row's hr_id and
  // REPORTS that key, so this compares against the key actually used rather than against
  // payload.hrId, which the old code could only guess with. A mismatch means the effective id
  // is not what was read — in practice a test persona mirroring someone else — and only then
  // is a second read paid, keyed on the effective id exactly as the sequential code was.
  const lifecycleGate =
    String(effectiveHrId ?? "").trim() === String(bundle.employeeKey ?? "").trim()
      ? speculativeLifecycleGate
      : await resolveEmployeeLifecycleGate(supabase, effectiveHrId);
  if (!lifecycleGate.allowed) {
    // "I could not reach the database" is NOT "this person has left". Only a real verdict ends the
    // session; an outage is raised so the caller can answer "try again" and leave the cookies alone.
    // Returning null here is what turned one Supabase blip into a platform-wide logout — see
    // SessionVerificationUnavailableError for the measured incident.
    if (sessionGateOutcome(lifecycleGate) === "unavailable") {
      logError("Session verification unavailable — employee lifecycle lookup could not be reached", {
        labels: { event: "session_verification_unavailable", loginId: row.login_id },
        context: { hrId: effectiveHrId ?? null, sessionId: payload.sid },
      });
      throw new SessionVerificationUnavailableError();
    }

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
      summary: "Session rejected: linked employee is no longer active",
    });
    return null;
  }

  // A refresh is a WRITE to the database that just failed to answer a read, and it throws on error;
  // a session served from a recent copy is simply not extended this time.
  let refreshedExpiry: { idleExpiresAt: string; absoluteExpiresAt: string } | null = null;
  if (options.refreshIdle && !servedFromRecentCopy) {
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
    refreshedExpiry = { idleExpiresAt: refreshed.idleExpiresAt, absoluteExpiresAt: refreshed.absoluteExpiresAt };
  }

  // Remembered only from a LIVE answer: serving a copy never stores it again, so its age never resets
  // and ten minutes is the most one answer can ever cover.
  if (!servedFromRecentCopy) {
    rememberAcceptedBundle(
      bundleCacheKey,
      refreshedExpiry ? withRefreshedSessionExpiry(bundleData, refreshedExpiry) : bundleData,
      Date.now(),
      bundleReadStartedAt,
    );
  }

  const access = createAccessContext({
    hrId: effectiveHrId,
    loginId: row.login_id,
    role,
    source: "session",
    testPersona,
  });

  return {
    access,
    appSession: appSession.row,
    payload,
  };
}

export async function resolveSessionAccessContext(
  token: string | null | undefined,
  options: { allowRecentCopy?: boolean } = {},
) {
  const state = await resolveSessionState(token, options);
  return state?.access ?? null;
}

/**
 * The last-accepted session copy (session-bundle-cache.ts) may stand in for a failed login check only on
 * a request that cannot change anything: a GET or HEAD. A POST, PUT, PATCH or DELETE during an outage
 * answers "Session verification is temporarily unavailable" exactly as before the copy existed, so a copy
 * never authorises a write, a send or a credential change (risk review, 18 Oct 2026).
 */
function mayUseRecentSessionCopy(request: Request): boolean {
  const method = String(request.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

async function resolveAccessContextInner(request: Request): Promise<AccessContext> {
  const cookieHeader = request.headers.get("cookie");
  const allowRecentCopy = mayUseRecentSessionCopy(request);
  const sessionContext = await resolveSessionAccessContext(
    getCookieValue(cookieHeader, phoenixSessionCookieName),
    { allowRecentCopy },
  );

  if (sessionContext) {
    return sessionContext;
  }

  // Native clients (the Android app) carry the same signed session token in an Authorization
  // header instead of a cookie — see src/lib/auth/native-session.ts for why, and for why this
  // grants nothing the cookie path does not. It runs AFTER the cookie deliberately: a browser
  // request that has both is a browser request, and its cookie is the more trustworthy of the two.
  // Only this Request-based resolver accepts it; resolveAccessContextFromPage stays cookie-only,
  // because a server-rendered page is never loaded by the native client.
  const bearerContext = await resolveSessionAccessContext(bearerTokenFromRequest(request), { allowRecentCopy });

  if (bearerContext) {
    return bearerContext;
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

export async function resolveAccessContext(request: Request): Promise<AccessContext> {
  const access = await resolveAccessContextInner(request);
  // THE TEST ACCOUNT WRITE GUARD — one choke point for every API route that resolves a caller, before
  // the route runs a line of its own. A test account reads as a real employee, so a save it sent
  // anywhere but Phoenix CRM would be written as her. Refused here, fail-closed; the routes' own
  // try/catch turns it into a 403 with the sentence (src/lib/auth/test-persona.ts) — which was FALSE
  // in 552 route files until 2026-10-02, see isForbiddenError below.
  assertTestAccountMayRun(access, request);
  return access;
}

// Per-request memoized: the admin/portal layout, the page it renders, and AppShell all resolve the
// access context on the same request. React cache() dedupes them to ONE session validation + one
// set of employees/app_auth_users reads per request (was re-run per call → the bulk of the ~154k
// employee reads). cache() is request-scoped, so it never leaks a session across requests and stays
// correct under force-dynamic; the session-version / role / active / lifecycle checks still run
// (once) and their rejection audits still fire (once).
const resolveAccessContextFromPageInner = cache(async (): Promise<AccessContext> => {
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

export async function resolveAccessContextFromPage(): Promise<AccessContext> {
  const access = await resolveAccessContextFromPageInner();
  // A server action arrives as a POST to a PAGE, which the API guard above never sees. Next marks
  // it with the `next-action` header; a test account never runs one.
  if (access.testPersona && (await headers()).get("next-action")) assertNotTestAccount(access);
  return access;
}

function buildInitials(input: string) {
  const parts = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) return "US";
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

/**
 * Uploaded photo first, then the bundled static portrait — the same order
 * src/lib/employees/employee-photo.ts documents for every other surface that shows a photo.
 * This resolver used to skip the uploaded half entirely, so a self-service upload on
 * /admin/profile (EmployeePhotoEditor, which promises "shown across Phoenix") never reached the
 * CEO/Finance/HR command-centre heroes — they render from this function, not from the profile
 * page's own resolution.
 */
async function resolveViewerPhotoUrl(hrId: string | null | undefined): Promise<string | null> {
  const uploaded = await uploadedEmployeePhotoUrl(hrId).catch(() => null);
  return uploaded ?? employeeProfileImageForHrId(hrId);
}

export const resolveViewerIdentityFromPage = cache(async (accessContext?: AccessContext): Promise<ViewerIdentity> => {
  const access = accessContext ?? await resolveAccessContextFromPage();
  const fallbackName = access.loginId || formatHrIdForDisplay(access.hrId) || "User";
  const fallbackRole = access.role;

  if (access.source === "dev-header" || (!access.loginId && !access.hrId)) {
    return {
      displayName: fallbackName,
      initials: buildInitials(fallbackName),
      roleLabel: displayTitleForAccount(access.hrId, fallbackRole),
      imageUrl: await resolveViewerPhotoUrl(access.hrId),
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
  // `app_auth_users.role` holds the PERMISSION key, not a job title, so it reads HR Advisory for
  // a person whose title is HR Business Partner. (Deliberately unquoted — see the note in
  // hr-command-center.tsx: a quoted seat name here would put this file on the
  // hr-function-governance allowlist and exempt it from that check for good.)
  // This is the one place the topbar chip and its
  // dropdown get their label from, so mapping it here is what puts the real title on every page of
  // an HR seat's account rather than on the pages someone remembered to fix.
  //
  // IT ASKS THE ACCOUNT BEFORE THE SEAT. `displayTitleForAccount` reads account-job-titles.ts
  // first, which is what makes B-10 read "HR Manager" rather than the Super Admin key he
  // signs in with (owner, 2026-09-04; the title itself updated on his promotion, 2026-10-09), and
  // falls back to the seat map for everyone else. The HR ID
  // is the row's own where there is a row — an account can be found by login_id alone, and the
  // request's `access.hrId` is empty in that case.
  const roleLabel = displayTitleForAccount(row?.hr_id ?? access.hrId, row?.role?.trim() || fallbackRole);

  return {
    displayName,
    initials: buildInitials(displayName),
    roleLabel,
    imageUrl: await resolveViewerPhotoUrl(row?.hr_id ?? access.hrId),
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

/**
 * Is this a refusal the caller is not allowed past, as opposed to a fault?
 *
 * 552 route files under `app/api` branch on this to choose 403 over 500, so what it misses, they
 * all miss. It missed one thing: a refusal carrying its status as DATA rather than as a message
 * prefix.
 *
 * `assertTestAccountMayRun` throws `forbiddenError(TEST_ACCOUNT_SAVE_REFUSAL)` — an `ApiError` with
 * `status: 403` whose message begins "This is a test account: …". The prefix test below says no, so
 * every one of those routes fell through to its 500 branch and told a real person the server had
 * broken when it had merely declined. Measured in production: `POST /api/notifications/push/register`
 * returned 500 at 02 Oct 2026 19:12:11 Cairo to a Firefox user, and logged nothing anywhere.
 *
 * Reading `status` first is also the more honest test: a 403 is a 403 because of its status, and the
 * message-prefix check only ever worked because `forbiddenError()`'s default message happens to
 * start with the word. The prefix branch stays for the plain `new Error("Forbidden: …")` throws —
 * `assertPermission` is one — which carry no status at all.
 */
export function isForbiddenError(error: unknown) {
  if (error instanceof ApiError && error.status === 403) return true;
  return error instanceof Error && error.message.toLowerCase().startsWith("forbidden:");
}
