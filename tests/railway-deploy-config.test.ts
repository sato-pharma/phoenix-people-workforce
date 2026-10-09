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

import { stripComments } from "./support/comment-strip.ts";

const CONFIG = resolve("railway.toml");
const IAC = resolve(".railway/railway.ts");

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

  // 8. 🔴 THE PRODUCTION IMAGE MUST NOT BE PULLED FROM DOCKER HUB. On 2026-10-09 four consecutive
  //    merges — #5711, #5712, #5713, #5714, between 23:43 and 23:58 Cairo — each produced a Railway
  //    build that died on `docker.io/library/node:24-alpine: 429 Too Many Requests`. Railway builds
  //    on shared metal, so the anonymous Hub pull limit is the builder's, not this project's: the
  //    merges were green, the service kept serving the previous revision, and production simply
  //    stopped moving with nothing red anywhere except a build log nobody is watching at midnight.
  //    That is the same failure mode as the 2026-08-13 source drift, reached from the other end.
  //
  //    Asserted on `FROM` lines only, anchored at line start, so the incident write-up in the
  //    Dockerfile's own comment — which necessarily quotes `docker.io/library/node:24-alpine` — can
  //    never satisfy or break this rule.
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const stages = new Set(
    [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map(([, name]) => name.toLowerCase()),
  );
  const external = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)]
    .map(([, image]) => image)
    .filter((image) => !stages.has(image.toLowerCase()));
  assert.ok(
    external.length > 0,
    "🔴 the Dockerfile no longer pulls any external base image, which means this rule is now " +
      "asserting nothing. Re-point it at whatever the image is built from.",
  );
  for (const image of external) {
    assert.ok(
      image.startsWith("public.ecr.aws/docker/library/"),
      `🔴 the production image is built from \`${image}\`, an unmirrored registry reference. A bare ` +
        "`node:24-alpine` resolves to docker.io, whose ANONYMOUS pull limit stopped four deploys " +
        "dead on 2026-10-09 — green merges, a healthy service, and production four commits behind. " +
        "public.ecr.aws/docker/library/* is AWS's copy of the Docker Official Images and never falls " +
        "back to Hub; it is byte-identical, proven by digest across Hub, mirror.gcr.io and ECR on " +
        "that date. Changing this back trades a one-line mirror for a silent deploy outage.",
    );
  }
  assert.ok(
    dockerfile.includes("429 Too Many Requests"),
    "🔴 the Dockerfile lost the note explaining why its base image is mirrored. Without the 429 " +
      "written down, the next reader sees an oddly long registry path and shortens it — which is " +
      "precisely the change this rule exists to stop.",
  );

  // 9-12. WHAT MUST SURVIVE THE CUTOVER TO `.railway/railway.ts`. Railway deprecated Config as Code
  //    and prints so in every build log; existing files keep working until 2026-12-01, and the
  //    authoring file is committed but DELIBERATELY INERT (owner decision 2026-10-01 — see
  //    docs/deployment.md, "Config as Code is deprecated"). The hazard is not the deadline, it is
  //    that the three decisions below live in `railway.toml` today and a cutover can drop all three
  //    WITHOUT FAILING ANYTHING:
  //
  //      - the healthcheck is applied at DEPLOY time and is not stored as a service setting, so
  //        `railway config pull` cannot see it and overwriting the authoring file silently removes
  //        the only readiness gate production has;
  //      - `watchPatterns` are a deliberate absence on this service, and a pull from a project where
  //        someone set one in the dashboard would import it as though it were intended;
  //      - the app's `builder` field reads RAILPACK while the build log shows the Dockerfile, so a
  //        pulled `builder` key would pin the WRONG builder as authored fact.
  //
  //    Asserted on the app's service block with comments stripped by the shared lexer, because this
  //    file's own prose names `watchPatterns` and `builder` and a raw search would match that prose.
  //    `tests/support/comment-strip.ts` exists because the one-line block-comment regex every such
  //    test used to carry deletes real code from 39 files in this repo.
  //
  //    When the cutover finally happens, rules 1-5 above go with `railway.toml` and THESE are what
  //    is left holding the line. They are deliberately not a mirror of the toml: they pin the three
  //    things the owner named as having to survive, and the region, which is the one setting that
  //    puts production on the wrong continent if it is lost.
  const iac = stripComments(readFileSync(IAC, "utf8"));
  const appAt = iac.indexOf('service("phoenix-people-workforce"');
  assert.notEqual(
    appAt,
    -1,
    "🔴 .railway/railway.ts no longer declares a `phoenix-people-workforce` service. That file is " +
      "the prepared cutover away from railway.toml — if the service is gone from it, the cutover " +
      "would delete the service that serves every employee.",
  );
  const nextAt = iac.indexOf('service("', appAt + 1);
  const appBlock = iac.slice(appAt, nextAt === -1 ? undefined : nextAt);
  assert.ok(
    appBlock.includes("env:") && appBlock.length > 500,
    `🔴 the phoenix-people-workforce block read out of .railway/railway.ts is ${appBlock.length} ` +
      "chars and has no `env:` — the slice is wrong, not the file, so every assertion below it " +
      "would pass for the wrong reason. Check the service-declaration order before trusting this.",
  );

  // 9. The readiness gate. This is the one behaviour railway.toml exists for, and the one thing a
  //    `railway config pull` provably cannot see.
  assert.match(
    appBlock,
    /healthcheckPath:\s*"\/api\/readyz"/,
    "🔴 .railway/railway.ts no longer carries the app's healthcheckPath. A pull cannot see it — it " +
      "is applied at deploy time, not stored on the service — so regenerating the file drops it in " +
      "silence, and the cutover would leave production with NO readiness gate: a container that " +
      "boots and throws on its first request would again take 100% of traffic.",
  );
  const iacTimeout = /healthcheckTimeout:\s*(\d+)/.exec(appBlock);
  assert.ok(
    Number(iacTimeout?.[1]) >= 120,
    `🔴 .railway/railway.ts's healthcheckTimeout is ${iacTimeout?.[1] ?? "absent"}. This app ` +
      "preloads 1,148 route entries in production, so a tight window fails deploys that are fine.",
  );
  assert.match(
    appBlock,
    /restartPolicyType:\s*"ON_FAILURE"/,
    "🔴 .railway/railway.ts lost the app's ON_FAILURE restart policy. `railway config migrate` " +
      "silently dropped exactly this field on 2026-10-01, which is why it is asserted separately.",
  );
  assert.match(
    appBlock,
    /restartPolicyMaxRetries:\s*10/,
    "🔴 .railway/railway.ts lost the app's restart retry cap. Without it a genuine configuration " +
      "failure restarts for ever instead of stopping where the log says what broke.",
  );

  // 10. NO watchPatterns, deliberately. Every merge — docs-only included — pays a full production
  //     build, and that is the accepted cost: a watch pattern wrong by one line stops deploying real
  //     code with nothing red to show it. Only `phoenix-headwind` has one, where it IS load-bearing.
  assert.doesNotMatch(
    appBlock,
    /watchPatterns/,
    "🔴 .railway/railway.ts now sets watchPatterns on phoenix-people-workforce. That is a decision " +
      "the owner took the other way: the saving is real, but a pattern wrong by one line stops " +
      "deploying real code and nothing goes red. If this came from a `config pull`, somebody set it " +
      "in the dashboard — fix it there, do not author it here. phoenix-headwind's pattern is " +
      "separate and must stay.",
  );

  // 11. No builder key. The build log is the only thing that settles which builder runs, and it says
  //     Dockerfile while the service's own field says RAILPACK.
  assert.doesNotMatch(
    appBlock,
    /builder:/,
    "🔴 .railway/railway.ts now pins a builder for phoenix-people-workforce. The live service's " +
      "`builder` field reads RAILPACK while the build log reads `load build definition from " +
      "Dockerfile` — authoring the field makes the wrong one of those two a fact, and a RAILPACK " +
      "build of this repo is not the image that serves.",
  );

  // 12. Europe, one replica. `railway service scale <region>=1` ADDS a region rather than moving
  //     one, and a new service is born in `sfo` — so the region is the setting that quietly puts
  //     payroll data on the wrong continent, away from the Frankfurt Supabase project.
  assert.match(
    appBlock,
    /replicas:\s*\{\s*"europe-west4-drams3a":\s*1\s*\}/,
    "🔴 .railway/railway.ts no longer places phoenix-people-workforce as one replica in " +
      "europe-west4-drams3a. Production must stay in Europe, colocated with the Frankfurt Supabase " +
      "project, and two replicas of this app writing one database is not a scale-up.",
  );
}
