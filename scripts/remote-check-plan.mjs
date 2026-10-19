// The decisions scripts/remote-check.mjs makes, as pure functions a test can RUN
// (tests/remote-check.test.ts) instead of only reading.
//
// 🔴 GITHUB ACTIONS ONLY (owner, 2026-10-19: "retire the hetzner box and do not use it ever again, it is
// the source of slowness", and "make all ci actions to be on github"). Until that day this file also
// built the bash sent to a self-hosted CI box over SSH — a private tree per run, a busy probe, a lock, a
// lint cache, per-stage ceilings — and decided between the box and Actions. All of it is gone with the
// box. What is left is the part that was always about GitHub: which job and step answers each stage, how
// a finished run is graded, the record a push guard reads, and the flags.
//
// There is no queue to design any more, which is the point. Every invocation is a read of, or a dispatch
// of, ONE run on GitHub's own runners, so ten sessions checking ten branches — or a hundred — never wait
// on each other: the only ceiling is GitHub's concurrent-job cap for the account.

const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// THE VERDICT RECORD
// ---------------------------------------------------------------------------------------------
// 🔴 A finished verdict is stored per stage, per commit, so a later step can REUSE it instead of
// running anything (owner, 2026-10-08: *"completed verification for the exact commit SHA may be
// reused"*). remote-check writes `<git-common-dir>/phx-remote-check/<sha>.json` — shared by every
// worktree, never tracked — and `.claude/hooks/push-typecheck-guard.mjs` only reads it. Only a run that
// ENDED IN A VERDICT (exit 0 or 1) is recorded, and only the stages that really passed or failed: a
// stage that never ran is left out, so silence is never stored as a pass. The PR's `validate` +
// `checks` remain the merge gate whatever this file says.
export const VERDICT_DIR_NAME = "phx-remote-check";
export const VERDICT_KEEP_DAYS = 14;

/**
 * The closing line of a run that STOPPED on an error once the commit was known — a refused dispatch,
 * an unreadable origin. 🔴 Every terminal path ends in exactly one `PASS|FAIL|NO VERDICT — <sha9>`
 * line, because that line is what other tools parse; a session reading the output for it must never
 * find none and be unable to tell which commit, if any, the answer was about.
 */
export function stoppedNoVerdictLine(sha) {
  return "remote-check: NO VERDICT — stopped on the error above, so nothing here is a verdict on " + String(sha).slice(0, 9);
}

/**
 * Merge one finished run's stage verdicts into the record for its sha. Pure: the caller does the IO.
 * A later verdict for the same stage replaces an earlier one (a re-run is newer evidence).
 *
 * @param {any} previous the parsed record already on disk, or null.
 * @param {{ sha: string, stages: Record<string, "PASS"|"FAIL">, source: string, at: string, excerpt?: string }} run
 */
export function mergeVerdictRecord(previous, { sha, stages, source, at, excerpt }) {
  if (!SHA_RE.test(String(sha))) throw new Error("remote-check: not a full 40-character sha: " + sha);
  const base = previous && previous.sha === sha && previous.stages && typeof previous.stages === "object"
    ? previous
    : { sha, stages: {} };
  const next = { sha, stages: { ...base.stages } };
  for (const [name, verdict] of Object.entries(stages ?? {})) {
    if (verdict !== "PASS" && verdict !== "FAIL") continue;
    next.stages[name] = { verdict, at, source, ...(name === "typecheck" && verdict === "FAIL" && excerpt ? { excerpt } : {}) };
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// FLAGS
// ---------------------------------------------------------------------------------------------

/** The flags of the retired SSH box, refused by name so a muscle-memory invocation says WHY. */
export const RETIRED_FLAGS = ["--wait", "--no-wait", "--free", "--no-actions", "--else-actions"];

/**
 * Flags are parsed, never filtered away.
 *
 * 🔴 AN UNKNOWN FLAG MUST NOT BE IGNORED: a misspelled `--dispach` would run the no-dispatch behaviour and
 * report success, so the caller believes it asked for something it never got (the same defect
 * `scripts/rollup-prs.mjs` refuses by name). The retired box flags are returned separately so the
 * message can say the box is gone rather than that the flag is merely unknown.
 *
 * `--dispatch` is the one real flag: with no open PR to read, START a ci.yml run on the branch (a full
 * workflow, so ~14 billable minutes). `--actions` and `--urgent` are accepted as the names it had when
 * the box was the default and Actions the exception; they mean the same thing.
 *
 * @param {string[]} argv the arguments after the script name.
 * @returns {{ positional: string[], dispatch: boolean, retired: string[], unknown: string[] }}
 */
export function parseArgs(argv) {
  const positional = [];
  const retired = [];
  const unknown = [];
  let dispatch = false;
  for (const arg of argv) {
    if (!arg.startsWith("-")) positional.push(arg);
    else if (arg === "--dispatch" || arg === "--actions" || arg === "--urgent") dispatch = true;
    else if (RETIRED_FLAGS.includes(arg) || arg.startsWith("--wait=")) retired.push(arg);
    else unknown.push(arg);
  }
  return { positional, dispatch, retired, unknown };
}

/**
 * 🔴 NEVER DISPATCH ON `main` — THAT RUN IS THE PRODUCTION DEPLOY GATE.
 *
 * `ci.yml`'s concurrency group is `CI-<ref>` for a pull request and **`CI-<sha>`** for everything
 * else, with `cancel-in-progress` true only for a PR. So a `workflow_dispatch` on `main` lands in
 * the SAME group as the push run of that exact commit — the run Railway's "Wait for CI" is holding
 * the production deploy on (AGENTS.md §2.3). A cancelled or failed run on that commit makes Railway
 * mark the deploy SKIPPED within minutes, and re-running it green does not resurrect it.
 *
 * There is also nothing to gain. `main` already runs the whole gate on every commit, so the answer on
 * `main` is to read that run, never to start another beside it.
 *
 * @param {string} branch the ref `gh workflow run --ref` would be given.
 */
export function isProtectedDispatchRef(branch) {
  const name = String(branch ?? "").trim().replace(/^refs\/heads\//, "");
  return name === "main" || name === "master";
}

// ---------------------------------------------------------------------------------------------
// WHICH JOB AND STEP ANSWERS EACH STAGE
// ---------------------------------------------------------------------------------------------

/** The stages a caller can ask for, in the order `all` means them. */
export const STAGES = ["lint", "typecheck", "test", "build"];

/**
 * Which CI job and step answers each stage — read off `.github/workflows/ci.yml` and nothing else,
 * pinned by tests/remote-check.test.ts against the real file so a renamed step cannot quietly turn
 * every verdict into NO VERDICT.
 *
 * A stage is a LIST of proofs and passes only when every proof does. A proof names a job (a string, or a
 * RegExp for a matrix whose jobs are called `unit (1)`, `unit (2)` …) and a step inside it; `every: true`
 * means all the jobs the RegExp matches must pass, not just the first.
 *
 * 🔴 `test` NEEDS TWO KINDS OF PROOF, AND EITHER ALONE IS WRONG. The suite is a matrix of parts, and a
 * part's own green proves only its slice. So a pass needs every part's `Test` step green AND `checks`'s
 * coverage step green — the step that refuses unless the parts' records are exactly parts 1..N and add up
 * to every test the runner declares (scripts/ci-unit-coverage.mjs). The coverage step alone cannot say
 * FAIL when a part is red (it is then skipped), and the parts alone cannot say the suite was whole.
 *
 * 🔴 AND THE SAME MAP SERVES EVERY EVENT. Before 2026-10-19 the unit suite lived in `validate` on a pull
 * request and in `checks` on everything else, so two maps were needed and picking the wrong one turned a
 * green PR into NO VERDICT. It is in `unit` on every event now. `build` is the one stage an event can
 * leave unrun — a pull request builds only when scripts/ci-build-risk.mjs says its diff can change a
 * build — and a skipped Build step is NO VERDICT by `gradeConclusion`, never a pass.
 */
export const STAGE_JOBS = {
  lint: [{ job: "static", step: "Lint" }],
  typecheck: [{ job: "static", step: "Typecheck" }],
  test: [
    { job: /^unit \(\d+\)$/, step: "Test", every: true },
    { job: "checks", step: "Prove the unit suite ran every test exactly once" },
  ],
  build: [{ job: "validate", step: "Build" }],
};

/** A job or step conclusion read the same way everywhere: allow-list the two verdicts, nothing else. */
function gradeConclusion(conclusion) {
  if (conclusion === "success") return "pass";
  if (conclusion === "failure") return "fail";
  return "no-verdict";
}

const jobMatches = (spec, job) =>
  job && typeof job.name === "string" && (spec.job instanceof RegExp ? spec.job.test(job.name) : job.name === spec.job);

/**
 * `{ verdict, why }` for ONE proof of a stage, from the run's job list. `pending` is a proof whose step
 * has not concluded yet — only ever returned for a job that is still running, and it is what lets a
 * stage be answered the moment ITS job finishes instead of when the whole run does.
 */
function gradeProof(stage, spec, jobs) {
  const matched = jobs.filter((job) => jobMatches(spec, job));
  const label = spec.job instanceof RegExp ? "the `" + String(spec.job.source) + "` jobs" : "the `" + spec.job + "` job";
  if (matched.length === 0) {
    return { verdict: "no-verdict", why: label + ", which proves " + stage + ", is not in this run" };
  }
  const graded = (spec.every ? matched : matched.slice(0, 1)).map((job) => {
    const where = "`" + job.name + "` / " + spec.step;
    if (job.status && job.status !== "completed") {
      // A running job can already hold a FINAL answer: a step's conclusion never changes once it is set.
      // Anything else — the step not reached yet, or skipped so far — is still pending.
      const early = Array.isArray(job.steps) ? job.steps.find((s) => s && s.name === spec.step) : undefined;
      const decided = early ? gradeConclusion(early.conclusion) : "no-verdict";
      if (decided === "pass" || decided === "fail") {
        return { verdict: decided, why: where + " " + String(early.conclusion) };
      }
      return { verdict: "pending", why: "`" + job.name + "` is still " + job.status };
    }
    // 🔴 A JOB THAT NEVER STARTED REPORTS `completed/failure` WITH NO STEPS AT ALL, AND THAT IS NO
    // VERDICT. Measured 2026-10-12: GitHub stopped starting jobs account-wide ("recent account
    // payments have failed or your spending limit needs to be increased"), so #5792's `validate` and
    // `checks` both ended `failure` in three seconds with `steps: []`. Grading that FAIL would record
    // "your code is broken" for a commit nothing had compiled — a verdict about an unpaid invoice. A job
    // that really ran always carries its own setup steps, so an empty list means nobody looked at the
    // code (`ci-jobs-failing-in-seconds-means-billing-not-code`).
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      return {
        verdict: "no-verdict",
        why:
          "`" + job.name + "` ended " + String(job.conclusion ?? "unknown") +
          " with no steps at all, so the job never started (an Actions billing block, or a startup failure) and " +
          stage + " never produced a verdict",
      };
    }
    const step = job.steps.find((s) => s && s.name === spec.step);
    const conclusion = step ? step.conclusion : job.conclusion;
    const verdict = gradeConclusion(conclusion);
    return {
      verdict,
      why: verdict === "no-verdict"
        ? where + " ended " + String(conclusion ?? "unknown") + ", so " + stage + " never produced a verdict"
        : where + " " + String(conclusion),
    };
  });
  return combine(graded);
}

/** fail outranks pending outranks no-verdict outranks pass — a real failure is never hidden by an unknown. */
function combine(results) {
  for (const verdict of ["fail", "pending", "no-verdict"]) {
    const hit = results.filter((r) => r.verdict === verdict);
    if (hit.length > 0) return { verdict, why: hit.map((r) => r.why).join("; ") };
  }
  return { verdict: "pass", why: results.map((r) => r.why).join("; ") };
}

/**
 * Grade ONLY the stages that were asked for, from a completed run's job list.
 *
 * 🔴 A STAGE THAT DID NOT RUN IS NO VERDICT, NEVER FAIL. A job missing from the run, one still going,
 * one cancelled, one that reports `failure` with NO STEPS because it was never started (an Actions
 * billing block), and a step skipped because an earlier step in the same job died are all "nobody looked
 * at your stage". Only an explicit `failure` on the stage itself is a FAIL.
 *
 * 🔴 A REAL FAILURE OUTRANKS AN UNKNOWN: asking for `lint test` and getting a red `lint` beside a
 * cancelled unit part is a FAIL, not a shrug.
 *
 * 🔴 THE RUN'S OWN CONCLUSION IS NEVER AN ANSWER ABOUT THE STAGE YOU ASKED FOR. A dispatch runs the whole
 * workflow, which also runs `mobile` (the Expo typecheck, which REPORTS and never gates — AGENTS.md §7),
 * the Build and the Playwright login smoke; grading the run as one thing turned `remote-check typecheck`
 * FAIL on a mobile lockfile break or a smoke flake, a verdict about somebody else's code. And since a
 * pull request's Build is conditional, a whole-run `success` no longer says the Build ran either — so
 * every route grades the job and step, with no short-circuit on the run.
 *
 * @param {string[]} names the stages the caller asked for.
 * @param {Array<{ name?: string, status?: string, conclusion?: string | null, steps?: Array<{ name?: string, conclusion?: string | null }> }> | null | undefined} jobs
 * 🔴 `pending` IS ONLY EVER A VERDICT ABOUT A RUN THAT HAS NOT FINISHED. It means "an asked-for stage's
 * step has not concluded yet and nothing asked for has failed" — the caller keeps watching. On a run
 * that HAS finished, a caller must read `pending` as no-verdict: nothing is left to wait for.
 *
 * @returns {{ verdict: "pass"|"fail"|"pending"|"no-verdict", why: string, otherRed: string[], passed: string[], stages: Record<string, "PASS"|"FAIL"> }}
 */
export function gradeActionsStages(names, jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { verdict: "no-verdict", why: "the run's job list could not be read", otherRed: [], passed: [], stages: {} };
  }
  const wanted = Array.isArray(names) && names.length > 0 ? names : STAGES;
  const graded = [];
  for (const name of wanted) {
    const proofs = STAGE_JOBS[name];
    if (!proofs) {
      graded.push({ name, verdict: "no-verdict", why: name + " is not a stage any CI job runs" });
      continue;
    }
    graded.push({ name, ...combine(proofs.map((spec) => gradeProof(name, spec, jobs))) });
  }
  // A red job that no asked-for stage depends on is REPORTED, never charged to this branch.
  const covered = (job) => wanted.some((name) => (STAGE_JOBS[name] ?? []).some((spec) => jobMatches(spec, job)));
  const otherRed = jobs.filter((j) => j && j.conclusion === "failure" && !covered(j)).map((j) => String(j.name));
  // The stages that really did pass, so a partial answer can SAY which half it has.
  const passed = graded.filter((g) => g.verdict === "pass").map((g) => g.name);
  // Per-stage PASS/FAIL for the verdict record; a no-verdict or pending stage is left out, never stored as either.
  const stages = Object.fromEntries(
    graded.filter((g) => g.verdict === "pass" || g.verdict === "fail").map((g) => [g.name, g.verdict === "pass" ? "PASS" : "FAIL"]),
  );
  return { ...combine(graded), otherRed, passed, stages };
}

/**
 * Whether a run has FINISHED and is about the right commit — ALLOW-LISTING success, never deny-listing
 * the unfinished states.
 *
 * 🔴 A WATCHER THAT `continue`s ON A LIST OF UNFINISHED STATES CALLS AN UNKNOWN STATE GREEN. That is a
 * measured failure in this repository (`a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green`):
 * a loop skipping `queued|in_progress|""` met a 422 error body, matched none of them, fell out of the
 * loop and printed its success line. So the only settled outcomes here are an explicit `completed`
 * run; `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required` and `startup_failure` are
 * settled too, and the stage grading above turns them into NO VERDICT, which is a retry and never a green.
 *
 * 🔴 AND A RUN IS ONLY EVIDENCE ABOUT THE SHA IT RAN. `gh workflow run` takes a REF, so the run checks
 * whatever that branch pointed at when it started — which is not the local commit if a push is
 * missing or someone else pushed. A mismatch is NO VERDICT, with the shas named.
 *
 * `conclusion` is `null`, not absent, while a run is unfinished — the type says so, because a
 * caller that cannot pass what GitHub actually returns would be typed into skipping that case.
 *
 * @param {{ headSha?: string | null, status?: string, conclusion?: string | null, url?: string } | null | undefined} run
 * @param {string} wantSha the 40-char sha the caller actually asked about.
 * @returns {{ settled: boolean, verdict: "pass"|"fail"|"no-verdict"|"pending", why: string }}
 */
export function gradeActionsRun(run, wantSha) {
  if (!run) return { settled: false, verdict: "pending", why: "no run has appeared yet" };
  if (run.headSha && run.headSha !== wantSha) {
    return {
      settled: true,
      verdict: "no-verdict",
      why: "the run is about " + String(run.headSha).slice(0, 9) + ", not " + wantSha.slice(0, 9),
    };
  }
  if (run.status !== "completed") {
    return { settled: false, verdict: "pending", why: "status " + String(run.status || "unknown") };
  }
  if (run.conclusion === "success") return { settled: true, verdict: "pass", why: "completed/success" };
  if (run.conclusion === "failure") return { settled: true, verdict: "fail", why: "completed/failure" };
  return {
    settled: true,
    verdict: "no-verdict",
    why: "completed/" + String(run.conclusion || "unknown") + " — not a verdict about the code",
  };
}
