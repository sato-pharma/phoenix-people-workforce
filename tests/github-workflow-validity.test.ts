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

type ScheduledJob = {
  file: string;
  id: string;
  jobTimeoutMinutes: number | null;
  /** One entry per `continue-on-error: true` step: its own `timeout-minutes`, or null if it has none. */
  legBudgets: (number | null)[];
};

/**
 * Every job of every workflow that has a `schedule:` trigger, with its ceiling and its leg budgets.
 *
 * Indentation is the discriminator, as everywhere else in this file: a job-level key sits at four
 * spaces, a step-level key at eight. Comment lines cannot match either pattern because `#` is the
 * first non-space character — which matters here, since the workflows now carry comments that quote
 * both `continue-on-error` and `timeout-minutes: 10` in prose.
 */
function scheduledJobs(file: string, source: string): ScheduledJob[] {
  if (!/^ {2}schedule:\s*$/m.test(source)) return [];
  const out: ScheduledJob[] = [];
  let inJobs = false;
  let current: ScheduledJob | null = null;
  let legPending = false;
  for (const line of source.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      if (current) out.push(current);
      current = { file, id: job[1], jobTimeoutMinutes: null, legBudgets: [] };
      legPending = false;
      continue;
    }
    if (!current) continue;
    const jobTimeout = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (jobTimeout) {
      current.jobTimeoutMinutes = Number(jobTimeout[1]);
      continue;
    }
    if (/^ {6,}continue-on-error:\s*true\s*$/.test(line)) {
      // A leg whose budget line comes later in the same step; resolved by the next step timeout, or
      // closed as null at the next `- name:`.
      legPending = true;
      continue;
    }
    const stepTimeout = /^ {6,}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (stepTimeout && legPending) {
      current.legBudgets.push(Number(stepTimeout[1]));
      legPending = false;
      continue;
    }
    if (/^ {6}- name:/.test(line) && legPending) {
      current.legBudgets.push(null);
      legPending = false;
    }
  }
  if (current) {
    if (legPending) current.legBudgets.push(null);
    out.push(current);
  }
  return out;
}

/**
 * A scheduled detector must not be able to conclude `cancelled`.
 *
 * 🔴 THE 2026-10-10 AND 2026-10-12 INCIDENT. Every check leg in these workflows carries
 * `continue-on-error: true` so that a FINDING is reported with the job still green — because a
 * failed check suite on `main` HEAD makes Railway withhold that commit's production deploy, for
 * ever, and an alarm that cost a deploy to ring would be the more expensive failure. A CANCELLED
 * suite withholds it in exactly the same way, and the one thing that still produced one was the
 * JOB's own `timeout-minutes`: a timeout is not a step failure, so `continue-on-error` cannot
 * absorb it. migration-drift-check.yml ran 10m07s against a 10-minute ceiling on both of those
 * dates — every leg complete, the finding written, the Telegram alert delivered — and was cancelled
 * at the wall, costing two `main` commits their deploy.
 *
 * The shape that prevents it: each `continue-on-error` leg gets its own `timeout-minutes`, so a
 * slow leg fails the STEP (reported, absorbed) rather than the JOB, and the job's ceiling sits at
 * least SETUP_ALLOWANCE_MINUTES above the sum of those budgets, so the sequential worst case still
 * lands under it. Setup steps are deliberately left unbudgeted and deliberately still fail the job:
 * a hung `pnpm install` measured nothing, and that is BROKEN rather than a finding.
 */
const SETUP_ALLOWANCE_MINUTES = 5;

function assertScheduledDetectorsCannotBeCancelled(files: string[]) {
  const jobs = files.flatMap((file) => scheduledJobs(file, readFileSync(path.join(WORKFLOW_DIR, file), "utf8")));

  // Anti-vacuous floors on both axes. This repo has eight scheduled workflows and well over a dozen
  // continue-on-error legs across them; a parser that stopped matching would otherwise report green
  // while checking nothing, which is the silent-green class every rule in this file is about.
  assert.ok(
    jobs.length > 5,
    `expected to parse more than five jobs across the scheduled workflows, found ${jobs.length} — the scheduled-job parser has stopped matching, so every timeout rule below is checking nothing`,
  );
  const legsSeen = jobs.reduce((n, job) => n + job.legBudgets.length, 0);
  assert.ok(
    legsSeen > 15,
    `expected to parse more than fifteen \`continue-on-error\` legs across the scheduled workflows, found ${legsSeen} — the leg parser has stopped matching`,
  );

  for (const job of jobs) {
    assert.ok(
      job.jobTimeoutMinutes !== null,
      `${job.file}: job \`${job.id}\` declares no \`timeout-minutes\`, so its ceiling is GitHub's default of SIX HOURS. A hung detector holds a runner all night and then concludes \`cancelled\`, which withholds that \`main\` commit's production deploy.`,
    );
    if (job.legBudgets.length === 0) continue;

    const unbudgeted = job.legBudgets.filter((b) => b === null).length;
    assert.equal(
      unbudgeted,
      0,
      `${job.file}: job \`${job.id}\` has ${unbudgeted} \`continue-on-error\` step(s) with no \`timeout-minutes\` of their own. Without a step budget a slow leg runs until the JOB ceiling and concludes \`cancelled\` — which withholds the production deploy and is the one failure \`continue-on-error\` cannot absorb, because a timeout is not a step failure. Give the step its own \`timeout-minutes\`.`,
    );

    // `reduce<number>` explicitly: legBudgets is `(number | null)[]`, so the accumulator would be
    // inferred as `number | null` from the element type and every arithmetic use of it fails
    // TS18047 — which is what the `checks` job caught on this branch's first push.
    const sum = job.legBudgets.reduce<number>((n, b) => n + (b ?? 0), 0);
    assert.ok(
      (job.jobTimeoutMinutes ?? 0) >= sum + SETUP_ALLOWANCE_MINUTES,
      `${job.file}: job \`${job.id}\` budgets ${sum} minute(s) across its \`continue-on-error\` legs but its own ceiling is ${job.jobTimeoutMinutes}. The legs run sequentially, so the job can hit its ceiling before any step hits one of theirs — and the job concludes \`cancelled\`, withholding the production deploy. Raise the job to at least ${sum + SETUP_ALLOWANCE_MINUTES} (the leg budgets plus a ${SETUP_ALLOWANCE_MINUTES}-minute setup allowance) or lower the leg budgets.`,
    );
  }
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
      // A computed `runs-on` with no fallback resolves to empty on any event where its variables are
      // unset, and an empty runs-on is a startup failure rather than a queued job. Since 2026-10-19 every
      // runs-on is a literal `ubuntu-latest` (the per-branch runner switch left with the CI box), so this
      // rule is idle today; a computed one must still carry its `||` fallback, and dropping it
      // is a one-character change with no local symptom.
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

  assertScheduledDetectorsCannotBeCancelled(files);
}
