import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateEmployeeLifecycleGate,
  isSessionVerificationUnavailable,
  sessionGateOutcome,
  SessionVerificationUnavailableError,
} from "../src/lib/auth/session-lifecycle.ts";

/**
 * A Supabase outage must not sign anybody out.
 *
 * Measured incident, 2026-10-10: the hosted Supabase endpoint answered Cloudflare 521/525 between
 * 11:03 and 11:17 Cairo. The read-time employee lifecycle gate fails closed, and its
 * `employee_lookup_failed` carried the same `allowed: false` a resigned employee gets — so
 * `resolveSessionState` returned null, `/api/auth/heartbeat` read that as "session expired",
 * cleared all three auth cookies and answered 401, and the client signs out on a 401 alone. Ten
 * people hit errors, nine sessions were created then abandoned inside five seconds, one Medical
 * Representative signed in three times in three minutes and another managed eight in three.
 *
 * The fix is that "could not verify" and "verified as departed" are different answers. These tests
 * pin that split, and pin that the heartbeat still answers 503 without touching the cookies.
 */
export async function runSessionUnavailableKeepsSessionTests() {
  // ---------------------------------------------------------------------------
  // 1. The three gate outcomes are distinct, and an unreachable database is NOT a rejection.
  // ---------------------------------------------------------------------------
  const lookupFailed = evaluateEmployeeLifecycleGate({
    lookupFailed: true,
    employmentStatus: null,
  });
  assert.equal(lookupFailed.allowed, false, "a failed lookup must still fail closed");
  assert.equal(
    sessionGateOutcome(lookupFailed),
    "unavailable",
    "a database that could not be reached must read as UNAVAILABLE, never as a rejection — " +
      "mapping it to 'reject' is what signed every working person out during a Supabase blip",
  );

  const departed = evaluateEmployeeLifecycleGate({
    lookupFailed: false,
    employmentStatus: "resigned",
    lastWorkingDate: "2026-01-31",
    todayCairo: "2026-10-10",
  });
  assert.equal(departed.allowed, false, "a resigned employee is still blocked");
  assert.equal(
    sessionGateOutcome(departed),
    "reject",
    "a VERIFIED departure must still end the session — the outage fix must never soften governance",
  );

  const active = evaluateEmployeeLifecycleGate({
    lookupFailed: false,
    employmentStatus: "active",
  });
  assert.equal(sessionGateOutcome(active), "allow", "an active employee keeps working");

  // An employee row that does not exist at all (unlinked/system account) stays allowed, and must
  // not be confused with an unreachable database.
  assert.equal(
    sessionGateOutcome(evaluateEmployeeLifecycleGate({ lookupFailed: false, employmentStatus: null })),
    "allow",
    "an unlinked account is allowed, not unavailable",
  );

  // ---------------------------------------------------------------------------
  // 2. The error type only recognises its own kind.
  // ---------------------------------------------------------------------------
  assert.equal(isSessionVerificationUnavailable(new SessionVerificationUnavailableError()), true);
  assert.equal(
    isSessionVerificationUnavailable(new Error("Session verification is temporarily unavailable.")),
    false,
    "the predicate must test the TYPE, not the message — a look-alike message must not keep a session alive",
  );
  assert.equal(isSessionVerificationUnavailable(null), false);
  assert.equal(isSessionVerificationUnavailable("unavailable"), false);

  // ---------------------------------------------------------------------------
  // 3. The two call sites still wire it up.
  //
  // Comments are stripped FIRST: the explanatory comments at both sites name 401, the cookies and
  // the error type, so an unstripped source assertion would be satisfied by the prose that explains
  // the code rather than by the code (AGENTS.md §2.1, "a source assertion is satisfied by the
  // comment that explains the call").
  // ---------------------------------------------------------------------------
  const stripComments = (source: string) =>
    source
      // Block comments, non-greedy so one comment cannot swallow the code between two of them.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Line comments only where the `//` starts the line (after indent), which cannot eat a URL
      // or a regex literal sitting mid-expression.
      .replace(/^[ \t]*\/\/.*$/gm, "");

  const serverSource = stripComments(readFileSync("src/lib/auth/server.ts", "utf8"));
  assert.match(
    serverSource,
    /sessionGateOutcome\(lifecycleGate\)\s*===\s*"unavailable"/,
    "resolveSessionState must branch on the gate OUTCOME, so an unreachable database cannot fall into the rejection path",
  );
  assert.match(
    serverSource,
    /throw new SessionVerificationUnavailableError\(\)/,
    "an unverifiable session must be RAISED, not returned as null — null is what the heartbeat reads as 'expired'",
  );
  // The rejection audit row must no longer claim a lookup failure is a rejection.
  assert.doesNotMatch(
    serverSource,
    /Session rejected: employee lifecycle lookup failed/,
    "that audit summary described a rejection that no longer happens",
  );

  const heartbeatSource = stripComments(readFileSync("src/lib/auth/session-heartbeat.ts", "utf8"));
  assert.match(
    heartbeatSource,
    /isSessionVerificationUnavailable\(error\)/,
    "the heartbeat must recognise an unavailable verification",
  );
  // The unavailable branch must answer 503. Checked by locating the catch branch and confirming the
  // 503 literal sits inside it, rather than merely existing somewhere in the file.
  const unavailableBranch = heartbeatSource.slice(
    heartbeatSource.indexOf("isSessionVerificationUnavailable(error)"),
  );
  const branchBody = unavailableBranch.slice(0, unavailableBranch.indexOf("throw error"));
  assert.match(
    branchBody,
    /status:\s*503/,
    "an unreachable database must answer 503, never the 401 the client signs out on",
  );
  assert.doesNotMatch(
    branchBody,
    /status:\s*401|maxAge:\s*0/,
    "the unavailable branch must not answer 401 and must not clear a cookie",
  );
}
