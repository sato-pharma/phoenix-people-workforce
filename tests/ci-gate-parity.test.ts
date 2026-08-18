import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * CI <-> package.json gate parity.
 *
 * `ci` is a package.json-only string; `.github/workflows/ci.yml` re-lists the same gate steps
 * separately. The two silently diverge: a `check:*` added to the `ci` script alone NEVER runs on a
 * PR (it needs BOTH edits). This test pins it: every `check:*` step the gate runs must also appear
 * in at least one workflow file.
 *
 * There used to be a second assertion here, that `ci` and `check:harden` were byte-identical. That
 * mattered while `check:harden` was the local pre-push gate and a green local run was supposed to
 * predict a green PR. `check:harden` was retired on 2026-08-18 — the workflow is the only gate now,
 * so there is no second string left to keep in lockstep, and `ci` is kept purely as the one-shot
 * way to run the whole thing by hand.
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

  // Retired, and pinned so it does not quietly come back as a second gate to keep in sync.
  assert.equal(
    pkg.scripts?.["check:harden"],
    undefined,
    "`check:harden` was retired on 2026-08-18 — the CI workflow is the gate. Reintroducing it " +
      "recreates the divergence trap this test exists to catch.",
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
    `these check:* steps run in the package.json \`ci\` gate but appear in NO ` +
      `${WORKFLOW_DIR}/*.yml file, so they NEVER run on a PR: [${missing.join(", ")}]. ` +
      `Add each to a workflow — the workflow is the only thing that actually gates a merge.`,
  );
}
