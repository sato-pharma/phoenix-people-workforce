import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { hrIdLookupKeys } from "@/lib/hr-id";

const activitySource = readFileSync(
  new URL("../src/lib/activity/service.ts", import.meta.url),
  "utf8",
);

const errorMonitorSource = readFileSync(
  new URL("../src/lib/error-monitor/service.ts", import.meta.url),
  "utf8",
);

/** The body of one top-level `export async function`, up to its closing brace in column 1. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `could not find "${signature}" — this test is reading the wrong file`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  assert.notEqual(end, -1, `could not find the end of "${signature}"`);
  return rest.slice(0, end + 2);
}

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
 * The trap this test also guards: `activity_events` does NOT store one spelling.
 * Measured on production 2026-09-26: 51,024 rows are lower-cased across 56
 * people, and 11,934 are spelled `B-10` — the owner's own history, written
 * between 29 June and 19 August 2026. An `.eq` on either spelling is therefore
 * wrong for somebody, and a reader that picks the lower-cased one shows the
 * owner an empty timeline of his own work for any window reaching back that far.
 * (An earlier version of this file asserted the opposite, on a 23,967-row
 * measurement taken before the mixed block existed, and pinned the `.eq` in
 * place as though it were the correct behaviour.)
 *
 * Both tables are therefore read with `hrIdLookupKeys` — every accepted
 * spelling — and neither is repaired by an UPDATE: the mis-spelled block is
 * frozen, the write path lower-cases, and the 90-day purge removes the last of
 * it around 17 November 2026. A casing-repair UPDATE is the class of write that
 * left ~37,000 bad actor ids across 52 columns.
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
  const forceLogoutBody = functionBody(activitySource, "export async function forceLogoutUser");

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

  // ── activity_events must be read by EVERY spelling, in both readers ────────
  // The table holds both: 51,024 lower-cased rows and 11,934 spelled `B-10`.
  // Each reader is checked inside its OWN body, so a correct filter somewhere
  // else in the file can never vouch for a broken one here.
  const timelineBody = functionBody(activitySource, "export async function getUserTimeline");

  assert.match(
    timelineBody,
    // Lazy, and anchored on EVENT_FETCH_CAP, so this can only be the event read
    // itself — never the login-calendar read further down, which is correct for
    // its own reasons and must not vouch for this one.
    /"activity_events",[\s\S]{0,1500}?q\.in\("hr_id", hrIdLookupKeys\(targetHrId\)\)[\s\S]{0,300}?EVENT_FETCH_CAP/,
    "getUserTimeline must read activity_events by every accepted HR_ID spelling — activity_events holds both, and the lower-cased .eq hid 11,934 of the owner's own rows from his own timeline.",
  );

  assert.doesNotMatch(
    timelineBody,
    /\.eq\("hr_id", hrId\)/,
    "getUserTimeline must never go back to the lower-cased .eq on activity_events — that filter silently drops every row written in the mixed-case block.",
  );

  // The RAW id is what goes in, not the normalized one: `hrIdLookupKeys` derives
  // the display spelling from what it is given, so handing it the lower-cased
  // key throws away the very spelling it is there to recover.
  assert.doesNotMatch(
    timelineBody,
    /hrIdLookupKeys\(hrId\)/,
    "getUserTimeline must pass the RAW target id to hrIdLookupKeys, not the lower-cased key.",
  );

  // ── The error monitor's repro trail had the identical mismatch ─────────────
  const reproTrailBody = functionBody(errorMonitorSource, "export async function getReproTrail");

  assert.match(
    reproTrailBody,
    /"activity_events"[\s\S]{0,1500}?\.in\("hr_id", hrIdLookupKeys\(hrId\)\)/,
    "getReproTrail must read activity_events by every accepted HR_ID spelling, or the trail behind an error reported by the owner comes back empty.",
  );

  assert.doesNotMatch(
    reproTrailBody,
    /\.eq\("hr_id",/,
    "getReproTrail must never filter activity_events with a single spelling again.",
  );
}
