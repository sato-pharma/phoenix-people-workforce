import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the weekly-digest settlement API routes
 * (app/api/attendance/digests/**, app/api/attendance/disputes/**). Matches
 * the established pattern for this module: these routes hit Supabase and
 * cannot be unit-tested without DB infra, so the exact wiring that enforces
 * self-scope, reviewer authorization, and CSRF is pinned via source
 * inspection instead.
 */
export function runAttendanceDigestRoutesTests() {
  // 1. An employee can only ever see/act on THEIR OWN digests — every route
  //    must derive the employee identity from the session (access.hrId), and
  //    never accept a client-supplied hrId that could target someone else's
  //    digest (the same substring/cross-employee leak class this module has
  //    dedicated regression tests for elsewhere — see attendance-self-scope).
  const listRoute = readFileSync("app/api/attendance/digests/route.ts", "utf8");
  assert.match(listRoute, /listMyDigests\(access\.hrId\)/, "digest list must be scoped to the session's own hrId");

  const detailRoute = readFileSync("app/api/attendance/digests/[id]/route.ts", "utf8");
  assert.match(
    detailRoute,
    /getDigestDetailForEmployee\(id, access\.hrId\)/,
    "digest detail must be scoped to the session's own hrId, not a request param",
  );

  const confirmRoute = readFileSync("app/api/attendance/digests/[id]/confirm/route.ts", "utf8");
  assert.match(
    confirmRoute,
    /confirmDigestLines\(\{ actorHrId: access\.hrId,/,
    "confirm must use the session's own hrId as actor, never a client-supplied one",
  );

  const disputeRoute = readFileSync("app/api/attendance/digests/[id]/dispute/route.ts", "utf8");
  assert.match(
    disputeRoute,
    /actorHrId: access\.hrId,/,
    "dispute submission must use the session's own hrId as actor, never a client-supplied one",
  );

  // 2. Dispute review is gated by the DATA-DRIVEN reviewer list
  //    (attendance_digest_settings.approver_hr_ids), not a generic role check
  //    — both the inbox and the decision route must call it.
  const disputesInbox = readFileSync("app/api/attendance/disputes/route.ts", "utf8");
  assert.match(
    disputesInbox,
    /isAuthorizedDisputeReviewer\(access\.hrId, access\.role === "Super Admin"\)/,
    "the dispute inbox must gate on the resolved reviewer list, not a role check alone",
  );
  const reviewRoute = readFileSync("app/api/attendance/disputes/[lineId]/review/route.ts", "utf8");
  assert.match(
    reviewRoute,
    /isAuthorizedDisputeReviewer\(access\.hrId, access\.role === "Super Admin"\)/,
    "the review decision route must gate on the resolved reviewer list before calling reviewDigestDispute",
  );
  assert.match(
    reviewRoute,
    /reviewerHrId: access\.hrId,/,
    "the reviewer identity passed to the service must be the session's own hrId, never a client-supplied one",
  );

  // 3. Every mutation route requires the CSRF same-origin check.
  for (const [name, source] of [
    ["confirm", confirmRoute],
    ["dispute", disputeRoute],
    ["review", reviewRoute],
  ] as const) {
    assert.match(source, /assertSameOriginMutation\(request\)/, `${name} route must call assertSameOriginMutation`);
  }

  // 4. All six routes must be registered in the access registry (the broader
  //    access-registry-coverage test already enforces this repo-wide, but
  //    pinning the specific patterns here catches a typo'd pattern that would
  //    otherwise silently register the WRONG route).
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const pattern of [
    "/api/attendance/digests",
    "/api/attendance/digests/:id",
    "/api/attendance/digests/:id/confirm",
    "/api/attendance/digests/:id/dispute",
    "/api/attendance/disputes",
    "/api/attendance/disputes/:lineId/review",
  ]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `access registry must contain an entry for ${pattern}`);
  }
}
