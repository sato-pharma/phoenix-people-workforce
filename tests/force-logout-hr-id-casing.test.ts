import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { hrIdLookupKeys } from "@/lib/hr-id";

const activitySource = readFileSync(
  new URL("../src/lib/activity/service.ts", import.meta.url),
  "utf8",
);

/**
 * Force logout revoked NOTHING, for every user, silently.
 *
 * `app_sessions.hr_id` is written verbatim from the login payload, so in
 * production it holds the uppercase display spelling — measured 2026-08-09:
 * 2,627 uppercase rows, 549 mixed-case (`admin-HR`), and ZERO lowercase out of
 * 3,176. `forceLogoutUser` ran the value through `normalizeHrId` (which
 * lower-cases) and then filtered with a case-SENSITIVE PostgREST `.eq`, so it
 * matched no row at all. It returned `{ revokedCount: 0 }` next to a 200, which
 * the admin UI showed as success while ~1,900 live sessions across 34 users
 * stayed valid.
 *
 * The trap this test also guards: `activity_events` stores the OPPOSITE casing
 * (23,967 of 23,967 rows lowercase). "Normalise it all one way" fixes one table
 * and breaks the other, so the two must be asserted separately.
 */
export function runForceLogoutHrIdCasingTests() {
  // ── The helper must actually offer the stored spelling (behavioural) ───────
  // Production stores "B-10"; an admin action normalises to "b-10". The lookup
  // key set has to contain the uppercase form or the match can never happen.
  const keys = hrIdLookupKeys("b-10");
  assert.ok(keys.includes("B-10"), "lookup keys must include the uppercase spelling app_sessions actually stores");
  assert.ok(keys.includes("b-10"), "lookup keys must still include the lower-cased key form");

  for (const input of ["B-10", " b-10 ", "B-10"]) {
    assert.ok(
      hrIdLookupKeys(input).includes("B-10"),
      `"${input}" must resolve to the stored uppercase spelling`,
    );
  }

  // A real production HR_ID shape with digits and a longer prefix.
  assert.ok(hrIdLookupKeys("ai-0003").includes("AI-0003"), "AI-0003 must be reachable from its lower-cased key");
  assert.ok(hrIdLookupKeys("phx-1").includes("PHX-1"), "PHX-1 must be reachable from its lower-cased key");

  // Empty / junk input must not produce a filter that matches everything.
  assert.deepEqual(hrIdLookupKeys(""), [], "an empty HR_ID must yield no lookup keys, never a wildcard match");
  assert.deepEqual(hrIdLookupKeys(null), [], "a null HR_ID must yield no lookup keys");

  // No key may contain a SQL wildcard — these are used in an .in() filter, and a
  // stray % or _ would silently widen a security action to other users.
  for (const key of hrIdLookupKeys("b-10")) {
    assert.doesNotMatch(key, /[%_]/, `lookup key "${key}" must not contain a SQL wildcard`);
  }

  // ── forceLogoutUser must not use the case-sensitive filter again ───────────
  const forceLogout = activitySource.slice(activitySource.indexOf("export async function forceLogoutUser"));
  const forceLogoutBody = forceLogout.slice(0, forceLogout.indexOf("\n}") + 2);

  assert.match(
    forceLogoutBody,
    /\.in\("hr_id", hrIdLookupKeys\(hrId\)\)/,
    "forceLogoutUser must match every accepted HR_ID spelling — app_sessions stores the uppercase display form, so a lower-cased .eq revokes nothing for anyone.",
  );

  assert.doesNotMatch(
    forceLogoutBody,
    /\.eq\("hr_id", normalized\)/,
    "forceLogoutUser must never filter app_sessions with the lower-cased key again — that is the exact bug that made this a silent no-op.",
  );

  // It must still only touch sessions that are actually live.
  assert.match(
    forceLogoutBody,
    /\.is\("revoked_at", null\)/,
    "forceLogoutUser must only revoke sessions that are still live.",
  );

  // ── The per-user timeline had the same mismatch ────────────────────────────
  assert.match(
    activitySource,
    /q\.in\("hr_id", hrIdLookupKeys\(targetHrId\)\)[\s\S]{0,120}SESSION_FETCH_CAP/,
    "the per-user activity timeline must fetch app_sessions by every accepted spelling, or it shows a user's events with no sessions at all",
  );

  // ── activity_events must KEEP the lower-cased filter ───────────────────────
  // This is the half that was already correct. Changing it to match app_sessions
  // would strand 23,967 rows of event history.
  assert.match(
    activitySource,
    /"activity_events",[\s\S]{0,220}q\.eq\("hr_id", hrId\)/,
    "activity_events stores the LOWER-CASED HR_ID and must keep using it — the two tables genuinely disagree.",
  );
}
