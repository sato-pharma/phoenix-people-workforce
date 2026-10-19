// EVERY CI JOB RUNS ON A GITHUB-HOSTED RUNNER, AND NO SELF-HOSTED SWITCH EXISTS TO FLIP.
//
// WHY THIS EXISTS. From 2026-09-28 to 2026-10-19 six `runs-on` lines (four in ci.yml, two in
// security-scan.yml) were one computed expression that could put a same-repo pull request on a
// self-hosted runner, gated by two repository variables (`CI_SELF_HOSTED`, `CI_RUNNER_LABEL`). The
// owner retired the Hetzner box that served it on 2026-10-19 — "retire the hetzner box and do not use
// it again, it is the source of slowness" and "make all ci actions to be on github" — and a job whose
// label matches no online runner does not fall back to hosted: it QUEUES for ever with nothing red.
// So the switch is gone rather than defaulted off, and this file pins that it stays gone:
//
//   1. Every `runs-on` in every workflow is the literal `ubuntu-latest`. Not an expression, not a
//      variable, not a label — a literal can never resolve to a machine that is not there.
//   2. Nothing reads `CI_SELF_HOSTED` or `CI_RUNNER_LABEL`, so deleting the two repository variables
//      cannot change a run and re-creating them cannot move one.
//   3. `runner.environment == 'self-hosted'` is not used to key anything either — it only ever
//      distinguished the box, and a branch on it is dead code that reads like a live safeguard.
//
// 🔴 TO PUT CI ON SOMETHING ELSE AGAIN, CHANGE THIS FILE ON PURPOSE, in the same PR, and say who asked.
// Account of the retired design and why it was retired: docs/ci-self-hosted-runner.md.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = ".github/workflows";
const HOSTED = "ubuntu-latest";

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
}

/** A workflow's lines with whole-line comments removed — what the runner reads, not what a header says. */
function live(file: string): { line: number; text: string }[] {
  return readFileSync(path.join(WORKFLOW_DIR, file), "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.replace(/\r$/, "") }))
    .filter(({ text }) => !/^\s*#/.test(text));
}

export function runCiRunnerSwitchTests() {
  let runsOnLines = 0;
  for (const file of workflowFiles()) {
    for (const { line, text } of live(file)) {
      // 1 — every runs-on is the literal hosted label.
      const runsOn = /^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/.exec(text);
      if (runsOn) {
        runsOnLines += 1;
        assert.equal(
          runsOn[1],
          HOSTED,
          `${file}:${line} reads \`runs-on: ${runsOn[1]}\`, not the literal \`${HOSTED}\`. CI is GitHub-hosted only ` +
            `(owner, 2026-10-19). A computed expression or a self-hosted label can resolve to a machine ` +
            `that is not there, and a job with no matching online runner QUEUES for ever with nothing red.`,
        );
      }
      // 2 — nothing reads the retired variables.
      assert.ok(
        !/\b(CI_SELF_HOSTED|CI_RUNNER_LABEL|vars\.CI_RUNNER\b)/.test(text),
        `${file}:${line} reads a retired runner-switch variable: ${text.trim()}. The switch was deleted with the ` +
          `Hetzner box on 2026-10-19; a workflow must not branch on it.`,
      );
      // 3 — and the runtime property that only ever meant "this is the box".
      assert.ok(
        !/runner\.environment\s*==\s*'self-hosted'/.test(text),
        `${file}:${line} branches on \`runner.environment == 'self-hosted'\`: ${text.trim()}. No self-hosted runner ` +
          `exists any more, so that branch is dead code that reads like a live safeguard.`,
      );
    }
  }

  // The scan above must have looked at something, or an empty directory would pass it.
  assert.ok(runsOnLines >= 20, `expected at least 20 \`runs-on\` lines across the workflows, found ${runsOnLines}`);

  // ci.yml's own jobs: each of the six is in the count above, and none was dropped to dodge the check.
  const ciJobs = live("ci.yml").filter(({ text }) => /^ {4}runs-on:/.test(text));
  assert.equal(
    ciJobs.length,
    6,
    `ci.yml should declare 6 jobs (validate, static, unit, checks, mobile, full-e2e) and has ${ciJobs.length} \`runs-on\` ` +
      `lines. If a job was added or removed on purpose, update this number and tests/ci-suite-placement.test.ts together.`,
  );
}
