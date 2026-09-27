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
 *
 * 🔴 SINCE 2026-09-27 THIS CLASS ALSO SILENTLY STOPS PRODUCTION DEPLOYING. #4537 made `main`'s own CI
 * run the production deploy gate (Railway "Wait for CI"), and that gate fails by NOT shipping: a
 * commit whose workflow cannot compile has no verdict to wait for, so Railway holds the deploy and
 * abandons it at the two-hour timeout with nothing turning red anywhere. The same day, 168 runs across
 * every branch and every event came back `startup_failure` — no logs, no jobs, no workflow name, filed
 * under a synthetic `BuildFailed` workflow — and `gh run rerun` refuses them outright. So an invalid
 * workflow file is no longer just a detector that stops detecting; it is a deploy that stops happening.
 * Every rule below is a shape that produces exactly that run and nothing else.
 *
 * Node builtins only, and no YAML parser — the rule tests/ci-gate-parity.test.ts records at its line
 * 125. These are line-shaped checks on purpose: GitHub's rejections are expression-level
 * ("Unrecognized named-value"), which a YAML parse would happily accept.
 */
const WORKFLOW_DIR = ".github/workflows";

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/** Top-level job ids: two-space keys inside the `jobs:` block. */
function jobIds(source: string): string[] {
  const out: string[] = [];
  let inJobs = false;
  for (const line of source.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

export function runGithubWorkflowValidityTests() {
  const files = workflowFiles();
  assert.ok(files.length > 0, "expected at least one workflow file to lint");
  // Anti-vacuous floor: this repo has well over ten workflow files, and a glob that quietly matched
  // nothing would make every assertion below pass while checking no file at all.
  assert.ok(files.length > 10, `expected to lint more than ten workflow files, found ${files.length}`);

  let jobsSeen = 0;
  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    const lines = source.split("\n");
    const ids = jobIds(source);
    jobsSeen += ids.length;

    // ── a workflow with no jobs cannot run, and reports as a failure against the push ──────────
    assert.ok(ids.length > 0, `${file} declares no jobs — GitHub cannot compile it and files the run under BuildFailed.`);

    // ── duplicate job ids: YAML keeps the LAST, so a job silently disappears ───────────────────
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(
      duplicates,
      [],
      `${file} declares the same job id twice (${duplicates.join(", ")}). YAML keeps only the last, so the earlier job — and the check it reports — silently stops existing.`,
    );

    // ── `needs:` must name a job that exists ──────────────────────────────────────────────────
    lines.forEach((line, index) => {
      const needs = /^\s*needs:\s*\[?([^\]#]+)\]?\s*$/.exec(line);
      if (!needs) return;
      for (const raw of needs[1].split(",")) {
        const name = raw.trim().replace(/^['"]|['"]$/g, "");
        if (!name || name.includes("${{")) continue;
        assert.ok(
          ids.includes(name),
          `${file}:${index + 1} needs a job \`${name}\` that this file does not declare. GitHub rejects the whole workflow rather than failing a step. Jobs here: ${ids.join(", ")}.`,
        );
      }
    });

    lines.forEach((line, index) => {
      // ── a literal TAB is invalid YAML, and invisible in most editors ─────────────────────────
      assert.doesNotMatch(
        line,
        /^\s*\t|\t/,
        `${file}:${index + 1} contains a literal TAB. YAML forbids tabs for indentation, so GitHub cannot parse the file at all — and the character is invisible in most editors.`,
      );

      // ── `runs-on:` must resolve to something, on EVERY event ─────────────────────────────────
      // `runs-on: ${{ vars.CI_RUNNER }}` with no fallback resolves to empty on any event where the
      // variable is unset, and an empty runs-on is a startup failure rather than a queued job. The
      // live form is `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`; the `||` is what makes it safe, and
      // dropping it is a one-character change with no local symptom.
      const runsOn = /^\s*runs-on:\s*(.+?)\s*$/.exec(line);
      if (runsOn && runsOn[1].includes("${{")) {
        assert.match(
          runsOn[1],
          /\|\|/,
          `${file}:${index + 1} computes \`runs-on\` from an expression with no \`||\` fallback: ${runsOn[1]}. If it resolves empty — an unset variable, or an \`inputs.\` reference on a non-dispatch event — the run fails at STARTUP with no logs and no jobs, and on \`main\` that now also withholds the production deploy. Write \`\${{ vars.X || 'ubuntu-latest' }}\`.`,
        );
      }

      // Only `if:` expressions matter. `env:`, `with:` and `jobs.<id>.secrets` may all reference
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

  // A second anti-vacuous floor, on the other axis: the job parser must actually be parsing. If
  // `jobIds` ever stops matching — an indentation change, a `jobs:` line with a trailing comment —
  // every per-job rule above would silently check nothing while still reporting green.
  assert.ok(
    jobsSeen > 12,
    `expected to parse more than a dozen jobs across the workflows, found ${jobsSeen} — the job parser has stopped matching, so the duplicate-id, needs: and runs-on rules are checking nothing`,
  );
}
