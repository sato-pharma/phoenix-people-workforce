// The self-hosted runner is opt-in PER BRANCH, and `main` can never use one.
//
// WHY THIS EXISTS. `vars.CI_RUNNER` was repo-wide with no per-branch override, so smoke-testing a
// runner moved EVERY job on EVERY branch — including `main`, whose CI is the production deploy gate,
// and including `secret-scan`, a REQUIRED check living in security-scan.yml, where nobody flipping the
// variable was watching it. Six `runs-on` lines read that variable, not the four in ci.yml a session
// reported. It also could not be made safe by watching the flip: `vars.*` resolve per run ATTEMPT, not
// per job, so a run already in flight keeps the old value while a rerun silently picks up the new one.
// The owner halted the rollout on 2026-09-27 until it had a per-branch switch, and chose this design
// on 2026-09-28.
//
// TWO MEASURED FACTS DECIDE THE SHAPE, both read live from the runners API on 2026-09-28:
//   * `runs-on: self-hosted` matches EVERY self-hosted runner, so it can never mean "the box I
//     provisioned". When this switch was written every runner here carried the same four labels
//     (`self-hosted,X64,Linux,phoenix`) and nothing could be targeted deliberately. Since
//     2026-09-28, at the owner's instruction, the Railway replicas also carry `railway-eu`, which
//     names that pool and nothing else — so `CI_RUNNER_LABEL=railway-eu` targets them on purpose and
//     a future host takes a label of its own. 🔴 Never quote a runner COUNT: it read ten, then three,
//     inside the same hour on 2026-09-28. The replicas register non-ephemerally, so a redeploy leaves
//     superseded registrations behind — carrying the OLD label set — until someone clears them.
//   * There is no `hetzner` label on this repository, and a job whose label matches no ONLINE runner
//     does NOT fall back to hosted — it QUEUES, for ever, with nothing red anywhere.
// Together those mean the label must come from a VARIABLE and must never be hard-coded: an unset
// variable has to resolve hosted, or one typo is a silent CI outage.
//
// Every condition is asserted SEPARATELY with its own message. One combined regex would make each
// clause after the first unreachable — the defect that hid a dead assertion in
// tests/next-build-cpu-cap.test.ts, found 2026-09-27. The truth table at the end evaluates the
// SHIPPED expression, rewritten into JS, rather than a copy of it that could drift.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = ".github/workflows";
const HOSTED = "ubuntu-latest";
const LABEL = "hetzner";

type Ctx = {
  vars: Record<string, string>;
  event_name: string;
  head_repo: string;
  repository: string;
  head_ref: string;
};

/** The shipped expression, rewritten into JS so this test exercises IT and not a transcription. */
function compileRunsOn(expr: string): (c: Ctx) => string {
  const js = expr
    .replace(/github\.event\.pull_request\.head\.repo\.full_name/g, "c.head_repo")
    .replace(/github\.event_name/g, "c.event_name")
    .replace(/github\.repository/g, "c.repository")
    .replace(/github\.head_ref/g, "c.head_ref")
    .replace(/vars\.([A-Za-z_][A-Za-z0-9_]*)/g, '(c.vars.$1 ?? "")')
    .replace(/startsWith\(/g, "sw(");
  return new Function("c", 'const sw = (a, b) => String(a).startsWith(b); return (' + js + ");") as (
    c: Ctx,
  ) => string;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
}

export function runCiRunnerSwitchTests() {
  const found: { file: string; line: number; expr: string; raw: string }[] = [];
  for (const file of ["ci.yml", "security-scan.yml"]) {
    readFileSync(path.join(WORKFLOW_DIR, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const m = /^ {4}runs-on: \$\{\{ (.+) \}\}$/.exec(line);
        if (m) found.push({ file, line: i + 1, expr: m[1], raw: line });
      });
  }

  // 1 — all six exist, so none was missed.
  assert.equal(
    found.length,
    6,
    "expected 6 computed `runs-on` lines (4 in ci.yml, 2 in security-scan.yml) and found " +
      found.length +
      ": " +
      found.map((f) => f.file + ":" + f.line).join(", ") +
      ". secret-scan is a REQUIRED check and must move with the others, never separately — a session " +
      "reported this as four jobs in ci.yml and was wrong.",
  );

  // 2 — and they are byte-identical, so one can never be fixed while another is left behind.
  const variants = [...new Set(found.map((f) => f.raw))];
  assert.equal(
    variants.length,
    1,
    "the six computed `runs-on` lines are not byte-identical — " +
      variants.length +
      " variants:\n" +
      variants.map((v) => "  " + v.trim()).join("\n"),
  );

  const expr = found[0].expr;

  // 3 — each condition separately; a missing one is a different hazard in each case.
  assert.ok(
    /vars\.CI_SELF_HOSTED != 'off'/.test(expr),
    "the kill switch is gone. CI_SELF_HOSTED=off is how a stuck ci-runner/ PR is rescued without " +
      "having to remember the configured label, and because vars.* re-resolve on a new attempt it " +
      "takes effect on `gh run rerun --failed`.",
  );
  assert.ok(
    /vars\.CI_RUNNER_LABEL != ''/.test(expr),
    "the label is no longer required to be set, so an unset variable could now select an empty or " +
      "nonexistent label. NOTHING may be hard-coded here: a job whose label matches no online runner " +
      "does not fall back, it QUEUES for ever with nothing red. Unset must mean hosted.",
  );
  assert.ok(
    /github\.event_name == 'pull_request'/.test(expr),
    "`main` is no longer excluded. main's CI IS the production deploy gate (AGENTS.md §2), so a runner " +
      "that fails or queues there stops shipping to production with nothing turning red.",
  );
  assert.ok(
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/.test(expr),
    "the same-repo check is gone. A fork PR scheduled onto a self-hosted runner is arbitrary code " +
      "execution on our own machine.",
  );
  assert.ok(
    /startsWith\(github\.head_ref, 'ci-runner\/'\)/.test(expr),
    "the branch-name opt-in is gone. It is what makes this per-branch rather than repo-wide, and " +
      "unlike a variable it cannot change mid-flight. 🔴 IF YOU REMOVED IT TO WIDEN SELF-HOSTED CI TO " +
      "EVERY PR, THAT IS AN OWNER RULING AND THE ANSWER IS NO. This message used to say \"not yet, wait " +
      "for the CPX32s\" — the owner REFUSED that purchase on 2026-09-28 (\"I WILL NOT BUY THIS\"), so there " +
      "is no arriving hardware and nothing to re-propose it after. Judge it on the pool that EXISTS: " +
      "measured 2026-09-28, three replicas took FOUR required jobs and serialised — validate, checks and " +
      "mobile queued behind secret-scan — so widening onto this pool makes every PR slower than hosted " +
      "CI, trading a real cost for an unreal one. Widen only if the pool itself grows, and never by " +
      "re-pitching the boxes.",
  );

  // 4 — the retired repo-wide variable must not come back, in any expression, in any workflow.
  for (const file of workflowFiles()) {
    const text = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    for (const m of text.match(/\$\{\{[^}]*\}\}/g) ?? []) {
      assert.ok(
        !/vars\.CI_RUNNER\b(?!_LABEL)/.test(m),
        file +
          " still reads the retired repo-wide `vars.CI_RUNNER` in an expression: " +
          m +
          ". It moved every job on every branch, `main` included.",
      );
    }
  }

  // 5 — no `runs-on` may select the bare `self-hosted` label, which matches EVERY registered
  //     runner indiscriminately, stale registrations included.
  for (const file of workflowFiles()) {
    readFileSync(path.join(WORKFLOW_DIR, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!/^\s*runs-on:/.test(line)) return;
        assert.ok(
          !/(^|[^-\w])self-hosted([^-\w]|$)/.test(line.replace(/#.*$/, "")),
          file +
            ":" +
            (i + 1) +
            " selects the bare `self-hosted` label: " +
            line.trim() +
            ". That matches EVERY self-hosted runner on the repo, including registrations a redeploy " +
            "superseded but nobody cleared, so the job lands on whichever one takes it. Name the pool " +
            "you mean through CI_RUNNER_LABEL instead — railway-eu is the Railway replicas.",
        );
      });
  }

  // 6 — but the ONE legitimate runtime use of the string must survive. This invariant permits it
  //     rather than demanding zero occurrences, which is what would have made it wrong on day one.
  assert.ok(
    /PHX_BUILD_CPUS: \$\{\{ runner\.environment == 'self-hosted'/.test(
      readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8"),
    ),
    "the build's CPU cap no longer keys off `runner.environment == 'self-hosted'`. That is a RUNTIME " +
      "property, true on any self-hosted runner whatever its labels, and it is the reason the build " +
      "does not spawn one worker per visible core and abort with `os error 11`.",
  );

  // 7 — the truth table, against the shipped expression itself.
  const evaluate = compileRunsOn(expr);
  const base: Ctx = {
    vars: { CI_RUNNER_LABEL: LABEL },
    event_name: "pull_request",
    head_repo: "Gawish-1997/phoenix-people-workforce",
    repository: "Gawish-1997/phoenix-people-workforce",
    head_ref: "ci-runner/probe",
  };
  const cases: { why: string; ctx: Ctx; want: string }[] = [
    {
      why: "a push to main must NEVER be self-hosted — main's CI is the production deploy gate",
      ctx: { ...base, event_name: "push", head_ref: "" },
      want: HOSTED,
    },
    {
      // ci.yml's push trigger lists master as well as main, so both protected branches want an
      // assertion a reader can see rather than infer. Contributed by the session that built the
      // switch design (2026-09-28); its truth table had this case and mine did not.
      why: "a push to master must NEVER be self-hosted either — it is in ci.yml's push trigger list",
      ctx: { ...base, event_name: "push", head_ref: "" },
      want: HOSTED,
    },
    {
      why: "a workflow_dispatch has no head_ref at all, so it must resolve hosted",
      ctx: { ...base, event_name: "workflow_dispatch", head_ref: "" },
      want: HOSTED,
    },
    {
      why: "a scheduled run must resolve hosted",
      ctx: { ...base, event_name: "schedule", head_ref: "" },
      want: HOSTED,
    },
    {
      why: "an ordinary codex/ PR must stay hosted — this is opt-in, not the default",
      ctx: { ...base, head_ref: "codex/some-task" },
      want: HOSTED,
    },
    {
      why: "an opted-in ci-runner/ PR on this repo with a label set is the ONE case that goes self-hosted",
      ctx: { ...base },
      want: LABEL,
    },
    {
      why: "the kill switch must win over the branch name",
      ctx: { ...base, vars: { ...base.vars, CI_SELF_HOSTED: "off" } },
      want: HOSTED,
    },
    {
      why: "an unset CI_RUNNER_LABEL must mean hosted, never an empty runs-on and never a queued job",
      ctx: { ...base, vars: {} },
      want: HOSTED,
    },
    {
      why: "a FORK PR named ci-runner/evil must not reach our machine — that is arbitrary code execution",
      ctx: { ...base, head_repo: "attacker/phoenix-people-workforce", head_ref: "ci-runner/evil" },
      want: HOSTED,
    },
    {
      why: "feat/ci-runner/x must NOT match: the opt-in is a PREFIX, not a substring",
      ctx: { ...base, head_ref: "feat/ci-runner/x" },
      want: HOSTED,
    },
  ];
  for (const { why, ctx, want } of cases) {
    const got = evaluate(ctx);
    assert.equal(
      got,
      want,
      'runs-on resolved to "' +
        got +
        '" but must be "' +
        want +
        '" — ' +
        why +
        ". Context: " +
        JSON.stringify({
          event: ctx.event_name,
          head_ref: ctx.head_ref,
          fork: ctx.head_repo !== ctx.repository,
          vars: ctx.vars,
        }),
    );
  }
}
