// The production deploy config must stay in git, and it must keep a real readiness gate.
//
// WHY THIS EXISTS. Until 2026-09-30 there was no `railway.toml` at all, and every deploy setting for
// `phoenix-people-workforce` lived only in the Railway dashboard. Two things followed from that, both
// measured on that date:
//
//   1. NO service in the project had a healthcheck — none, in either environment, and no HEALTHCHECK
//      in either Dockerfile. A container that booted and then threw on its first request took 100% of
//      traffic, and Railway had nothing to fail it on. A deploy with a wrong service-role key would
//      serve errors to every employee while /api/healthz answered {"status":"ok"} and every check in
//      this repo stayed green.
//   2. A dashboard-only setting drifts in silence. That is the 2026-08-13 incident behind
//      deploy-drift-check.yml: production's source pointed at a stale branch and five merged, green
//      pull requests were stranded for hours with nothing red anywhere.
//
// So this file asserts the two things that would quietly undo the fix: the healthcheck pointing at a
// probe that can actually FAIL, and the record of which settings this file cannot express.
//
// Each invariant is asserted SEPARATELY with its own message. A single combined regex would make
// every clause after the first unreachable — the defect that hid a dead assertion in
// tests/next-build-cpu-cap.test.ts on 2026-09-27.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG = resolve("railway.toml");

export function runRailwayDeployConfigTests() {
  const source = readFileSync(CONFIG, "utf8");

  // 1. The healthcheck must point at /api/readyz, NOT /api/healthz. This is the whole point of the
  //    file. `healthz` returns the literal string "ok" with no branch in the code, so as a deploy
  //    gate it proves only that a Node process is listening — it is blind to a wrong service-role
  //    key, an unreachable Supabase and a missing environment variable, which are the failures that
  //    have actually happened here. `readyz` answers 503 for all three.
  assert.match(
    source,
    /^healthcheckPath\s*=\s*"\/api\/readyz"\s*$/m,
    "🔴 railway.toml no longer health-gates deploys on /api/readyz. If this was changed to " +
      "/api/healthz, the gate is now cosmetic: healthz cannot return anything but ok, so a deploy " +
      "with a broken database or a wrong key would again take full production traffic.",
  );

  // 2. A healthcheck with no timeout, or a tight one, fails GOOD deploys: this app preloads 1,148
  //    route entries at start in production, so a cold container is slow to first response for
  //    reasons unrelated to health. The probe's own dependency calls are bounded far below this.
  const timeout = /^healthcheckTimeout\s*=\s*(\d+)\s*$/m.exec(source);
  assert.notEqual(
    timeout,
    null,
    "🔴 railway.toml lost `healthcheckTimeout`. Without a generous window a cold start — this app " +
      "preloads 1,148 route entries in production — reads as an unhealthy deploy.",
  );
  assert.ok(
    Number(timeout?.[1]) >= 120,
    `🔴 healthcheckTimeout is ${timeout?.[1]}s, which is too tight for this app's cold start. ` +
      "A deploy that is actually fine would be failed and rolled back.",
  );

  // 3. One replica. Recorded here because the way to break it is a single command:
  //    `railway service scale <region>=1` ADDS a replica rather than moving the existing one, and it
  //    has already produced two live copies of a server writing one database.
  assert.match(
    source,
    /^numReplicas\s*=\s*1\s*$/m,
    "🔴 railway.toml no longer pins numReplicas = 1. Two replicas of this app is not a scale-up — " +
      "check whether a `railway service scale` command ADDED a region instead of moving one.",
  );

  // 4. ON_FAILURE, not ALWAYS. ALWAYS hides a genuine configuration failure behind an endless
  //    restart loop, which is the reasoning already written down for the Headwind service.
  assert.match(
    source,
    /^restartPolicyType\s*=\s*"ON_FAILURE"\s*$/m,
    "🔴 railway.toml's restart policy is no longer ON_FAILURE. ALWAYS would restart a container " +
      "forever through a real configuration failure, hiding the one log line that says what broke.",
  );

  // 5. The settings this file CANNOT express have each cost something, and the only thing stopping
  //    the next session assuming they are covered is that they are named here. The region line is
  //    the load-bearing one: the workspace's own preferred region is `sfo`, so a new service is born
  //    on the wrong continent unless someone sets it.
  for (const [needle, why] of [
    ["europe-west4-drams3a", "the region, which must stay in Europe and is not settable from this file"],
    ["Source branch", "the source branch, which has silently drifted before and stranded five green PRs"],
    ["watchPatterns", "the deliberate absence of watch patterns, so it reads as a decision not an oversight"],
  ] as const) {
    assert.ok(
      source.includes(needle),
      `🔴 railway.toml no longer records ${why}. That note is the only thing telling the next ` +
        "reader which deploy settings are still dashboard-only, and a setting nobody knows is " +
        "unmanaged is exactly how 2026-08-13 happened.",
    );
  }

  // 6. The probe this file depends on must still be able to answer not-ready. If readyz stops
  //    returning 503, the healthcheck above silently becomes as toothless as healthz — the same
  //    outcome as changing the path, reached from the other end.
  const readyz = readFileSync(resolve("app/api/readyz/route.ts"), "utf8");
  assert.match(
    readyz,
    /503/,
    "🔴 /api/readyz no longer returns 503. Railway's healthcheck reads a status code, so a probe " +
      "that always answers 200 gates nothing — and railway.toml would be asserting a protection " +
      "that no longer exists.",
  );

  // 7. Every dependency call in the probe must be bounded. The registry audit originally had NO cap:
  //    it inherited the admin client's 15s default AND that client's 3-attempt retry with backoff, so
  //    a worst case ran well past a minute. A probe that can outlast the platform's healthcheck
  //    window fails the deploy for a reason that has nothing to do with the deploy.
  assert.match(
    readyz,
    /withDeadline\(/,
    "🔴 /api/readyz no longer bounds the workflow-registry audit with withDeadline(). Unbounded, it " +
      "inherits a 15s per-request timeout multiplied by 3 retries, and a slow-but-healthy deploy " +
      "then fails its own healthcheck.",
  );
}
