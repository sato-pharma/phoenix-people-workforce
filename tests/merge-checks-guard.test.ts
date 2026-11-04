// bash-guard C21 — a `gh pr merge` of a PR whose checks are red, still running or not reported on its
// head commit must be REFUSED, and a green one must go straight through.
//
// WHY THIS EXISTS (2026-11-04). The repository moved to a personal account on the free plan, where a
// private repository's `branches/main/protection` answers 403: GitHub stopped refusing a merge on red,
// and nothing in the hook refused it either. Measured that day against the live API: PR 18 red on
// `checks`, PR 20 with `validate` still running — both were mergeable with one command.
//
// Three layers, each of which a regression would have to get past:
//   1. the verdict itself (scripts/merge-checks-verdict.mjs), driven directly;
//   2. the REAL hook as a subprocess, with a `gh` shim on PATH answering the reads it makes — so the
//      PR-number parsing, the repo read, the AGENTS.md fallback and the refusal text are all exercised;
//   3. the declaration the fallback reads — AGENTS.md §2 must still name a pair the hook can use.
// `tests/required-check-names.test.ts` already holds that declaration against ci.yml's jobs, so the
// fallback can never name a check ci.yml does not run.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describeVerdict, mergeChecksVerdict } from "../scripts/merge-checks-verdict.mjs";
import { declaredRequiredChecks, REPO } from "../scripts/required-check-names.mjs";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Decision = { decision: "allow" | "deny"; reason: string };
type Run = { id?: number; name: string; status: string; conclusion: string | null; app?: { slug: string } };

const run = (name: string, status: string, conclusion: string | null, id = 1, app = "github-actions"): Run => ({
  id,
  name,
  status,
  conclusion,
  app: { slug: app },
});

/**
 * A `gh` on PATH that answers by the first keyword its arguments contain, from a JSON table beside
 * it; `null` (or no match) exits 1, which is what a 403 or an unreachable API looks like to the hook.
 * One node script behind an sh and a cmd launcher, so the table is the same on every platform.
 */
function ghShim(dir: string, answers: Array<[string, string | null]>): string {
  const binDir = mkdtempSync(join(dir, "bin-"));
  writeFileSync(join(binDir, "answers.json"), JSON.stringify(answers), "utf8");
  writeFileSync(
    join(binDir, "gh.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "answers.json"), "utf8"));',
      'const args = process.argv.slice(2).join(" ");',
      "const hit = table.find(([key]) => args.includes(key));",
      "if (!hit || hit[1] === null) process.exit(1);",
      "process.stdout.write(hit[1]);",
    ].join("\n"),
    "utf8",
  );
  const sh = join(binDir, "gh");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "$(dirname "$0")/gh.mjs" "$@"\n`, "utf8");
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows has no execute bit; the .cmd below is what runs there */
  }
  writeFileSync(join(binDir, "gh.cmd"), `@"${process.execPath}" "%~dp0gh.mjs" %*\r\n`, "utf8");
  return binDir;
}

/** The reads C21 makes, answered for a Phoenix PR whose protection answers 403. */
function phoenixAnswers(runs: Run[], statuses: unknown[] = []): Array<[string, string | null]> {
  return [
    ["nameWithOwner", REPO],
    ["required_status_checks", null],
    ["headRefOid,baseRefName", JSON.stringify({ headRefOid: SHA, baseRefName: "main" })],
    ["check-runs", JSON.stringify(runs)],
    [`commits/${SHA}/status`, JSON.stringify(statuses)],
  ];
}

function runGuard(cwd: string, command: string, ghDir: string | null, tool = "Bash"): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_MERGE_OK;
  delete env.PHX_RED_MERGE_OK;
  // C10 and C13 come after C21 and ask their own questions; a large file count keeps C10 quiet so
  // every answer below is C21's.
  env.PHX_MERGE_MIN_FILES = "0";
  if (ghDir) env.PATH = ghDir + delimiter + (env.PATH ?? "");
  else env.PATH = mkdtempSync(join(cwd, "empty-")) + delimiter + (env.PATH ?? "");
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  const start = raw.indexOf('{"hookSpecificOutput"');
  if (start < 0) return { decision: "allow", reason: "" };
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

function verdictCases(): void {
  const pair = ["validate", "checks"];
  const green = [run("validate", "completed", "success"), run("checks", "completed", "success")];
  assert.equal(mergeChecksVerdict({ required: pair, runs: green }).ok, true, "both required checks passed");

  const red = mergeChecksVerdict({ required: pair, runs: [run("validate", "completed", "success"), run("checks", "completed", "failure")] });
  assert.equal(red.ok, false);
  assert.deepEqual(red.red, ["checks"], "the SECOND required check is judged too, not just the first");

  const running = mergeChecksVerdict({ required: pair, runs: [run("validate", "in_progress", null)] });
  assert.deepEqual(running.pending, ["validate"]);
  assert.deepEqual(running.missing, ["checks"], "a required check not reported yet is not a pass");

  // `checks` is skipped when `validate` fails — a skipped REQUIRED check never counts as passed.
  const skipped = mergeChecksVerdict({ required: pair, runs: [run("validate", "completed", "success"), run("checks", "completed", "skipped")] });
  assert.deepEqual(skipped.red, ["checks"]);

  // A re-run: the newest attempt (highest id) wins, whichever order the API lists them in.
  const rerun = [run("validate", "completed", "success"), run("checks", "completed", "success", 9), run("checks", "completed", "cancelled", 3)];
  assert.equal(mergeChecksVerdict({ required: pair, runs: rerun }).ok, true, "#5605's cancelled first run must not read as red");
  assert.equal(mergeChecksVerdict({ required: pair, runs: [...rerun, run("checks", "completed", "failure", 12)] }).ok, false);

  // A NON-required check is not the gate's business when the required list is known (`mobile`).
  assert.equal(mergeChecksVerdict({ required: pair, runs: [...green, run("mobile", "completed", "failure")] }).ok, true);

  // No required list (another repository, protection unreadable): nothing failing, nothing running.
  assert.equal(mergeChecksVerdict({ required: null, runs: [] }).ok, true, "a repository with no CI has nothing to wait for");
  assert.equal(mergeChecksVerdict({ required: null, runs: [run("build", "completed", "success"), run("lint", "completed", "skipped")] }).ok, true);
  assert.deepEqual(mergeChecksVerdict({ required: null, runs: [run("build", "completed", "failure")] }).red, ["build"]);
  assert.deepEqual(mergeChecksVerdict({ required: null, runs: [run("build", "queued", null)] }).pending, ["build"]);
  // The apps that sit at queued for ever hold nothing — but one that ran and failed still counts.
  assert.equal(mergeChecksVerdict({ required: null, runs: [run("Sentry", "queued", null, 1, "sentry")] }).ok, true);
  assert.equal(mergeChecksVerdict({ required: null, runs: [run("Vercel", "completed", "failure", 1, "vercel")] }).ok, false);
  // Commit statuses count as well as check-runs.
  assert.deepEqual(mergeChecksVerdict({ required: null, runs: [], statuses: [{ context: "deploy", state: "pending" }] }).pending, ["deploy"]);
  assert.equal(mergeChecksVerdict({ required: ["deploy"], runs: [], statuses: [{ context: "deploy", state: "success" }] }).ok, true);

  assert.match(describeVerdict(red), /red: checks/);
  assert.match(describeVerdict(running), /still running: validate/);
  assert.match(describeVerdict(running), /not reported on this commit yet: checks/);
}

function declarationCases(): void {
  const declared = declaredRequiredChecks(readFileSync(resolve("AGENTS.md"), "utf8"));
  assert.ok(Array.isArray(declared.names) && declared.names.length > 0, "AGENTS.md §2 must still declare the required checks — C21's fallback reads it");
  for (const name of declared.names ?? []) {
    assert.match(
      readFileSync(resolve(".github/workflows/ci.yml"), "utf8"),
      new RegExp(`^  ${name}:`, "m"),
      `ci.yml must define the declared required job \`${name}\``,
    );
  }
}

function hookCases(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-merge-checks-"));
  try {
    const green = [run("validate", "completed", "success"), run("checks", "completed", "success"), run("mobile", "completed", "skipped")];

    const allowGreen = runGuard(dir, "gh pr merge 17 --squash", ghShim(dir, phoenixAnswers(green)));
    assert.equal(allowGreen.decision, "allow", `a green PR must merge: ${allowGreen.reason}`);

    const red = runGuard(dir, "gh pr merge 18 --squash", ghShim(dir, phoenixAnswers([run("validate", "completed", "success"), run("checks", "completed", "failure")])));
    assert.equal(red.decision, "deny", "a PR red on a required check must be refused");
    assert.match(red.reason, /^C21 /);
    assert.match(red.reason, /PR #18/);
    assert.match(red.reason, /red: checks/);
    // 403 on protection: the names came from AGENTS.md, and the refusal says which list it judged.
    assert.match(red.reason, /required checks \(validate, checks\)/);
    assert.match(red.reason, /PHX_RED_MERGE_OK=1 <the same command>/);

    const pending = runGuard(dir, "gh pr merge --squash 20", ghShim(dir, phoenixAnswers([run("validate", "in_progress", null)])));
    assert.equal(pending.decision, "deny", "a PR whose checks are still running must be refused");
    assert.match(pending.reason, /still running: validate/);
    assert.match(pending.reason, /not reported on this commit yet: checks/);

    // A non-required check red does not hold a Phoenix merge — `mobile` is not in the gate.
    const mobileRed = runGuard(dir, "gh pr merge 21", ghShim(dir, phoenixAnswers([...green.slice(0, 2), run("mobile", "completed", "failure")])));
    assert.equal(mobileRed.decision, "allow", mobileRed.reason);

    // FAILS CLOSED: a gh that answers nothing refuses the merge rather than waving it through.
    const blind = runGuard(dir, "gh pr merge 22 --squash", ghShim(dir, []));
    assert.equal(blind.decision, "deny", "an unreadable check state must refuse, never allow");
    assert.match(blind.reason, /could not read the checks/);

    const ps = runGuard(dir, "gh pr merge 18 --squash", ghShim(dir, phoenixAnswers([run("validate", "completed", "failure")])), "PowerShell");
    assert.match(ps.reason, /\$env:PHX_RED_MERGE_OK=1; <the same command>/, "PowerShell gets its own stand-down spelling");

    // The stand-down, both spellings, and help — none of them reads anything.
    for (const cmd of ["PHX_RED_MERGE_OK=1 gh pr merge 18 --squash", "$env:PHX_RED_MERGE_OK=1; gh pr merge 18 --squash", "gh pr merge --help"]) {
      assert.equal(runGuard(dir, cmd, ghShim(dir, [])).decision, "allow", `${cmd} must be allowed`);
    }
    // PHX_MERGE_OK is C10's word ("this small PR may ship alone") — it must NOT pass a red merge.
    const sizeWord = runGuard(dir, "PHX_MERGE_OK=1 gh pr merge 18 --squash", ghShim(dir, phoenixAnswers([run("validate", "completed", "failure")])));
    assert.equal(sizeWord.decision, "deny", "PHX_MERGE_OK must not stand C21 down");

    // Not a merge at all.
    for (const cmd of ["gh pr view 18", "gh pr checks 18", "git merge origin/main", 'git commit -m "gh pr merge 18 later"']) {
      assert.equal(runGuard(dir, cmd, ghShim(dir, [])).decision, "allow", `${cmd} must be allowed`);
    }

    // ANOTHER repository with no readable protection: judged on every check, and a repo with no CI passes.
    const other = (runs: Run[]): Array<[string, string | null]> => [
      ["required_status_checks", null],
      ["headRefOid,baseRefName", JSON.stringify({ headRefOid: SHA, baseRefName: "main" })],
      ["check-runs", JSON.stringify(runs)],
      [`commits/${SHA}/status`, "[]"],
    ];
    const noCi = runGuard(dir, "gh pr merge 50 --repo Omar-3-xx/phoenix-next --squash", ghShim(dir, other([])));
    assert.equal(noCi.decision, "allow", `a repository with no CI must merge: ${noCi.reason}`);
    const otherRed = runGuard(dir, "gh pr merge 50 -R Omar-3-xx/phoenix-next", ghShim(dir, other([run("build", "completed", "failure")])));
    assert.equal(otherRed.decision, "deny");
    assert.match(otherRed.reason, /omar-3-xx\/phoenix-next/);
    assert.match(otherRed.reason, /every check on the commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runMergeChecksGuardTests(): void {
  verdictCases();
  declarationCases();
  hookCases();
}
