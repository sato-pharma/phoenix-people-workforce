import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  clearSessionBundleCache,
  forgetRememberedBundle,
  forgetRememberedBundlesForSessions,
  mayServeRememberedBundle,
  recallRememberedBundle,
  rememberAcceptedBundle,
  SESSION_BUNDLE_CACHE_MAX_ENTRIES,
  SESSION_BUNDLE_STALE_MAX_AGE_MS,
  sessionBundleCacheKey,
  sessionBundleCacheSize,
  withRefreshedSessionExpiry,
} from "../src/lib/auth/session-bundle-cache.ts";

// THE INCIDENT. 18 Oct 2026: production timed out between 10:30 and 11:55 Cairo. At 10:57 the Talent
// Acquisition seat opened Recruitment four times and met "Session verification is temporarily
// unavailable" each time -- the login check that runs before any page code. `phx_auth_session_bundle`
// (~2 calls a second, no cache) failed its one retry and the whole render threw.
//
// THE DECISION (owner, 18 Oct 2026): the last ACCEPTED bundle may stand in for a failed read for up to
// ten minutes. These tests pin every bound on that, because the cost of getting one wrong is a person
// whose access was removed who keeps getting in: live first, accepted sessions only, same checks,
// never stored again from a copy, never longer than ten minutes.

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const T0 = 1_800_000_000_000;
const MINUTE = 60 * 1000;

function bundle(sessionTag: string) {
  return {
    app_session: { id: sessionTag, idle_expires_at: "2026-10-18T12:00:00.000Z", absolute_expires_at: "2026-10-19T12:00:00.000Z" },
    auth_user: { login_id: "ta", role: "HR Resourcing", is_active: true },
    employee: { employment_status: "active" },
    employee_key: "HR-011",
  };
}

export function runSessionBundleCacheTests() {
  clearSessionBundleCache();

  // ── 1 · the age rule: ten minutes, inclusive, and never from the future ──────────────────────────
  assert.equal(SESSION_BUNDLE_STALE_MAX_AGE_MS, 10 * MINUTE, "ten minutes is the owner's number");
  assert.equal(mayServeRememberedBundle(T0, T0), true);
  assert.equal(mayServeRememberedBundle(T0, T0 + 10 * MINUTE), true, "exactly ten minutes still counts");
  assert.equal(mayServeRememberedBundle(T0, T0 + 10 * MINUTE + 1), false, "one millisecond past ten minutes does not");
  assert.equal(mayServeRememberedBundle(Number.NaN, T0), false);
  assert.equal(
    mayServeRememberedBundle(T0 + 5_000, T0),
    false,
    "a copy stored in the future (a clock step back) is refused -- it could otherwise outlive ten minutes",
  );

  // ── 2 · remember and recall: a copy, in both directions ──────────────────────────────────────────
  {
    const key = sessionBundleCacheKey({ sid: "sid-1", loginId: "ta" });
    const original = bundle("sid-1");
    rememberAcceptedBundle(key, original, T0);
    original.auth_user.role = "Super Admin"; // a later change to the caller's own object...
    const recalled = recallRememberedBundle(key, T0 + 2 * MINUTE);
    assert.deepEqual(recalled?.auth_user, { login_id: "ta", role: "HR Resourcing", is_active: true }, "...must not reach the copy");
    (recalled as { auth_user: { role: string } }).auth_user.role = "CEO"; // nor can a reader edit the next answer
    assert.equal(
      (recallRememberedBundle(key, T0 + 3 * MINUTE)?.auth_user as { role: string }).role,
      "HR Resourcing",
    );
  }

  // ── 3 · THE BOUND: ten minutes from the LIVE answer, and serving never resets the clock ──────────
  {
    clearSessionBundleCache();
    const key = sessionBundleCacheKey({ sid: "sid-2", loginId: "ta" });
    rememberAcceptedBundle(key, bundle("sid-2"), T0);
    assert.ok(recallRememberedBundle(key, T0 + 9 * MINUTE), "served at nine minutes");
    assert.ok(recallRememberedBundle(key, T0 + 9 * MINUTE + 59_000), "and again, still from the ORIGINAL timestamp");
    assert.equal(
      recallRememberedBundle(key, T0 + 10 * MINUTE + 1_000),
      null,
      "serving a copy twice must not have refreshed it: past ten minutes from the live answer it is gone",
    );
    assert.equal(sessionBundleCacheSize(), 0, "an expired copy is dropped, not kept");
  }

  // ── 4 · only an object is remembered ─────────────────────────────────────────────────────────────
  {
    clearSessionBundleCache();
    for (const junk of [null, undefined, "bundle", 42, ["a"]]) rememberAcceptedBundle("k", junk, T0);
    assert.equal(sessionBundleCacheSize(), 0, "a malformed answer is never kept as if it were a session");
  }

  // ── 5 · a live rejection forgets ─────────────────────────────────────────────────────────────────
  {
    clearSessionBundleCache();
    const key = sessionBundleCacheKey({ sid: "sid-3", loginId: "ta" });
    rememberAcceptedBundle(key, bundle("sid-3"), T0);
    forgetRememberedBundle(key);
    assert.equal(recallRememberedBundle(key, T0 + MINUTE), null, "after a live answer the old copy is gone");
  }

  // ── 6 · bounded memory: the oldest goes first, a refresh moves a session to the newest end ───────
  {
    clearSessionBundleCache();
    for (let i = 0; i < SESSION_BUNDLE_CACHE_MAX_ENTRIES; i += 1) rememberAcceptedBundle(`k${i}`, bundle(`s${i}`), T0);
    rememberAcceptedBundle("k0", bundle("s0"), T0 + 1); // k0 is used again -> now the newest
    for (let i = 0; i < 5; i += 1) rememberAcceptedBundle(`extra${i}`, bundle(`e${i}`), T0 + 2);
    assert.equal(sessionBundleCacheSize(), SESSION_BUNDLE_CACHE_MAX_ENTRIES, "the cache never grows past its bound");
    assert.ok(recallRememberedBundle("k0", T0 + MINUTE), "a session seen again survives the eviction");
    assert.equal(recallRememberedBundle("k1", T0 + MINUTE), null, "the oldest unused session was evicted instead");
    assert.ok(recallRememberedBundle("extra4", T0 + MINUTE), "the newest is kept");
  }

  // ── 7 · the key cannot collide across (session, login) pairs ─────────────────────────────────────
  assert.notEqual(
    sessionBundleCacheKey({ sid: "a:b", loginId: "c" }),
    sessionBundleCacheKey({ sid: "a", loginId: "b:c" }),
  );

  // ── 8 · a refresh keeps the copy no more pessimistic than the database ───────────────────────────
  {
    const before = bundle("sid-4");
    const patched = withRefreshedSessionExpiry(before, {
      idleExpiresAt: "2026-10-18T13:00:00.000Z",
      absoluteExpiresAt: "2026-10-19T13:00:00.000Z",
    }) as ReturnType<typeof bundle>;
    assert.equal(patched.app_session.idle_expires_at, "2026-10-18T13:00:00.000Z");
    assert.equal(patched.app_session.absolute_expires_at, "2026-10-19T13:00:00.000Z");
    assert.deepEqual(patched.auth_user, before.auth_user, "nothing else about the session is touched");
    assert.equal(before.app_session.idle_expires_at, "2026-10-18T12:00:00.000Z", "the input is not mutated");
    assert.equal(withRefreshedSessionExpiry("not a bundle", { idleExpiresAt: "x", absoluteExpiresAt: "y" }), "not a bundle");
  }

  // ── 9 · the wiring in server.ts: live first, accepted only, same checks, never stored from a copy ─
  const server = read("src/lib/auth/server.ts");
  const retry = server.indexOf("bundleSettled = await callBundle();\n  }");
  const recall = server.indexOf("recallRememberedBundle(bundleCacheKey)");
  assert.ok(retry > 0 && recall > retry, "a copy is consulted only AFTER the live call and its retry both failed");
  assert.equal((server.match(/recallRememberedBundle\(/g) ?? []).length, 1, "exactly one place may serve a copy");
  assert.ok(
    server.includes("if (!recentCopy) {") && server.includes("throw new SessionVerificationUnavailableError({ cause });"),
    "with no usable copy the outage still raises SessionVerificationUnavailableError exactly as before",
  );
  assert.ok(
    server.includes("const bundle = parseAuthSessionBundle(bundleData);"),
    "a copy is parsed like a live bundle, so every check below runs on it",
  );
  assert.ok(
    server.includes(
      "    forgetRememberedBundle(bundleCacheKey, bundleReadStartedAt);\n  }\n  const bundle = parseAuthSessionBundle(bundleData);",
    ),
    "a live answer forgets the old copy before any check runs",
  );
  assert.ok(
    server.includes("if (!servedFromRecentCopy) {\n    rememberAcceptedBundle("),
    "a copy is never stored again -- that would reset its age and let ten minutes become unlimited",
  );
  assert.ok(
    server.includes("if (options.refreshIdle && !servedFromRecentCopy) {"),
    "an outage must not turn the idle refresh (a write that throws) into a rejection of a session served from a copy",
  );
  const accept = server.indexOf("rememberAcceptedBundle(");
  const gate = server.indexOf("const lifecycleGate =");
  assert.ok(accept > gate, "remembering happens after the lifecycle gate and every rejection check, never before");

  // Nothing else may SERVE a copy: only the one resolver recalls one. The two places that revoke a session
  // import the cache to FORGET it, and nothing more.
  const recallers = [
    "src/lib/auth/app-sessions.ts",
    "src/lib/auth/session.ts",
    "src/lib/activity/service.ts",
    "app/api/auth/heartbeat/route.ts",
    "app/api/auth/logout/route.ts",
  ].filter((file) => read(file).includes("recallRememberedBundle"));
  assert.deepEqual(recallers, [], "no other auth path may serve a remembered bundle");

  // ── 10 · a slow OLDER read cannot bring back a session that a newer answer or a revocation settled ─
  {
    clearSessionBundleCache();
    const key = sessionBundleCacheKey({ sid: "sid-9", loginId: "ta" });
    // Request A began at T0 and its answer is slow; request B began at T0+1s, got a live answer ("revoked")
    // and forgot the copy at that read's start time.
    forgetRememberedBundle(key, T0 + 1_000);
    rememberAcceptedBundle(key, bundle("sid-9"), T0 + 5_000, T0);
    assert.equal(sessionBundleCacheSize(), 0, "A began before B's live answer, so its older picture is refused");
    // B itself, and any read that began after it, may store.
    rememberAcceptedBundle(key, bundle("sid-9"), T0 + 5_000, T0 + 1_000);
    assert.equal(sessionBundleCacheSize(), 1, "the read that produced the live answer may store its own bundle");
    // A forget with no start time drops the copy and blocks nothing.
    clearSessionBundleCache();
    rememberAcceptedBundle(key, bundle("sid-9"), T0);
    forgetRememberedBundle(key);
    rememberAcceptedBundle(key, bundle("sid-9"), T0 + 10, T0);
    assert.equal(sessionBundleCacheSize(), 1, "a plain forget (no read start given) sets no barrier");
  }

  // ── 11 · a logout or forced logout here removes the copy of that session at once ───────────────────
  {
    clearSessionBundleCache();
    const keyA = sessionBundleCacheKey({ sid: "sid-10", loginId: "ta" });
    const keyB = sessionBundleCacheKey({ sid: "sid-11", loginId: "ta" });
    rememberAcceptedBundle(keyA, bundle("sid-10"), T0);
    rememberAcceptedBundle(keyB, bundle("sid-11"), T0);
    forgetRememberedBundlesForSessions(["sid-10", "  ", ""], T0 + MINUTE);
    assert.equal(recallRememberedBundle(keyA, T0 + MINUTE), null, "the revoked session's copy is gone");
    assert.ok(recallRememberedBundle(keyB, T0 + MINUTE), "another session's copy is untouched");
    rememberAcceptedBundle(keyA, bundle("sid-10"), T0 + 2 * MINUTE, T0 + 30_000);
    assert.equal(recallRememberedBundle(keyA, T0 + 2 * MINUTE), null, "a read that began before the revocation cannot restore it");
    rememberAcceptedBundle(keyA, bundle("sid-10"), T0 + 3 * MINUTE, T0 + 2 * MINUTE);
    assert.ok(recallRememberedBundle(keyA, T0 + 3 * MINUTE), "a read that began after the revocation may store");
    forgetRememberedBundlesForSessions([], T0);
    assert.equal(sessionBundleCacheSize(), 2, "an empty list changes nothing");
  }

  // ── 12 · what a copy may NOT do: bind a credential, or authorise a write ───────────────────────────
  assert.ok(
    server.includes("const recentCopy = options.allowRecentCopy === false ? null : recallRememberedBundle(bundleCacheKey);"),
    "a caller can refuse the copy, and then an unreadable bundle throws exactly as it did before the copy",
  );
  assert.ok(
    server.includes('return method === "GET" || method === "HEAD";'),
    "an API request that is not a GET or HEAD never accepts the copy",
  );
  assert.equal(
    (server.match(/\{ allowRecentCopy \}/g) ?? []).length,
    2,
    "both the cookie and the bearer path of the API resolver pass the method rule",
  );
  for (const route of [
    "app/api/auth/biometric/register/options/route.ts",
    "app/api/auth/biometric/register/verify/route.ts",
    "app/api/auth/biometric/credentials/route.ts",
    "app/api/auth/change-password/route.ts",
  ]) {
    assert.ok(
      read(route).includes("resolveSessionState(sessionToken, { allowRecentCopy: false })"),
      `${route} must never run on a copy: a passkey or a password it sets outlives the ten minutes`,
    );
  }
  assert.ok(
    read("src/lib/auth/app-sessions.ts").includes("forgetRememberedBundlesForSessions([normalizedSessionId])"),
    "logout drops this process's copy before the database is even asked",
  );
  assert.ok(
    read("src/lib/activity/service.ts").includes("forgetRememberedBundlesForSessions("),
    "a forced logout drops the copy of every session it revoked",
  );

  clearSessionBundleCache();
}
