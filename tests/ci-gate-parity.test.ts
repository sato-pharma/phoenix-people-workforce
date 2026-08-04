import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * CI <-> package.json gate parity.
 *
 * `check:harden` / `ci` are package.json-only strings; `.github/workflows/ci.yml` re-lists the same
 * gate steps separately. The two silently diverge: a `check:*` added to the `ci` script alone NEVER
 * runs on a PR (it needs BOTH edits) — the documented `ci-does-not-run-check-harden` trap. This test
 * pins it: every `check:*` step the gate runs must also appear in at least one workflow file.
 *
 * Scope is deliberately the `check:*` steps only. lint / typecheck / test / build have their own CI
 * jobs invoked in varied ways (e.g. the runner runs as its own process, not `pnpm run test`), so a
 * strict `pnpm run <step>` match there would false-positive.
 */
const WORKFLOW_DIR = ".github/workflows";

export function runCiGateParityTests() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const ciScript = pkg.scripts?.ci ?? "";
  assert.ok(ciScript.length > 0, "package.json must define a `ci` script");

  // `ci` and `check:harden` must stay identical (they are the same gate; the PR gate is `ci`).
  const harden = pkg.scripts?.["check:harden"] ?? "";
  assert.equal(
    harden,
    ciScript,
    "`check:harden` and `ci` must be the identical gate string, or a local `check:harden` pass no " +
      "longer means the PR gate (`ci`) will pass. Keep them in lockstep.",
  );

  const gateChecks = Array.from(new Set(ciScript.match(/\bcheck:[a-z0-9-]+/gi) ?? [])).sort();
  assert.ok(gateChecks.length > 0, "expected the `ci` script to run at least one check:* step");

  const workflowText = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(path.join(WORKFLOW_DIR, name), "utf8"))
    .join("\n");

  const missing = gateChecks.filter((check) => !workflowText.includes(check));
  assert.deepEqual(
    missing,
    [],
    `these check:* steps run in the package.json \`ci\`/\`check:harden\` gate but appear in NO ` +
      `${WORKFLOW_DIR}/*.yml file, so they NEVER run on a PR: [${missing.join(", ")}]. ` +
      `Add each to a workflow — this is the CI-vs-check:harden divergence trap.`,
  );
}
