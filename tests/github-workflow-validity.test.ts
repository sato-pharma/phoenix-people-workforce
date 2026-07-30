import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Static validity checks for the GitHub Actions workflow files.
 *
 * These pin the ONE class of mistake that is invisible locally and near-invisible in the Actions
 * UI: a workflow file GitHub refuses to parse. An invalid file does not produce a failing STEP —
 * it stops the workflow from existing, and GitHub instead emits an instant `failure` run against
 * whatever push it noticed. Anything relying on that workflow then silently never runs.
 *
 * Real incident (2026-07-30): migration-drift-check.yml gated its production leg on
 * `if: ${{ always() && secrets.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY != '' }}`. The `secrets`
 * context is not available to step-level `if:` expressions, so GitHub rejected the whole file with
 * "Unrecognized named-value: 'secrets'". Every push produced a red run for a workflow whose only
 * triggers are `schedule`/`workflow_dispatch`, and the daily production migration-drift check ran
 * zero times between 05:26Z and the fix. A permanently-red drift check detects nothing — the exact
 * silent-green class of bug that workflow exists to catch.
 *
 * Test the secret's PRESENCE in bash inside `run:` instead, passing it via `env:` (where the
 * `secrets` context IS allowed).
 */
const WORKFLOW_DIR = ".github/workflows";

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

export function runGithubWorkflowValidityTests() {
  const files = workflowFiles();
  assert.ok(files.length > 0, "expected at least one workflow file to lint");

  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");

    source.split("\n").forEach((line, index) => {
      // Only `if:` expressions matter. `env:`, `with:` and `jobs.<id>.secrets` may all reference
      // the secrets context legitimately, so this must not be a whole-file grep for "secrets.".
      if (!/^\s*if\s*:/.test(line)) return;
      assert.doesNotMatch(
        line,
        /secrets\./,
        `${file}:${index + 1} uses the \`secrets\` context inside an \`if:\` expression. GitHub rejects the ENTIRE workflow file with "Unrecognized named-value: 'secrets'" — the workflow stops existing rather than failing a step. Pass the secret through \`env:\` and test it with bash inside \`run:\` instead.`,
      );
    });
  }
}
