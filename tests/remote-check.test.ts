import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

import {
  RETIRED_FLAGS,
  STAGES,
  STAGE_JOBS,
  VERDICT_DIR_NAME,
  gradeActionsRun,
  gradeActionsStages,
  isProtectedDispatchRef,
  mergeVerdictRecord,
  parseArgs,
  stoppedNoVerdictLine,
} from "../scripts/remote-check-plan.mjs";

// scripts/remote-check.mjs checks a commit on GitHub Actions and prints one verdict line.
//
// 🔴 THE CI BOX IS RETIRED AND THIS FILE PINS THAT IT STAYS RETIRED (owner, 2026-10-19: "retire the hetzner
// box and do not use it ever again, it is the source of slowness"). It used to be 1,448 lines about an SSH
// run on a self-hosted machine — a private tree per invocation, a busy probe, a lock, per-stage ceilings.
// None of that exists. What is left is small and every part of it is something a mistake would turn into
// a FALSE VERDICT, which is the one thing this tool must never produce: a FAIL is reported to the owner as
// "your code is broken", and a PASS lets a push through. So the cases below are, in order:
//   1. nothing in the live code can reach the box, or run a heavy tool on this laptop;
//   2. the flags (an unknown or retired one is refused by name, never ignored);
//   3. the stage map is read against the REAL ci.yml, so a renamed job or step cannot quietly turn every
//      verdict into NO VERDICT;
//   4. the grading, case by case — what is PASS, what is FAIL, and above all what is neither;
//   5. the whole script, end to end, against a fake `gh` and a real git repository.
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = readFileSync(path.join(ROOT, "scripts", "remote-check.mjs"), "utf8");
const PLAN_SRC = readFileSync(path.join(ROOT, "scripts", "remote-check-plan.mjs"), "utf8");
const CI = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");

type Step = { name: string; conclusion: string | null };
type Job = { name: string; status: string; conclusion: string | null; steps: Step[] };

/** A job as the jobs API reports it. A job that really ran always carries steps, so one is always given. */
function job(name: string, steps: Record<string, string | null>, status = "completed", conclusion: string | null = "success"): Job {
  return { name, status, conclusion, steps: [{ name: "Set up job", conclusion: "success" }, ...Object.entries(steps).map(([n, c]) => ({ name: n, conclusion: c }))] };
}

const PROVE = "Prove the unit suite ran every test exactly once";

/** A fully green run of ci.yml on a dispatch — the build ran. */
const green = (): Job[] => [
  job("validate", { Build: "success" }),
  job("static", { Lint: "success", Typecheck: "success" }),
  job("unit (1)", { Test: "success" }),
  job("unit (2)", { Test: "success" }),
  job("unit (3)", { Test: "success" }),
  job("checks", { [PROVE]: "success" }),
  job("mobile", { "Typecheck the mobile app": "success" }),
];

/** The same run with one job's step replaced. */
function with_(jobs: Job[], name: string, step: string, conclusion: string | null, jobConclusion?: string | null): Job[] {
  return jobs.map((j) =>
    j.name === name
      ? { ...j, conclusion: jobConclusion === undefined ? j.conclusion : jobConclusion, steps: j.steps.map((s) => (s.name === step ? { ...s, conclusion } : s)) }
      : j,
  );
}

export async function runRemoteCheckTests(): Promise<void> {
  // ── 1. THE BOX IS GONE, AND NOTHING HEAVY RUNS HERE ───────────────────────────────────────────
  // The comments name the retired box on purpose (they say WHY it is gone), so only live code is read.
  for (const [file, source] of [["remote-check.mjs", SRC], ["remote-check-plan.mjs", PLAN_SRC]] as const) {
    const live = stripComments(source);
    for (const [needle, what] of [
      [/\bssh\b/i, "an ssh call"],
      [/46\.225\.184\.142/, "the retired box's address"],
      [/\bphxci\b/, "the retired box's user"],
      [/PHX_CHECK_(?:HOST|USER|KEY|FORCE|WAIT_MINUTES)/, "a retired box setting"],
      [/\bflock\b/, "a box lock"],
      [/railway_phoenix_ed25519/, "the box's ssh key"],
      [/\bBOX_LOCK|buildRunScript|buildBusyProbeScript|decideBusyAction|parseBusyProbe/, "box machinery"],
    ] as const) {
      assert.doesNotMatch(live, needle, `${file} still carries ${what}. The CI box is retired (owner, 2026-10-19) and nothing may reach it again.`);
    }
  }

  // It may start `git` and `gh` and nothing else: no tsc, no eslint, no next, no pnpm, no node child.
  const spawned = [...stripComments(SRC).matchAll(/(?:execFileSync|spawnSync|spawn)\(\s*["'](\w+)["']/g)].map((m) => m[1]);
  assert.ok(spawned.length > 0, "found no spawned program at all — this scan stopped looking at the script");
  assert.deepEqual(
    [...new Set(spawned)].sort(),
    ["gh", "git"],
    "remote-check.mjs spawns something other than `git` and `gh`. It asks GitHub; it never runs a check on this laptop, " +
      "where `tsc` is reaped without a word (AGENTS.md §5, bash-guard C8).",
  );

  // The one dispatch the script can make is a literal workflow file on a branch — never `main`.
  assert.match(SRC, /isProtectedDispatchRef\(branch\)/, "the script no longer asks whether it is on a protected branch");

  // ── 2. FLAGS: NAMED, NEVER IGNORED ────────────────────────────────────────────────────────────
  assert.deepEqual(parseArgs(["typecheck"]), { positional: ["typecheck"], dispatch: false, retired: [], unknown: [] });
  for (const alias of ["--dispatch", "--actions", "--urgent"]) {
    assert.equal(parseArgs(["test", alias]).dispatch, true, `${alias} must arm the dispatch`);
  }
  assert.deepEqual(parseArgs(["lint", "test"]).positional, ["lint", "test"]);
  for (const flag of RETIRED_FLAGS) {
    assert.deepEqual(parseArgs([flag]).retired, [flag], `${flag} belonged to the box and must be refused by name`);
  }
  assert.deepEqual(parseArgs(["--wait=6"]).retired, ["--wait=6"], "the inline form of a retired flag too");
  assert.deepEqual(parseArgs(["--dispach"]).unknown, ["--dispach"], "a misspelling must come back as unknown, never be dropped");
  assert.equal(parseArgs(["--dispach"]).dispatch, false, "a misspelled dispatch flag must NOT arm a dispatch");

  assert.equal(isProtectedDispatchRef("main"), true);
  assert.equal(isProtectedDispatchRef("refs/heads/main"), true);
  assert.equal(isProtectedDispatchRef("master"), true);
  assert.equal(isProtectedDispatchRef("codex/main-fix"), false, "a branch merely containing `main` is not protected");
  assert.equal(isProtectedDispatchRef(""), false);

  // ── 3. THE STAGE MAP IS READ AGAINST THE REAL ci.yml ──────────────────────────────────────────
  // A renamed job or step would not fail anything here: every stage would silently become NO VERDICT, and a
  // NO VERDICT is a retry rather than an alarm. So the names are checked against the file itself.
  const jobsOfCi = new Map<string, string>();
  {
    let name: string | null = null;
    let body: string[] = [];
    let inJobs = false;
    for (const line of CI.split("\n")) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (!inJobs) continue;
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (header) {
        if (name) jobsOfCi.set(name, body.join("\n"));
        name = header[1];
        body = [];
      } else if (name) body.push(line);
    }
    if (name) jobsOfCi.set(name, body.join("\n"));
  }
  assert.deepEqual([...STAGES], ["lint", "typecheck", "test", "build"], "the stages `all` means");
  for (const stage of STAGES) {
    const proofs = (STAGE_JOBS as Record<string, Array<{ job: string | RegExp; step: string }>>)[stage];
    assert.ok(proofs && proofs.length > 0, `stage ${stage} has no proof`);
    for (const proof of proofs) {
      // A matrix job is `unit (1)` in the jobs API and `unit` in the file.
      const fileName = proof.job instanceof RegExp ? /^\^?([a-z-]+)/.exec(proof.job.source)?.[1] ?? "" : proof.job;
      const body = jobsOfCi.get(fileName);
      assert.ok(body, `stage ${stage} reads job \`${fileName}\`, which ci.yml no longer declares — every ${stage} verdict would be NO VERDICT`);
      assert.ok(
        body.includes(`- name: ${proof.step}\n`),
        `stage ${stage} reads step "${proof.step}" in \`${fileName}\`, which ci.yml no longer has — every ${stage} verdict would be NO VERDICT`,
      );
      if (proof.job instanceof RegExp) {
        // Any part count: how many is tests/ci-suite-placement.test.ts's to pin, not this file's.
        assert.match(body, /matrix:\s*\n\s*part: \[1(, \d+)+\]/, "a regexp proof means a matrix job; ci.yml's `unit` must still have one");
        assert.ok(proof.job.test("unit (1)") && proof.job.test("unit (2)") && !proof.job.test("unit"), "the matrix pattern must match `unit (N)` and nothing else");
      }
    }
  }

  // ── 4. GRADING: PASS, FAIL, AND ABOVE ALL WHAT IS NEITHER ─────────────────────────────────────
  {
    const all = gradeActionsStages([], green());
    assert.equal(all.verdict, "pass", `a fully green run must pass: ${all.why}`);
    assert.deepEqual(all.stages, { lint: "PASS", typecheck: "PASS", test: "PASS", build: "PASS" });
    assert.deepEqual(all.passed, ["lint", "typecheck", "test", "build"]);
    assert.deepEqual(all.otherRed, []);
  }
  {
    // lint red: FAIL, and the stages that did pass are still named so the record is not thrown away.
    const run = gradeActionsStages(["lint", "typecheck"], with_(green(), "static", "Lint", "failure", "failure"));
    assert.equal(run.verdict, "fail");
    assert.deepEqual(run.stages, { lint: "FAIL", typecheck: "PASS" }, "the failing stage and the passing one are both recorded");
  }
  {
    // 🔴 THE SUITE IS A MATRIX: one red part is a FAIL for `test` even though `checks` never reached its proof.
    let jobs = with_(green(), "unit (2)", "Test", "failure", "failure");
    jobs = with_(jobs, "checks", PROVE, "skipped", "failure");
    const run = gradeActionsStages(["test"], jobs);
    assert.equal(run.verdict, "fail", `a red unit part must fail the suite stage: ${run.why}`);
    assert.match(run.why, /`unit \(2\)` \/ Test failure/, "the failing part must be named");
  }
  {
    // 🔴 ...AND ALL PARTS GREEN IS NOT ENOUGH WITHOUT THE COVERAGE PROOF. A suite that ran 2 of 3 parts is smaller.
    const run = gradeActionsStages(["test"], with_(green(), "checks", PROVE, "failure", "failure"));
    assert.equal(run.verdict, "fail", "a red coverage proof (a part missing, or a test run twice) must fail the suite stage");
    const skipped = gradeActionsStages(["test"], with_(green(), "checks", PROVE, "skipped", "failure"));
    assert.equal(skipped.verdict, "no-verdict", "a skipped coverage proof is NO VERDICT — the parts alone never prove the suite was whole");
    assert.deepEqual(skipped.stages, {}, "and a no-verdict stage is never recorded as either");
    const noChecks = gradeActionsStages(["test"], green().filter((j) => j.name !== "checks"));
    assert.equal(noChecks.verdict, "no-verdict", "no `checks` job in the run means the suite was never proved");
  }
  {
    // A pull request's Build is conditional. A skipped Build step must never read as a build PASS.
    const prRun = with_(green(), "validate", "Build", "skipped");
    const asked = gradeActionsStages(["build"], prRun);
    assert.equal(asked.verdict, "no-verdict", `a skipped Build is NO VERDICT, never a pass: ${asked.why}`);
    const everything = gradeActionsStages([], prRun);
    assert.equal(everything.verdict, "no-verdict", "`all` on a run that did not build is a partial answer, not a pass");
    assert.deepEqual(everything.passed, ["lint", "typecheck", "test"], "…but it says which three halves DID pass");
    assert.deepEqual(everything.stages, { lint: "PASS", typecheck: "PASS", test: "PASS" }, "and only those three are recorded");
  }
  {
    // 🔴 A JOB THAT NEVER STARTED (an Actions billing block) is `completed/failure` with NO STEPS — that is not a FAIL.
    const unpaid = green().map((j) => (j.name === "static" ? { ...j, conclusion: "failure", steps: [] } : j));
    const run = gradeActionsStages(["lint", "typecheck"], unpaid);
    assert.equal(run.verdict, "no-verdict", "a job with no steps never ran: nobody looked at the code");
    assert.match(run.why, /no steps at all/);
    assert.deepEqual(run.stages, {});
  }
  {
    // Red elsewhere is REPORTED, never charged: `mobile` failing must not fail `lint`.
    const run = gradeActionsStages(["lint"], with_(green(), "mobile", "Typecheck the mobile app", "failure", "failure"));
    assert.equal(run.verdict, "pass", "a red `mobile` job is not a verdict about lint");
    assert.deepEqual(run.otherRed, ["mobile"], "but it is named");
  }
  {
    // 🔴 AN ANSWER THE MOMENT THE STAGE ANSWERS: lint is decided while the rest of the run is still going.
    const midRun: Job[] = [
      job("static", { Lint: "success", Typecheck: null }, "in_progress", null),
      job("validate", { Build: null }, "in_progress", null),
      job("unit (1)", { Test: null }, "queued", null),
    ];
    const lint = gradeActionsStages(["lint"], midRun);
    assert.equal(lint.verdict, "pass", `lint's own step already succeeded, so it is answered now: ${lint.why}`);
    const typecheck = gradeActionsStages(["typecheck"], midRun);
    assert.equal(typecheck.verdict, "pending", "a step still running is pending, not a verdict");
    const both = gradeActionsStages(["lint", "typecheck"], midRun);
    assert.equal(both.verdict, "pending", "one answered stage and one pending is still pending");
    assert.deepEqual(both.stages, { lint: "PASS" }, "the answered one is recorded, the pending one is not");
    // …and a failure is final the moment it happens, whatever else is still running.
    const failing = gradeActionsStages(["lint", "typecheck"], [job("static", { Lint: "failure", Typecheck: null }, "in_progress", null)]);
    assert.equal(failing.verdict, "fail", "an early FAIL must not wait for the rest of the run");
    // A job that is merely queued has decided nothing.
    assert.equal(gradeActionsStages(["build"], [job("validate", { Build: null }, "queued", null)]).verdict, "pending");
  }
  assert.equal(gradeActionsStages(["lint"], null).verdict, "no-verdict", "an unreadable job list is NO VERDICT");
  assert.equal(gradeActionsStages(["lint"], []).verdict, "no-verdict");
  assert.equal(gradeActionsStages(["lint", "nonsense"], green()).verdict, "no-verdict", "a stage no CI job runs is NO VERDICT, never a pass");
  assert.match(gradeActionsStages(["nonsense"], green()).why, /not a stage any CI job runs/);

  // The run itself: only an explicit completed/success|failure is an answer; everything else is not.
  const SHA = "a".repeat(40);
  assert.equal(gradeActionsRun(undefined, SHA).verdict, "pending");
  assert.deepEqual(gradeActionsRun({ headSha: SHA, status: "queued", conclusion: null }, SHA).settled, false);
  assert.deepEqual(gradeActionsRun({ headSha: SHA, status: "in_progress", conclusion: null }, SHA).settled, false);
  assert.equal(gradeActionsRun({ headSha: SHA, status: "completed", conclusion: "success" }, SHA).verdict, "pass");
  assert.equal(gradeActionsRun({ headSha: SHA, status: "completed", conclusion: "failure" }, SHA).verdict, "fail");
  for (const conclusion of ["cancelled", "timed_out", "skipped", "neutral", "action_required", "startup_failure", null, undefined]) {
    const graded = gradeActionsRun({ headSha: SHA, status: "completed", conclusion: conclusion as string }, SHA);
    assert.equal(graded.verdict, "no-verdict", `completed/${String(conclusion)} is NO VERDICT — a retry, never a green`);
  }
  const wrong = gradeActionsRun({ headSha: "b".repeat(40), status: "completed", conclusion: "success" }, SHA);
  assert.equal(wrong.verdict, "no-verdict", "a green run about ANOTHER commit is no evidence about this one");
  assert.match(wrong.why, /bbbbbbbbb, not aaaaaaaaa/);

  // The verdict record: only PASS|FAIL are kept, a later run replaces an earlier one, another sha starts fresh.
  assert.throws(() => mergeVerdictRecord(null, { sha: "abc", stages: {}, source: "x", at: "t" }), /40-character sha/);
  const first = mergeVerdictRecord(null, { sha: SHA, stages: { lint: "PASS", typecheck: "FAIL", test: "MAYBE" as "PASS" }, source: "run 1", at: "t1" });
  assert.deepEqual(Object.keys(first.stages).sort(), ["lint", "typecheck"], "a stage that is not PASS|FAIL is never stored");
  const second = mergeVerdictRecord(first, { sha: SHA, stages: { typecheck: "PASS" }, source: "run 2", at: "t2" });
  assert.equal(second.stages.typecheck.verdict, "PASS", "a re-run is newer evidence");
  assert.equal(second.stages.lint.source, "run 1", "and does not erase the other stages");
  assert.deepEqual(mergeVerdictRecord(second, { sha: "c".repeat(40), stages: { lint: "PASS" }, source: "x", at: "t" }).stages.typecheck, undefined, "another commit starts a fresh record");
  assert.equal(VERDICT_DIR_NAME, "phx-remote-check", "the push guard reads this directory by name (tests/push-typecheck-guard.test.ts)");
  assert.match(stoppedNoVerdictLine(SHA), /^remote-check: NO VERDICT — .* on aaaaaaaaa$/);

  // ── 5. THE WHOLE SCRIPT, AGAINST A FAKE `gh` AND A REAL GIT REPOSITORY ───────────────────────
  // POSIX only: a fake `gh` is an executable script found on PATH, which Windows does not resolve (it looks for
  // gh.exe). The suite runs in CI on Linux; a laptop run skips this block and says so.
  if (process.platform === "win32") {
    console.log("remote-check.test: skipping the end-to-end block on Windows (a fake `gh` script is not resolvable there)");
    return;
  }
  const work = mkdtempSync(path.join(os.tmpdir(), "phx-remote-check-"));
  try {
    const bin = path.join(work, "bin");
    mkdirSync(bin);
    const fakeGh = path.join(bin, "gh");
    writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const fx = JSON.parse(fs.readFileSync(process.env.RC_FIXTURE, "utf8"));',
        "const argv = process.argv.slice(2);",
        'fs.appendFileSync(process.env.RC_LOG, argv.join(" ") + "\\n");',
        'const marker = process.env.RC_FIXTURE + ".dispatched";',
        // The open-PR lookup is REST (`gh api repos/{owner}/{repo}/pulls?…&head=…`) — `gh pr list` is
        // GraphQL, which a cloud session is refused (2026-11-03). A `pr list` call is answered with an
        // error, so a regression to it reads as "no PR" and fails the open-PR cases below.
        'if (argv[0] === "pr" && argv[1] === "list") { console.error("HTTP 403: GraphQL is not available"); process.exit(1); }',
        'if (argv[0] === "api" && /^repos\\/[^?]+\\/pulls\\?/.test(argv[1] || "")) { if (fx.openPr) process.stdout.write(String(fx.openPr) + "\\n"); process.exit(0); }',
        'if (argv[0] === "api") {',
        '  const jq = argv[argv.indexOf("--jq") + 1] || "";',
        '  const m = /\\.path == "([^"]+)" and \\.event == "([^"]+)"/.exec(jq);',
        '  const source = fs.existsSync(marker) && fx.runsAfterDispatch ? fx.runsAfterDispatch : fx.runs || [];',
        "  const runs = source.filter((r) => !m || (r.path === m[1] && r.event === m[2]));",
        "  process.stdout.write(JSON.stringify(runs.map(({ path, ...rest }) => rest)));",
        "  process.exit(0);",
        "}",
        'if (argv[0] === "run" && argv[1] === "view") { process.stdout.write(JSON.stringify({ jobs: fs.existsSync(marker) && fx.jobsAfterDispatch ? fx.jobsAfterDispatch : fx.jobs || [] })); process.exit(0); }',
        'if (argv[0] === "workflow" && argv[1] === "run") { if (fx.dispatchFails) { console.error("HTTP 422: boom"); process.exit(1); } fs.writeFileSync(marker, "1"); process.exit(0); }',
        'console.error("fake gh: unexpected " + argv.join(" ")); process.exit(99);',
      ].join("\n") + "\n",
    );
    chmodSync(fakeGh, 0o755);

    const git = (cwd: string, ...args: string[]) => {
      const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
      assert.equal(out.status, 0, `git ${args.join(" ")} failed: ${out.stderr}`);
      return out.stdout.trim();
    };
    const origin = path.join(work, "origin.git");
    git(work, "init", "-q", "--bare", origin);

    /** A fresh clone on `branch`, pushed (or not), with one commit — returns the dir and the sha. */
    function repo(name: string, branch: string, push: boolean) {
      const dir = path.join(work, name);
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", branch);
      git(dir, "remote", "add", "origin", origin);
      writeFileSync(path.join(dir, "a.txt"), name);
      git(dir, "add", "a.txt");
      git(dir, "commit", "-q", "-m", "c");
      if (push) git(dir, "push", "-q", "origin", branch);
      return { dir, sha: git(dir, "rev-parse", "HEAD") };
    }

    let n = 0;
    /** Run the script in `dir` with a fixture, returning its exit code, output, the gh calls and the record. */
    function run(dir: string, sha: string, fixture: Record<string, unknown>, ...args: string[]) {
      n += 1;
      const fx = path.join(work, `fixture-${n}.json`);
      const log = path.join(work, `gh-${n}.log`);
      writeFileSync(fx, JSON.stringify(fixture));
      writeFileSync(log, "");
      const out = spawnSync(process.execPath, [path.join(ROOT, "scripts", "remote-check.mjs"), ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RC_FIXTURE: fx, RC_LOG: log },
      });
      const record = path.join(dir, ".git", VERDICT_DIR_NAME, `${sha}.json`);
      return {
        code: out.status,
        text: out.stdout + out.stderr,
        calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
        record: existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null,
        dispatched: readFileSync(log, "utf8").split("\n").some((l) => l.startsWith("workflow run")),
      };
    }
    const wf = ".github/workflows/ci.yml";
    const prRun = (sha: string, over: Record<string, unknown> = {}) => ({
      databaseId: 11, headSha: sha, status: "completed", conclusion: "success", url: "https://example.test/run/11", event: "pull_request", createdAt: "2026-10-19T10:00:00Z", path: wf, ...over,
    });
    const short = (sha: string) => sha.slice(0, 9);

    // a — an open PR with a green run: read it, PASS, bill nothing, record every stage.
    {
      const { dir, sha } = repo("a", "codex/feature-a", true);
      const r = run(dir, sha, { openPr: 7, runs: [prRun(sha)], jobs: green() }, "all");
      assert.equal(r.code, 0, `a green PR run must PASS:\n${r.text}`);
      assert.match(r.text, new RegExp(`remote-check: PASS — ${short(sha)}`));
      assert.equal(r.dispatched, false, "reading a PR's run must never dispatch beside it");
      assert.deepEqual(r.record?.stages && Object.keys(r.record.stages).sort(), ["build", "lint", "test", "typecheck"]);
    }
    // b — typecheck red in the PR run: FAIL, named, and exit 1.
    {
      const { dir, sha } = repo("b", "codex/feature-b", true);
      const r = run(dir, sha, { openPr: 8, runs: [prRun(sha, { conclusion: "failure" })], jobs: with_(green(), "static", "Typecheck", "failure", "failure") }, "typecheck");
      assert.equal(r.code, 1, `a red typecheck must FAIL:\n${r.text}`);
      assert.match(r.text, new RegExp(`remote-check: FAIL — ${short(sha)}`));
      assert.equal(r.record?.stages.typecheck.verdict, "FAIL");
    }
    // c — a PR whose Build was skipped: `all` is NO VERDICT (exit 6) and prints NO PASS line for this sha.
    {
      const { dir, sha } = repo("c", "codex/feature-c", true);
      const r = run(dir, sha, { openPr: 9, runs: [prRun(sha)], jobs: with_(green(), "validate", "Build", "skipped") }, "all");
      assert.equal(r.code, 6, `a run that did not build cannot answer \`all\`:\n${r.text}`);
      assert.doesNotMatch(r.text, /remote-check: PASS/, "a NO VERDICT must never print a PASS line");
      assert.match(r.text, /lint \+ typecheck \+ test did pass/, "it says which half it has");
    }
    // d — the PR run is a green run about ANOTHER commit: no evidence about this one.
    {
      const { dir, sha } = repo("d", "codex/feature-d", true);
      const r = run(dir, sha, { openPr: 10, runs: [prRun(sha, { headSha: "f".repeat(40) })], jobs: green() }, "lint");
      assert.equal(r.code, 6, `a run about another commit is NO VERDICT:\n${r.text}`);
      assert.doesNotMatch(r.text, /remote-check: PASS/);
    }
    // e — the answer arrives while the run is STILL RUNNING: lint is decided by its own step.
    {
      const { dir, sha } = repo("e", "codex/feature-e", true);
      const midRun: Job[] = [job("static", { Lint: "success", Typecheck: null }, "in_progress", null), job("validate", { Build: null }, "in_progress", null)];
      const r = run(dir, sha, { openPr: 11, runs: [prRun(sha, { status: "in_progress", conclusion: null })], jobs: midRun }, "lint");
      assert.equal(r.code, 0, `lint is answered while the run is still going:\n${r.text}`);
      assert.match(r.text, /still running/);
      assert.match(r.text, new RegExp(`remote-check: PASS — ${short(sha)}`));
    }
    // f — no PR and no flag: NO VERDICT, and NOTHING is dispatched (it would bill ~14 minutes for what the PR gives).
    {
      const { dir, sha } = repo("f", "codex/feature-f", true);
      const r = run(dir, sha, { runs: [] }, "test");
      assert.equal(r.code, 6, `no PR and no --dispatch is NO VERDICT:\n${r.text}`);
      assert.equal(r.dispatched, false, "nothing may be dispatched without the flag");
      assert.match(r.text, /gh pr create/, "it says to open the PR");
    }
    // g — no PR with --dispatch: exactly ONE dispatch of ci.yml on THIS branch, then the new run is watched and graded.
    {
      const { dir, sha } = repo("g", "codex/feature-g", true);
      const dispatched = { databaseId: 22, headSha: sha, status: "completed", conclusion: "success", url: "https://example.test/run/22", event: "workflow_dispatch", createdAt: "2999-01-01T00:00:00Z", path: wf };
      const r = run(dir, sha, { runs: [], runsAfterDispatch: [dispatched], jobs: [], jobsAfterDispatch: green() }, "typecheck", "--dispatch");
      assert.equal(r.code, 0, `a green dispatched run must PASS:\n${r.text}`);
      assert.deepEqual(r.calls.filter((l) => l.startsWith("workflow run")), ["workflow run ci.yml --ref codex/feature-g"], "exactly one dispatch, on the branch, of ci.yml");
    }
    // h — a dispatch that GitHub refuses is exit 2 with a closing NO VERDICT line, never a pass.
    {
      const { dir, sha } = repo("h", "codex/feature-h", true);
      const r = run(dir, sha, { runs: [], dispatchFails: true }, "lint", "--dispatch");
      assert.equal(r.code, 2, `a refused dispatch could not start:\n${r.text}`);
      assert.match(r.text, new RegExp(`remote-check: NO VERDICT — stopped on the error above, so nothing here is a verdict on ${short(sha)}`));
    }
    // i — the commit is not on origin: stop BEFORE asking GitHub anything, and say pushing is free.
    {
      const { dir, sha } = repo("i", "codex/feature-i", false);
      const r = run(dir, sha, { openPr: 12, runs: [prRun(sha)], jobs: green() }, "lint");
      assert.equal(r.code, 2, `an unpushed commit cannot be checked:\n${r.text}`);
      assert.match(r.text, /origin does not hold this commit/);
      assert.match(r.text, /costs NO Actions minutes/);
      assert.equal(r.calls.length, 0, "nothing may be asked of GitHub about a commit it does not have");
    }
    // j — `main` is READ (its push run is the production deploy gate) and NEVER dispatched, even with the flag.
    {
      const { dir, sha } = repo("j", "main", true);
      const pushRun = { databaseId: 33, headSha: sha, status: "completed", conclusion: "success", url: "https://example.test/run/33", event: "push", createdAt: "2026-10-19T10:00:00Z", path: wf };
      const r = run(dir, sha, { runs: [pushRun], jobs: green() }, "lint", "--dispatch");
      assert.equal(r.code, 0, `main's own green push run answers:\n${r.text}`);
      assert.equal(r.dispatched, false, "a dispatch on main joins the production deploy gate's concurrency group — never");
      assert.doesNotMatch(r.calls.join("\n"), /pr list|\/pulls\?/, "main is not looked up as a PR branch");
    }
    // k — the retired box flags and an unknown flag are refused before git or GitHub are touched.
    {
      const { dir, sha } = repo("k", "codex/feature-k", true);
      const retired = run(dir, sha, {}, "lint", "--no-wait");
      assert.equal(retired.code, 2);
      assert.match(retired.text, /belonged to the retired CI box/);
      assert.equal(retired.calls.length, 0);
      assert.equal(run(dir, sha, {}, "lint", "--dispach").code, 2, "an unknown flag is refused, never ignored");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
