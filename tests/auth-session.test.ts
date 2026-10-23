import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import {
  clearSessionActivity,
  handlePossibleSessionDeath,
  isSessionInvalidated,
  markSessionActivity,
  markSessionInvalidated,
  phoenixLastActivityStorageKey,
  phoenixSessionTimeoutReason,
  readSessionActivityAt,
} from "../src/lib/auth/client-session.ts";
import {
  sessionAbsoluteTimeoutSecondsForRole,
  shouldBlockLoginWhenSupabaseBridgeUnavailable,
} from "../src/lib/auth/app-sessions.ts";
import {
  createSessionToken,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
} from "../src/lib/auth/session-token.ts";
import {
  ACTIVE_EMPLOYMENT_STATUSES,
  evaluateEmployeeLifecycleGate,
  isEmploymentAccessRevoked,
  isTerminalEmploymentStatus,
} from "../src/lib/auth/session-lifecycle.ts";
import {
  canAccess,
  createAccessContext,
  resolveNavigationMode,
} from "../src/lib/auth/permissions.ts";
import {
  isAllowedPhoenixOrigin,
  rejectUntrustedForwardedOrigin,
  trustedOriginForRedirect,
} from "../src/lib/security/origins.ts";
import { systemDeployment } from "../src/config/system-settings.ts";
import { isPreviewBuilderLoginRequest } from "../proxy.ts";

function createMemoryStorage() {
  const values = new Map<string, string>();

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;
}

export async function runAuthSessionTests() {
  process.env.PHOENIX_AUTH_SECRET = process.env.PHOENIX_AUTH_SECRET || "test-session-secret";

  // No separate idle window: a session's idle allowance now equals its absolute
  // lifetime, so inactivity alone can never expire a session before the absolute cap
  // does (see src/lib/auth/session-token.ts).
  assert.equal(sessionIdleTimeoutSecondsForRole("Employee"), sessionAbsoluteTimeoutSecondsForRole("Employee"));
  assert.equal(sessionIdleTimeoutSecondsForRole("Super Admin"), sessionAbsoluteTimeoutSecondsForRole("Super Admin"));

  const token = createSessionToken({
    hrId: "B-67",
    loginId: "B-67",
    maxAgeSeconds: sessionIdleTimeoutSecondsForRole("Employee"),
    role: "Employee",
    sessionId: "session-1",
    sessionVersion: 1,
  });
  const payload = verifySessionToken(token);

  assert.ok(payload);
  assert.equal(payload.loginId, "B-67");
  assert.equal(payload.exp - payload.iat, sessionAbsoluteTimeoutSecondsForRole("Employee"));

  const storage = createMemoryStorage();
  assert.equal(phoenixSessionTimeoutReason, "session-timeout");
  assert.equal(readSessionActivityAt(storage), null);
  storage.setItem(phoenixLastActivityStorageKey, "not-a-date");
  assert.equal(readSessionActivityAt(storage), null);
  markSessionActivity(storage, 1_800_000_000_000);
  assert.equal(readSessionActivityAt(storage), 1_800_000_000_000);
  clearSessionActivity(storage);
  assert.equal(readSessionActivityAt(storage), null);

  // ===========================================================================
  // Heartbeat/logout race guard: distinguishes "your session just died" from a
  // genuine permission-denied 403 (see src/lib/auth/client-session.ts).
  // ===========================================================================
  assert.equal(isSessionInvalidated(), false, "session must not start invalidated");
  assert.equal(
    handlePossibleSessionDeath({ status: 403 }),
    false,
    "handlePossibleSessionDeath is a no-op outside a browser (no window)",
  );

  const originalWindow = (globalThis as { window?: unknown }).window;
  const assignedUrls: string[] = [];
  (globalThis as { window?: unknown }).window = {
    location: {
      assign(url: string) {
        assignedUrls.push(url);
      },
    },
  };
  try {
    assert.equal(
      handlePossibleSessionDeath({ status: 403 }),
      false,
      "a plain 403 is not treated as a session death before the guard has been tripped",
    );
    assert.equal(assignedUrls.length, 0, "no redirect for a genuine permission-denied 403");

    assert.equal(
      handlePossibleSessionDeath({ status: 401 }),
      true,
      "401 is always treated as a session death",
    );
    assert.equal(assignedUrls.at(-1), `/login?reason=${phoenixSessionTimeoutReason}`);

    markSessionInvalidated("test_reason");
    assert.equal(isSessionInvalidated(), true, "marking invalidation must be observable");
    assert.equal(
      handlePossibleSessionDeath({ status: 403 }),
      true,
      "a 403 counts as a session death once the guard has been tripped",
    );
    assert.equal(assignedUrls.at(-1), `/login?reason=${phoenixSessionTimeoutReason}`);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }

  const sessionSecurityGuardSource = readFileSync(
    new URL("../src/components/auth/session-security-guard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    sessionSecurityGuardSource,
    /markSessionInvalidated\("heartbeat_401"\)/,
    "heartbeat 401 must mark the session invalidated before the logout redirect",
  );
  // No separate client-side idle clock: a local inactivity timer used to force-logout
  // a tab after 15 minutes of no clicks/keys, independent of the server-side session
  // state — removed so opening the app (e.g. from a push notification) well after the
  // last click doesn't land on /login while the server-side session is still valid.
  assert.doesNotMatch(
    sessionSecurityGuardSource,
    /client_idle_timeout/,
    "no separate client-side idle timeout should force a logout independent of server session state",
  );

  // ===========================================================================
  // WP-3: read-time session lifecycle governance.
  // ===========================================================================

  // Active employee statuses keep access (no terminal rejection).
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("active"), true, "active is an allowed status");
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("on_leave"), true, "on_leave is an allowed status");
  assert.equal(isTerminalEmploymentStatus("active"), false, "active employee + active app user is allowed");
  assert.equal(isTerminalEmploymentStatus("on_leave"), false, "on-leave employee remains allowed");
  assert.equal(isTerminalEmploymentStatus("ACTIVE"), false, "status check is case-insensitive");

  // Terminal employee statuses are denied even when the app user is still active.
  assert.equal(isTerminalEmploymentStatus("resigned"), true, "resigned employee + active app user is denied");
  assert.equal(isTerminalEmploymentStatus("terminated"), true, "terminated employee + active app user is denied");
  assert.equal(isTerminalEmploymentStatus("not_renewed"), true, "non-renewed employee is denied");
  assert.equal(isTerminalEmploymentStatus("inactive"), true, "inactive employee is denied");
  assert.equal(isTerminalEmploymentStatus(" Resigned "), true, "status is trimmed before comparison");

  // Missing / unset status must NOT lock out (unlinked or legacy rows stay allowed
  // so the rule can only tighten access for confirmed-terminal employees).
  assert.equal(isTerminalEmploymentStatus(null), false, "null status is not terminal");
  assert.equal(isTerminalEmploymentStatus(undefined), false, "undefined status is not terminal");
  assert.equal(isTerminalEmploymentStatus(""), false, "empty status is not terminal");

  // Read-time lifecycle gate decision (pure):
  // active / on_leave -> allowed.
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "active" }).allowed,
    true,
    "active employee + active app user is allowed",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "on_leave" }).allowed,
    true,
    "on_leave employee is allowed",
  );
  // null / empty status (incl. employee row not found, surfaced as null) -> allowed.
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: null }).allowed,
    true,
    "missing/unset status remains allowed (unlinked/system account)",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "" }).allowed,
    true,
    "empty status remains allowed",
  );
  // terminal status -> denied with an audited reason.
  const terminalGate = evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "resigned" });
  assert.equal(terminalGate.allowed, false, "resigned employee is denied");
  assert.equal(
    terminalGate.allowed === false && terminalGate.reason,
    "employee_terminal",
    "terminal denial carries the employee_terminal reason",
  );
  assert.equal(
    evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: "terminated" }).allowed,
    false,
    "terminated employee is denied",
  );
  // unexpected lookup error -> DENIED (fail closed, not silently allowed).
  const errorGate = evaluateEmployeeLifecycleGate({ lookupFailed: true, employmentStatus: "active" });
  assert.equal(errorGate.allowed, false, "unexpected employee lookup error is denied, not allowed");
  assert.equal(
    errorGate.allowed === false && errorGate.reason,
    "employee_lookup_failed",
    "lookup-failure denial carries the employee_lookup_failed reason",
  );

  // ===========================================================================
  // A departure is DATED, not FILED (2026-09-03).
  //
  // Keying access on the moment the exit was filed is wrong in both directions. A-16's exit was
  // filed 2026-08-28 for a 2026-08-31 last working day, so she was locked out on 2026-08-30 while
  // still employed — and it presented as a PASSWORD problem: two failed logins, then a reset link,
  // a password reset, a setup link and a password setup inside three minutes, none of which could
  // help. PD-0006's exit was filed eight days LATE, so he signed in after leaving and wrote two
  // junk venue rows to production. Code cannot close the late case; it can make the block DATED.
  // ===========================================================================
  const cairoToday = "2026-08-30";

  // Serving out notice: the last working day is still AHEAD, so access holds. This is the A-16 case.
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: "2026-08-31", todayCairo: cairoToday }),
    false,
    "a resigned employee whose last working day is still ahead keeps access",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "terminated", lastWorkingDate: "2026-09-15", todayCairo: cairoToday }),
    false,
    "a terminated employee serving notice keeps access until the last working day",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: " Not_Renewed ", lastWorkingDate: "2026-08-31", todayCairo: cairoToday }),
    false,
    "status is trimmed and lower-cased before the dated grace is applied",
  );
  assert.equal(
    isEmploymentAccessRevoked({
      employmentStatus: "resigned",
      lastWorkingDate: "2026-08-31T00:00:00.000Z",
      todayCairo: cairoToday,
    }),
    false,
    "a full ISO instant is read by its date half, not dropped to no-grace",
  );

  // STRICTLY AFTER: a departure dated TODAY revokes at once, so a same-day termination is not widened.
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: cairoToday, todayCairo: cairoToday }),
    true,
    "the last working day itself is the last day of access, not the first day after it",
  );
  // Departed and the day has passed. This is the PD-0006 case.
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: "2026-08-20", todayCairo: cairoToday }),
    true,
    "a resigned employee whose last working day has passed is revoked",
  );

  // No grace on missing or unusable data -> the pre-2026-09-03 block. This rule can only ever
  // RESTORE access to someone the company's own record says is still working.
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: null, todayCairo: cairoToday }),
    true,
    "a resigned employee with no last working day is revoked, exactly as before this rule",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: "not a date", todayCairo: cairoToday }),
    true,
    "an unparseable last working day grants no grace",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned", lastWorkingDate: "2026-08-31", todayCairo: null }),
    true,
    "a caller that supplies no today grants no grace",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "resigned" }),
    true,
    "the dateless call is the old behaviour, unchanged",
  );

  // The grace is for PEOPLE SERVING NOTICE only. Ledger artefacts and any other non-active status
  // are revoked unconditionally, whatever date sits on the row.
  for (const ledgerStatus of ["inactive", "historical_payroll_record", "system_placeholder"]) {
    assert.equal(
      isEmploymentAccessRevoked({
        employmentStatus: ledgerStatus,
        lastWorkingDate: "2099-01-01",
        todayCairo: cairoToday,
      }),
      true,
      `${ledgerStatus} is revoked unconditionally — a future date grants it no grace`,
    );
  }

  // A status that was never terminal is never revoked, whatever date sits beside it.
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: "active", lastWorkingDate: "2026-08-20", todayCairo: cairoToday }),
    false,
    "an active employee is never revoked by a stale last working day",
  );
  assert.equal(
    isEmploymentAccessRevoked({ employmentStatus: null, lastWorkingDate: "2026-08-20", todayCairo: cairoToday }),
    false,
    "an unset status stays allowed (unlinked/system account)",
  );

  // Same decision through the gate the callers actually use.
  assert.equal(
    evaluateEmployeeLifecycleGate({
      lookupFailed: false,
      employmentStatus: "resigned",
      lastWorkingDate: "2026-08-31",
      todayCairo: cairoToday,
    }).allowed,
    true,
    "the gate lets someone serving out notice keep their session",
  );
  const datedTerminalGate = evaluateEmployeeLifecycleGate({
    lookupFailed: false,
    employmentStatus: "resigned",
    lastWorkingDate: "2026-08-20",
    todayCairo: cairoToday,
  });
  assert.equal(datedTerminalGate.allowed, false, "the gate denies once the last working day has passed");
  assert.equal(
    datedTerminalGate.allowed === false && datedTerminalGate.reason,
    "employee_terminal",
    "a dated denial still carries the employee_terminal reason",
  );
  // A lookup failure outranks the grace — governance still fails CLOSED.
  assert.equal(
    evaluateEmployeeLifecycleGate({
      lookupFailed: true,
      employmentStatus: "resigned",
      lastWorkingDate: "2026-08-31",
      todayCairo: cairoToday,
    }).allowed,
    false,
    "a lookup failure denies even when the last working day is still ahead",
  );

  // Wiring: server session resolution must enforce lifecycle at read time without
  // relying on app_auth_users.is_active alone, and must keep the existing gates.
  const serverSource = readFileSync(
    new URL("../src/lib/auth/server.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    serverSource,
    /resolveEmployeeLifecycleGate\(supabase, effectiveHrId\)/,
    "session resolution must evaluate the linked employee lifecycle gate",
  );
  // ...keyed on the FRESH row's own HR id — or, for a test login, on the employee it mirrors, so a test
  // login stops the day that person leaves (src/lib/auth/test-persona.ts).
  assert.match(
    serverSource,
    /const effectiveHrId = testPersona \? testPersona\.mirrorsHrId : row\.hr_id;/,
    "the lifecycle gate's HR id is the fresh row's own for every real account",
  );
  assert.match(
    serverSource,
    /if \(!lifecycleGate\.allowed\)/,
    "session must be rejected when the lifecycle gate denies",
  );
  // Fail-closed on lookup error: the error branch must deny, not allow.
  assert.match(
    serverSource,
    /if \(error\) return \{ allowed: false, reason: "employee_lookup_failed" \}/,
    "an unexpected employee lookup error must fail closed (deny)",
  );
  assert.match(
    serverSource,
    /employment_status/,
    "session resolution must read employees.employment_status",
  );
  // The gate is only dated if the date is actually SELECTED and handed over. Reading the status
  // alone silently reverts to blocking on the filing moment.
  assert.match(
    serverSource,
    /\.select\("employment_status, last_working_date"\)/,
    "session resolution must select last_working_date alongside the status",
  );
  assert.match(
    serverSource,
    /todayCairo: currentCairoDateOnlyIso\(\)/,
    "session resolution must compare against the Cairo date, not the server's local date",
  );
  // Existing gates remain unchanged: inactive app user and session-version checks.
  assert.match(serverSource, /if \(!row\.is_active\)/, "is_active gate must remain");
  assert.match(
    serverSource,
    /reason: "session_version_mismatch"/,
    "session_version invalidation must remain unchanged",
  );

  // Login-time lifecycle gate: authenticateLoginId must ALSO block an employee whose departure has
  // taken effect (defense-in-depth with the read-time session gate), using the SAME
  // isEmploymentAccessRevoked helper, so a departed person cannot sign in even when
  // app_auth_users.is_active is stale (e.g. status set via CSV import outside the resignation RPC).
  const credentialsSource = readFileSync(
    new URL("../src/lib/auth/credentials.ts", import.meta.url),
    "utf8",
  );
  assert.match(credentialsSource, /isEmploymentAccessRevoked/, "login must reuse the shared dated-departure helper");
  assert.match(
    credentialsSource,
    /\.select\("employment_status, last_working_date"\)/,
    "login must read the last working day, not the status alone",
  );
  assert.match(
    credentialsSource,
    /todayCairo: currentCairoDateOnlyIso\(\)/,
    "login must compare against the Cairo date",
  );
  assert.match(
    credentialsSource,
    /if \(await isLinkedEmployeeAccessRevoked\(lifecycleHrIdOf\(row\)\)\) return null/,
    "authenticateLoginId must deny sign-in once a linked employee's departure has taken effect",
  );
  // The HR id that gate reads is the row's own — or, for a test login, the employee it mirrors
  // (src/lib/auth/test-persona.ts), so a test login stops the day that person leaves.
  assert.match(
    credentialsSource,
    /return row\.is_test_persona === true \? row\.test_persona_of_hr_id \?\? null : row\.hr_id;/,
    "the sign-in lifecycle gate reads the account's own HR id for every real account",
  );
  // Passkey sign-in resolves the account AFTER the WebAuthn signature, with no password to compare,
  // so it must apply the same gate or a passkey becomes a way around it. Both call sites, not one.
  assert.equal(
    credentialsSource.split("if (await isLinkedEmployeeAccessRevoked(lifecycleHrIdOf(row))) return null").length - 1,
    2,
    "both password and passwordless sign-in must apply the lifecycle gate",
  );

  // ===========================================================================
  // Auth hardening: DB-backed app sessions, bridge enforcement, guest access.
  // ===========================================================================
  const appSessionsSource = readFileSync(
    new URL("../src/lib/auth/app-sessions.ts", import.meta.url),
    "utf8",
  );
  const loginRouteSource = readFileSync(
    new URL("../app/api/auth/login/route.ts", import.meta.url),
    "utf8",
  );
  const supabaseServerSource = readFileSync(
    new URL("../src/lib/supabase/server.ts", import.meta.url),
    "utf8",
  );
  const supabaseIdentitySource = readFileSync(
    new URL("../src/lib/auth/supabase-identity.ts", import.meta.url),
    "utf8",
  );
  const passwordSetupSource = readFileSync(
    new URL("../src/lib/auth/password-setup.ts", import.meta.url),
    "utf8",
  );
  const heartbeatRouteSource = readFileSync(
    new URL("../src/lib/auth/session-heartbeat.ts", import.meta.url),
    "utf8",
  );
  const logoutRouteSource = readFileSync(
    new URL("../app/api/auth/logout/route.ts", import.meta.url),
    "utf8",
  );
  const rateLimitSource = readFileSync(
    new URL("../src/lib/security/api-rate-limit.ts", import.meta.url),
    "utf8",
  );
  const originsSource = readFileSync(
    new URL("../src/lib/security/origins.ts", import.meta.url),
    "utf8",
  );
  const csrfSource = readFileSync(
    new URL("../src/lib/security/csrf.ts", import.meta.url),
    "utf8",
  );
  const apiCsrfSource = readFileSync(
    new URL("../src/lib/security/api-csrf.ts", import.meta.url),
    "utf8",
  );
  const passwordSetupRouteSource = readFileSync(
    new URL("../app/api/auth/password-setup/[token]/route.ts", import.meta.url),
    "utf8",
  );
  const migrationSource = readFileSync(
    new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260601195242_auth_session_hardening.sql", import.meta.url),
    "utf8",
  );

  assert.match(migrationSource, /create table if not exists public\.app_sessions/, "migration must add app_sessions");
  assert.match(migrationSource, /idle_expires_at timestamptz not null/, "app_sessions must track idle expiry");
  assert.match(migrationSource, /absolute_expires_at timestamptz not null/, "app_sessions must track absolute expiry");
  assert.match(migrationSource, /revoke all on table public\.app_sessions from anon, authenticated/, "app_sessions must not be browser-readable");
  assert.match(migrationSource, /to service_role[\s\S]*using \(true\)[\s\S]*with check \(true\)/, "app_sessions must be service-role only");
  assert.match(migrationSource, /create or replace function public\.api_rate_limit_consume/, "rate limiting must have an atomic database function");

  assert.match(appSessionsSource, /defaultAbsoluteTimeoutSeconds = 12 \* 60 \* 60/, "absolute app session lifetime must default to 12 hours");
  assert.match(appSessionsSource, /\.from\("app_sessions"\)[\s\S]*\.insert/, "login helper must create app session rows");
  assert.match(appSessionsSource, /revoked_at/, "app session validation must reject revoked sessions");
  assert.match(appSessionsSource, /idle_expired/, "app session validation must reject idle-expired sessions");
  assert.match(appSessionsSource, /absolute_expired/, "app session validation must reject absolute-expired sessions");
  assert.match(appSessionsSource, /session_version_mismatch/, "app session validation must reject stale session versions");
  assert.match(appSessionsSource, /role_changed/, "app session validation must reject stale roles");
  assert.match(appSessionsSource, /refreshAppSessionIdle/, "heartbeat must have a DB idle refresh helper");
  assert.match(appSessionsSource, /revoked_reason:\s*reason/, "logout must persist a revocation reason");
  assert.match(
    appSessionsSource,
    /"Super Admin"[\s\S]*"CEO"[\s\S]*"Finance Manager"[\s\S]*"SFE Manager"[\s\S]*"National Sales Manager"/,
    "privileged bridge enforcement must cover all specified roles",
  );
  assert.match(appSessionsSource, /shouldBlockLoginWhenSupabaseBridgeUnavailable/, "privileged bridge strictness must be gated");
  assert.match(appSessionsSource, /PHOENIX_STRICT_SUPABASE_BRIDGE === "true"/, "strict bridge enforcement must be opt-in via PHOENIX_STRICT_SUPABASE_BRIDGE");

  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalStrictBridge = process.env.PHOENIX_STRICT_SUPABASE_BRIDGE;
  try {
    // Strict enforcement is OPT-IN. Default (unset) must NOT block privileged login even
    // in production: the Supabase bridge is best-effort on Cloud Run and login falls back
    // to a Phoenix-only session. Gating this on the production runtime locked out admins
    // (incident 2026-07-11) — the default must stay non-blocking.
    delete process.env.PHOENIX_STRICT_SUPABASE_BRIDGE;
    process.env.VERCEL_ENV = "production";
    assert.equal(shouldBlockLoginWhenSupabaseBridgeUnavailable("Super Admin"), false, "default (unset) must not block privileged login, even in production");
    assert.equal(shouldBlockLoginWhenSupabaseBridgeUnavailable("Employee"), false, "non-privileged bridge failure must not block login");
    process.env.PHOENIX_STRICT_SUPABASE_BRIDGE = "false";
    assert.equal(shouldBlockLoginWhenSupabaseBridgeUnavailable("Super Admin"), false, "explicit false must not block privileged login");
    process.env.PHOENIX_STRICT_SUPABASE_BRIDGE = "true";
    assert.equal(shouldBlockLoginWhenSupabaseBridgeUnavailable("Super Admin"), true, "explicit strict bridge env must force blocking");
    assert.equal(shouldBlockLoginWhenSupabaseBridgeUnavailable("Employee"), false, "strict mode still must not block non-privileged roles");
  } finally {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalStrictBridge === undefined) delete process.env.PHOENIX_STRICT_SUPABASE_BRIDGE;
    else process.env.PHOENIX_STRICT_SUPABASE_BRIDGE = originalStrictBridge;
  }

  // The app_sessions row now arrives inside the phx_auth_session_bundle RPC (one round trip for
  // the auth trio) instead of from validateAppSession's own read — but it is still READ from the
  // database and still put through every rejection rule, which is what this has always pinned.
  assert.match(serverSource, /phx_auth_session_bundle/, "server access resolution must read the DB app session");
  assert.match(
    serverSource,
    /evaluateAppSessionRow\(bundle\.appSession, payload\)/,
    "server access resolution must apply the app_sessions rejection rules to the row it read",
  );
  assert.match(serverSource, /appSessionRejectionSummary/, "DB session rejections must be audited with explicit reasons");
  assert.match(serverSource, /refreshAppSessionIdle/, "heartbeat must reuse server session validation before refreshing DB idle expiry");
  assert.match(serverSource, /source:\s*"guest"/, "anonymous context must be explicit guest access");

  assert.match(loginRouteSource, /assertApiRateLimit/, "login route must use API bucket rate limiting");
  assert.match(loginRouteSource, /rejectUntrustedForwardedOrigin/, "login route must reject untrusted origins/forwarded hosts");
  assert.match(loginRouteSource, /isSupabaseBridgeRequiredForRole/, "login route must enforce privileged Supabase bridge strictness");
  assert.match(loginRouteSource, /shouldBlockLoginWhenSupabaseBridgeUnavailable/, "login route must only hard-block bridge failure in strict environments");
  assert.match(loginRouteSource, /createAppSession/, "login route must create an app_sessions row before issuing a cookie");
  assert.match(loginRouteSource, /auth_bridge_unavailable/, "privileged bridge failure must fail login");
  assert.match(loginRouteSource, /supabaseSessionAvailable:\s*Boolean\(supabaseSession\)/, "bridge fallback status must be recorded");
  assert.match(loginRouteSource, /persistSupabaseAuthIdentityLink/, "login bridge repair must persist repaired auth/profile links");
  assert.match(passwordSetupSource, /persistSupabaseAuthIdentityLink/, "password setup must persist repaired auth/profile links");
  assert.match(supabaseServerSource, /getSupabaseAuthBridgeClient/, "server must expose a server-only auth bridge client");
  assert.match(
    supabaseServerSource,
    /NEXT_PUBLIC_SUPABASE_ANON_KEY[\s\S]*SUPABASE_SERVICE_ROLE_KEY/,
    "auth bridge client must recover on previews missing the anon key without exposing service role to the browser",
  );
  assert.match(supabaseIdentitySource, /findAuthUserIdByEmail/, "auth provisioning must recover stale stored auth_user_id links by email");
  assert.match(supabaseIdentitySource, /listUsers/, "stale auth identity recovery must search Supabase Auth users");
  assert.match(supabaseIdentitySource, /persistSupabaseAuthIdentityLink/, "auth identity helper must persist app/profile auth links");
  assert.match(supabaseIdentitySource, /\.from\("app_auth_users"\)[\s\S]*auth_user_id/, "auth identity helper must update app_auth_users auth link");
  assert.match(supabaseIdentitySource, /\.from\("user_access_profiles"\)[\s\S]*\.upsert/, "auth identity helper must upsert user_access_profiles auth link");

  assert.match(heartbeatRouteSource, /resolveSessionState\(sessionToken, \{ refreshIdle: true \}\)/, "heartbeat must use server validation and refresh DB idle expiry");
  assert.match(heartbeatRouteSource, /auth:heartbeat/, "heartbeat must be API-bucket rate limited");
  assert.match(logoutRouteSource, /revokeAppSession\(session\.sid, "logout"\)/, "logout must revoke the DB session");
  assert.match(logoutRouteSource, /auth:logout/, "logout must be API-bucket rate limited");
  assert.match(passwordSetupRouteSource, /auth:password_setup/, "password setup completion must be API-bucket rate limited");
  assert.match(rateLimitSource, /\.rpc\("api_rate_limit_consume"/, "API rate limiting must prefer atomic DB consumption");

  assert.match(originsSource, /PHOENIX_ALLOWED_ORIGINS/, "trusted origin helper must support PHOENIX_ALLOWED_ORIGINS");
  // Production + working-preview origins are now single-sourced from systemDeployment
  // (see origins.ts), so assert the BEHAVIOUR (they are trusted) rather than a source
  // literal that drifts whenever the deploy config changes.
  assert.equal(
    isAllowedPhoenixOrigin(systemDeployment.productionUrl),
    true,
    "production origin must be trusted by default (derived from systemDeployment.productionUrl)",
  );
  // Post-migration: the legacy *.vercel.app preview origins are NO LONGER trusted for
  // CSRF/redirect. They must be rejected, and login redirects from them must fall back
  // to the canonical production origin rather than staying on the vercel alias.
  assert.equal(
    isAllowedPhoenixOrigin("https://phoenix-workforce-team.vercel.app"),
    false,
    "legacy team preview alias must NOT be trusted after the Vercel -> Cloud Run migration",
  );
  assert.equal(
    isAllowedPhoenixOrigin("https://phoenix-workforce-git-co-c8df8e-phoenix-hr-workspace-s-projects.vercel.app"),
    false,
    "legacy working-preview vercel origin must NOT be trusted",
  );
  assert.match(originsSource, /rejectUntrustedForwardedOrigin/, "unknown origins and forwarded hosts must be rejected");
  assert.match(csrfSource, /isAllowedPhoenixOrigin/, "CSRF expected origins must be allowlist-filtered");
  assert.match(apiCsrfSource, /requestOriginCandidates/, "plain API CSRF guard must use the same origin candidate logic");

  const teamAliasRequest = new Request("https://phoenix-workforce-team.vercel.app/api/auth/login", {
    headers: {
      origin: "https://phoenix-workforce-team.vercel.app",
      referer: "https://phoenix-workforce-team.vercel.app/login",
      "x-forwarded-host": "phoenix-workforce-team.vercel.app",
      "x-forwarded-proto": "https",
    },
  });
  assert.deepEqual(
    rejectUntrustedForwardedOrigin(teamAliasRequest),
    { origin: "https://phoenix-workforce-team.vercel.app", reason: "untrusted_forwarded_host" },
    "a login attempt from the legacy vercel alias must now be rejected as an untrusted origin",
  );
  assert.equal(
    trustedOriginForRedirect(teamAliasRequest),
    systemDeployment.productionUrl,
    "login redirects from an untrusted vercel alias must fall back to the canonical production origin",
  );

  const originalBuilderAllowedOrigins = process.env.PHOENIX_ALLOWED_ORIGINS;
  try {
    process.env.PHOENIX_ALLOWED_ORIGINS = "https://builder.io";

    const builderLoginRequest = new NextRequest("https://phoenix-hr.satopharma.com/api/auth/login", {
      headers: {
        origin: "https://builder.io",
        referer: "https://builder.io/app/projects/0ae41ba2cad449c8bf70/vast-cruiser-5ct7suka",
        "x-forwarded-host": "phoenix-hr.satopharma.com",
        "x-forwarded-proto": "https",
      },
      method: "POST",
    });

    assert.equal(
      isPreviewBuilderLoginRequest(builderLoginRequest),
      true,
      "Builder.io may submit login only when explicitly allow-listed",
    );
    assert.equal(
      rejectUntrustedForwardedOrigin(builderLoginRequest),
      null,
      "Builder.io login origin must pass when it is explicitly allow-listed",
    );

    delete process.env.PHOENIX_ALLOWED_ORIGINS;
    assert.equal(
      isPreviewBuilderLoginRequest(builderLoginRequest),
      false,
      "Builder.io login CSRF exception must not apply without the preview allow-list env",
    );

    process.env.PHOENIX_ALLOWED_ORIGINS = "https://builder.io";
    const builderHeartbeatRequest = new NextRequest("https://phoenix-hr.satopharma.com/api/auth/heartbeat", {
      headers: { origin: "https://builder.io" },
      method: "POST",
    });
    assert.equal(
      isPreviewBuilderLoginRequest(builderHeartbeatRequest),
      false,
      "Builder.io CSRF exception must stay scoped to the login endpoint",
    );
  } finally {
    if (originalBuilderAllowedOrigins === undefined) delete process.env.PHOENIX_ALLOWED_ORIGINS;
    else process.env.PHOENIX_ALLOWED_ORIGINS = originalBuilderAllowedOrigins;
  }

  const guest = createAccessContext({ source: "guest" });
  assert.equal(guest.scope, "none", "guest context must have no scope");
  assert.equal(resolveNavigationMode(guest), "employee-portal", "guest navigation remains non-admin");
  assert.equal(await canAccess(guest, "employee_profile", "read"), false, "guest cannot read employee profile");
  assert.equal(await canAccess(guest, "sales", "read"), false, "guest cannot read sales");
  assert.equal(await canAccess(guest, "admin", "read"), false, "guest cannot read admin");
}
