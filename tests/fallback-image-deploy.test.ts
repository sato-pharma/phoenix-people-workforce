import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BUILD_VALUE_NAMES,
  ENVIRONMENTS,
  GIT_SOURCE,
  IMAGE_REPO,
  REHEARSAL_PREFIX,
  REPO,
  REQUIRED_BUILD_VALUES,
  SERVICES,
  assertProductionOnly,
  classifyStatus,
  imageRef,
  isFullSha,
  parseArgs,
  parseServices,
  redact,
  renderBuildValues,
  revisionMatches,
  shellQuote,
  switchInput,
} from "../scripts/fallback-image-deploy.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A YAML workflow or Dockerfile without its full-line comments. Deliberately NOT the quote-aware stripper: a workflow is YAML
 * wrapping shell, and one stray apostrophe in prose leaves that state machine reading the rest of the file as a string, so
 * a "must not appear" pin would match the comment that explains it.
 */
const withoutFullLineComments = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * The fallback route: an image built on GitHub for the day Railway cannot build (owner, 2026-10-21;
 * docs/deployment.md, "The fallback route").
 *
 * Five properties carry the design, and each would fail SILENTLY if lost:
 *
 *   1. The build values the image bakes are exactly the Dockerfile's NEXT_PUBLIC_* ARGs. An ARG added to the Dockerfile
 *      and not here ships an EMPTY value to every browser with no build error.
 *   2. The image carries RAILWAY_GIT_COMMIT_SHA. Railway injects it only into a build it ran itself; without it the
 *      release gate reads "no commit" and OPENS, so an unchecked image could take traffic.
 *   3. The commit must already have a green `release-gate` job in its own ci.yml push run.
 *   4. switch / restore refuse staging: the source is service-level, so a "staging" change is a production change.
 *   5. The workflow never runs on a push to main (it would attach a check suite to main HEAD) and is never cancelled
 *      half way (a service left on a source nobody chose).
 */
export function runFallbackImageDeployTests(): void {
  const workflow = withoutFullLineComments(readFileSync(".github/workflows/fallback-image.yml", "utf8"));
  const script = stripComments(readFileSync("scripts/fallback-image-deploy.mjs", "utf8"));
  const dockerfile = withoutFullLineComments(readFileSync("Dockerfile", "utf8"));

  // ── 1. The baked values are the Dockerfile's NEXT_PUBLIC_* ARGs, no more and no fewer ─────────────────────────
  {
    const declared = [...dockerfile.matchAll(/^ARG (NEXT_PUBLIC_[A-Z0-9_]+)\s*$/gm)].map((m) => m[1]).sort();
    assert.ok(declared.length >= 8, `expected the Dockerfile to declare its NEXT_PUBLIC_* ARGs, found ${declared.length}`);
    assert.deepEqual([...BUILD_VALUE_NAMES].sort(), declared, "BUILD_VALUE_NAMES must equal the Dockerfile's NEXT_PUBLIC_* ARG list");
    for (const name of REQUIRED_BUILD_VALUES) assert.ok(BUILD_VALUE_NAMES.includes(name), `${name} is required and must be a build value`);

    const rendered = renderBuildValues({ NEXT_PUBLIC_APP_URL: "  https://phoenix.example ", NEXT_PUBLIC_SENTRY_DSN: "" });
    assert.match(rendered.text, /^NEXT_PUBLIC_APP_URL='https:\/\/phoenix\.example'\n$/, "values are trimmed (a leading space has been seen) and single-quoted");
    assert.ok(rendered.missing.includes("NEXT_PUBLIC_SENTRY_DSN"), "an empty value is reported as unset, never written empty");
    assert.equal(rendered.present, 1);
    assert.equal(shellQuote("a'b"), `'a'\\''b'`, "an embedded single quote is closed, escaped and reopened");
  }

  // ── 2. The image is stamped with its commit, from the commit-resolving step, before it is tested or pushed ─────
  {
    assert.match(
      workflow,
      /printf 'FROM %s:build\\nENV RAILWAY_GIT_COMMIT_SHA=%s\\n' "\$\{IMAGE\}" "\$\{SHA\}" \| docker build --tag "\$\{IMAGE\}:\$\{SHA\}" -/,
      "the pushed tag is a layer that sets RAILWAY_GIT_COMMIT_SHA to the commit",
    );
    assert.ok(workflow.indexOf("Stamp the commit into the image") < workflow.indexOf("Boot the image"), "the stamp comes before the boot test");
    assert.ok(workflow.indexOf("Boot the image") < workflow.indexOf("docker push"), "the image is boot-tested before it is pushed");
    assert.match(workflow, /\*"\\"revision\\":\\"\$\{SHA\}\\""\*\)/, "the boot test reads the commit back from /api/healthz");
    // The first run (2026-10-21) died on AWS's public registry, "429 toomanyrequests: Data limit exceeded", before a single
    // layer: a runner shares its address with thousands of others. The Dockerfile's FROM stays as it is (railway-deploy-config
    // pins it), so the base is fetched from whichever mirror answers and tagged with the exact name the FROM line asks for.
    assert.match(workflow, /BASE="\$\(grep -m1 '\^FROM ' Dockerfile \| awk '\{print \$2\}'\)"/, "the base name is read from the Dockerfile, never copied here");
    assert.match(workflow, /"mirror\.gcr\.io\/\$\{TAG\}"/, "a second mirror is tried when the first refuses");
    assert.match(workflow, /docker tag "\$\{pulled\}" "\$\{BASE\}"/, "a mirror's copy is tagged with the Dockerfile's own name");
    assert.ok(workflow.indexOf("Pull the base image, with fallbacks") < workflow.indexOf("Build the image (the repository's own Dockerfile"), "the base is fetched before the build");
    assert.ok(!/^\s*FROM\s+(mirror\.gcr\.io|docker\.io)/m.test(dockerfile), "the Dockerfile itself keeps the AWS mirror");
    // The first dispatch (2026-10-21) built main HEAD and died with "Cannot find module .../fallback-image-deploy.mjs": the image
    // job ran the script from the checkout of the commit it was BUILDING, and main does not contain it until this merges (and an
    // older commit never does). The tools come from the commit the workflow runs from, copied out before the second checkout.
    const imageJob = workflow.slice(workflow.indexOf("\n  image:"), workflow.indexOf("\n  rehearsal:"));
    assert.ok(imageJob.length > 500, "the image job was found");
    assert.match(imageJob, /cp scripts\/fallback-image-deploy\.mjs "\$\{RUNNER_TEMP\}\/fallback-tools\/fallback-image-deploy\.mjs"/, "the script is copied out of the tools checkout");
    assert.match(imageJob, /cp scripts\/lib\/refuse-arguments\.mjs "\$\{RUNNER_TEMP\}\/fallback-tools\/lib\/refuse-arguments\.mjs"/, "and so is the one helper it imports, beside it as in the repository");
    assert.match(script, /from "\.\/lib\/refuse-arguments\.mjs"/, "the helper the workflow copies is the one the script imports");
    // The owner is read from the one place the scripts keep it, so that file travels with the copy too.
    assert.match(script, /from "\.\/required-check-names\.mjs"/);
    assert.match(imageJob, /cp scripts\/required-check-names\.mjs "\$\{RUNNER_TEMP\}\/fallback-tools\/required-check-names\.mjs"/, "🔴 the copied script would fail to import its owner");
    // A refused credential names its own kind and reach, so "Not Authorized" is never left to be guessed at.
    assert.match(script, /throw new Error\(`\$\{last\.message\} \(\$\{await diagnoseCredential\(\)\}\)`\)/, "a refusal from every header kind carries the credential check");
    assert.match(script, /\{ projectToken \{ projectId environmentId \} \}/, "the check asks which environment a project token is scoped to");
    assert.ok(!/node scripts\/fallback-image-deploy\.mjs/.test(imageJob), "the image job never runs the script from the tree it is building");
    assert.ok(
      imageJob.indexOf("Check out the tools") < imageJob.indexOf("Keep the script outside") && imageJob.indexOf("Keep the script outside") < imageJob.indexOf("Check out the commit to build"),
      "tools, then copy, then the build checkout",
    );
    assert.ok(!/--out build-values\.env|\. \.\/build-values\.env/.test(imageJob), "the generated values file stays out of the Docker build context");
    assert.ok(!/SENTRY_AUTH_TOKEN/.test(workflow), "a fallback build must not depend on, or spend, the source-map upload credential");
    assert.ok(!/--no-verify|continue-on-error: true/.test(workflow), "nothing in the fallback may be made optional");
  }

  // ── 3. The commit must already have passed main's own release gate ─────────────────────────────────────────────
  {
    assert.match(workflow, /select\(\.path == "\.github\/workflows\/ci\.yml"\)/, "it asks about ci.yml's run");
    assert.match(workflow, /event=push/, "it asks about the PUSH run, the only one with a release-gate job that can succeed");
    assert.match(workflow, /select\(\.name == "release-gate"\)/, "it reads the release-gate job");
    assert.match(workflow, /\[ "\$verdict" != "success" \]/, "anything but success refuses");
    // The two required checks are NOT named here: branch protection has rotated five times; the release-gate job's
    // `needs: [validate, checks]` is the single place the pair lives.
    assert.ok(!/\bvalidate\b|\bchecks\b/.test(workflow.replace(/hash|"checks"/g, "")), "the required-check names are not copied into this workflow");
  }

  // ── 4. switch / restore refuse staging; the rehearsal deletes only what it created ────────────────────────────
  {
    assert.throws(() => assertProductionOnly("staging", "switch"), /service-level/);
    assert.throws(() => assertProductionOnly("staging", "restore"), /PRODUCTION/);
    assert.doesNotThrow(() => assertProductionOnly("production", "switch"));
    assert.match(script, /assertProductionOnly\(env, "switch"\)/);
    assert.match(script, /assertProductionOnly\(env, "restore"\)/);
    assert.match(script, /again\?\.name === name/, "the rehearsal re-reads the service's name before it deletes");
    assert.ok(REHEARSAL_PREFIX.startsWith("fallback-rehearsal"));
    assert.match(script, /startsWith\(REHEARSAL_PREFIX\)/, "cleanup deletes only rehearsal services");
    assert.notEqual(ENVIRONMENTS.production, ENVIRONMENTS.staging);
    assert.equal(SERVICES.web.name, "phoenix-people-workforce");
    assert.equal(SERVICES.worker.name, "phoenix-workforce-worker");
    assert.deepEqual(GIT_SOURCE, { repo: REPO, branch: "main" }, "restore reconnects the repository's main");
    assert.match(script, /await assertServiceNames\(services\)/, "a stale service id fails loudly before anything changes");
  }

  // ── 5. When the workflow runs ──────────────────────────────────────────────────────────────────────────────────
  {
    const on = /^on:\n([\s\S]*?)^\S/m.exec(workflow)?.[1] ?? "";
    const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    // workflow_call since 2026-10-21: the emergency host (emergency-host.yml, itself by hand only) builds its image here.
    assert.deepEqual(
      triggers,
      ["pull_request", "workflow_call", "workflow_dispatch"],
      "by hand, called by the hand-started emergency host, or a PR that touches the fallback itself — never a push to main, never a schedule",
    );
    assert.match(workflow, /cancel-in-progress: false/, "a switch is never cancelled half way");
    assert.ok(!/cancel-in-progress: true/.test(workflow));
    assert.match(workflow, /PUSH: \$\{\{ github\.event_name != 'pull_request' \}\}/, "a pull request builds and boots the image but pushes nothing");
    assert.match(workflow, /if: \$\{\{ env\.PUSH == 'true' \}\}\n\s+run: \|\n\s+set -euo pipefail\n\s+echo "\$\{GH_TOKEN\}" \| docker login ghcr\.io/, "only the push step logs in to the registry");
    assert.match(workflow, /switch --env production --sha "\$\{SHA\}"/);
    assert.match(workflow, /restore --env production --services web,worker/);
    assert.ok(!/secrets\./.test(workflow.split("\n").filter((l) => /^\s*if:/.test(l)).join("\n")), "no secrets context inside an if:");
    assert.equal(IMAGE_REPO, IMAGE_REPO.toLowerCase(), "a registry path is lower-case");
    assert.ok(workflow.includes('IMAGE="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/phoenix-people-workforce"'), "the workflow builds the same path the script pulls");
  }

  // ── 6. The pure helpers ────────────────────────────────────────────────────────────────────────────────────────
  {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.ok(isFullSha(sha));
    assert.ok(!isFullSha(sha.slice(0, 39)) && !isFullSha(sha.toUpperCase()) && !isFullSha(""));
    assert.equal(imageRef(sha), `${IMAGE_REPO}:${sha}`);
    assert.throws(() => imageRef("main"), /full 40-character/);

    assert.deepEqual(switchInput({ sha, username: "owner", password: "tok-123" }), {
      source: { image: `${IMAGE_REPO}:${sha}` },
      registryCredentials: { username: "owner", password: "tok-123" },
    });
    assert.throws(() => switchInput({ sha, username: "owner", password: "" }), /private image/);

    for (const [status, verdict] of [
      ["SUCCESS", "live"],
      ["FAILED", "failed"],
      ["CRASHED", "failed"],
      ["REMOVED", "failed"],
      ["SKIPPED", "failed"],
      ["BUILDING", "pending"],
      ["DEPLOYING", "pending"],
      ["INITIALIZING", "pending"],
      [undefined, "pending"],
    ] as const) {
      assert.equal(classifyStatus(status), verdict, `${status}`);
    }

    assert.deepEqual(parseServices("worker,web"), ["web", "worker"], "web always goes first");
    assert.deepEqual(parseServices(undefined), ["web"]);
    assert.throws(() => parseServices("web,cron"), /Unknown service/);

    assert.equal(redact("Bearer abcd1234 and abcd1234", ["abcd1234", undefined, "ab"]), "Bearer *** and ***", "a secret is scrubbed everywhere; a too-short one is ignored");
    assert.ok(revisionMatches(sha, sha) && !revisionMatches(null, sha) && !revisionMatches("f".repeat(40), sha));

    const parsed = parseArgs(["switch", "--sha", sha, "--services", "web,worker", "--from-env"]);
    assert.equal(parsed.command, "switch");
    assert.equal(parsed.flags.get("sha"), sha);
    assert.equal(parsed.flags.get("from-env"), "true");
    assert.throws(() => parseArgs(["switch", "stray"]), /Unexpected argument/);
  }
}
