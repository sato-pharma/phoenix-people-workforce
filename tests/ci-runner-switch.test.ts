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

  assertCiJobLedger();
}

// ── THE JOB LEDGER: what one ci.yml run costs, per event ─────────────────────────────────────────
//
// 🔴 WHY THIS EXISTS (2026-10-27). On 2026-10-19 18:13 Cairo ci.yml was split from 4 jobs a run into 8.
// Nothing failed and nothing turned red: the run count stayed at about 137 a day, but the median billed
// minutes per run went from 9 to 16, so the account's day went from 1,189 to 2,397 minutes. Every job is
// billed in WHOLE minutes, so a 6-second job costs a full minute and a matrix leg pays its own setup and
// install. No check pinned how many jobs an event runs, so the split read as a tidy-up and the bill was
// the first place it showed — on a budget whose "stop usage" setting stops CI, and with it every
// production deploy at the release gate, around day 23 of the month at that rate.
//
// So the jobs each event runs are pinned HERE, by name, with what one run of that set bills and a dated
// note saying where that number came from. Adding a job, a matrix leg or a trigger fails this test until
// the ledger AND its note are changed in the same PR — which puts the cost in front of the reviewer
// before the merge, not on the invoice after it. The numbers are measurements from the jobs API
// (ceil((completed_at − started_at) / 60) per job, skipped jobs excluded); the invoice is still the only
// authority on money (docs/ci-self-hosted-runner.md).
type LedgerEntry = {
  /** Jobs that run on every run of this event, matrix legs spelled the way GitHub names them. */
  jobs: string[];
  /** Jobs that run only when the run asks for them (a dispatch input). Not counted in billedPerRun. */
  optional?: string[];
  billedPerRun: number;
  /** `YYYY-MM-DD: … <n> billed min/run …` — the date, and where the number came from. */
  note: string;
};

export const CI_TRIGGERS = { pull_request: [] as string[], push: ["main", "master"], workflow_dispatch: [] as string[] };

export const CI_JOBS_BY_EVENT: Record<keyof typeof CI_TRIGGERS, LedgerEntry> = {
  pull_request: {
    jobs: ["validate", "static", "unit (1)", "unit (2)", "checks"],
    billedPerRun: 13.86,
    note: "2026-10-27: measured over the 26 Oct PR runs, 13.86 billed min/run (validate 3.26, static 2.79, unit (1) + unit (2) 6.84, checks 0.97). The owner kept this shape on 27 Oct.",
  },
  push: {
    jobs: ["validate", "static", "unit (1)", "unit (2)", "checks", "release-gate", "mobile"],
    billedPerRun: 19.36,
    note: "2026-10-27: measured over the 26 Oct main pushes, 19.36 billed min/run (validate 6.55 with the build and smoke, static 2.74, unit x2 7.06, checks 1.00, release-gate 1.00, mobile 1.01).",
  },
  workflow_dispatch: {
    jobs: ["validate", "static", "unit (1)", "unit (2)", "checks", "mobile"],
    optional: ["full-e2e"],
    billedPerRun: 18.36,
    note: "2026-10-27: not measured, dispatch is rare; estimated as the push run without release-gate, 18.36 billed min/run.",
  },
};

const NOTE_SHAPE = /^\d{4}-\d{2}-\d{2}: .*?(\d+(?:\.\d+)?) billed min\/run/;

type CiJob = { id: string; ifExpr: string | null; matrix: string[] | null };

/** ci.yml's top-level jobs, each with its job-level `if:` and its one-key matrix values, if any. */
function ciJobs(): CiJob[] {
  const out: CiJob[] = [];
  let inJobs = false;
  let current: CiJob | null = null;
  let inMatrix = false;
  for (const { text } of live("ci.yml")) {
    if (/^jobs:\s*$/.test(text)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(text)) break;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(text);
    if (job) {
      current = { id: job[1], ifExpr: null, matrix: null };
      out.push(current);
      inMatrix = false;
      continue;
    }
    if (!current) continue;
    const ifLine = /^ {4}if:\s*(.+?)\s*$/.exec(text);
    if (ifLine) current.ifExpr = ifLine[1];
    if (/^ {6}matrix:\s*$/.test(text)) {
      inMatrix = true;
      continue;
    }
    if (inMatrix) {
      const key = /^ {8}([A-Za-z0-9_-]+):\s*\[([^\]]*)\]\s*$/.exec(text);
      if (key) {
        assert.equal(
          current.matrix,
          null,
          `ci.yml job \`${current.id}\` has a matrix with more than one key. The job ledger counts one key's legs; teach ` +
            `tests/ci-runner-switch.test.ts the new shape, and put its billed minutes in CI_JOBS_BY_EVENT.`,
        );
        current.matrix = key[2].split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, ""));
        continue;
      }
      if (!/^ {8,}/.test(text) && text.trim() !== "") inMatrix = false;
      else if (text.trim() !== "") {
        assert.fail(
          `ci.yml job \`${current.id}\` has a matrix entry this ledger cannot count: ${text.trim()}. Each leg is billed as ` +
            `its own job; teach tests/ci-runner-switch.test.ts the shape and price it in CI_JOBS_BY_EVENT.`,
        );
      }
    }
  }
  return out;
}

type EventKey = keyof typeof CI_TRIGGERS;
const ALL_EVENTS: EventKey[] = ["pull_request", "push", "workflow_dispatch"];

/**
 * Which events a job-level `if:` runs on — from an ALLOW-LIST of the expressions ci.yml uses today.
 * Anything else fails closed: a new condition is a new cost shape, and guessing it would let the
 * ledger read green for a job it has priced wrong.
 */
function eventsFor(job: CiJob): { always: EventKey[]; optional: EventKey[] } {
  const expr = (job.ifExpr ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "").replace(/\s+/g, " ").trim();
  if (expr === "" || expr === "!cancelled()") return { always: ALL_EVENTS, optional: [] };
  if (expr === "github.event_name != 'pull_request'") return { always: ["push", "workflow_dispatch"], optional: [] };
  if (expr === "github.event_name == 'push' && github.ref == 'refs/heads/main'") return { always: ["push"], optional: [] };
  if (expr === "github.event_name == 'workflow_dispatch' && github.event.inputs.full_e2e == 'true'") {
    return { always: [], optional: ["workflow_dispatch"] };
  }
  assert.fail(
    `ci.yml job \`${job.id}\` runs under \`if: ${job.ifExpr}\`, which the job ledger does not know. Teach eventsFor() in ` +
      `tests/ci-runner-switch.test.ts which events that runs on, and price it in CI_JOBS_BY_EVENT.`,
  );
}

/** ci.yml's `on:` block: each event, with its branch filter if it has one. */
function ciTriggers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let inOn = false;
  let current: string | null = null;
  let inBranches = false;
  for (const { text } of live("ci.yml")) {
    if (/^on:\s*$/.test(text)) {
      inOn = true;
      continue;
    }
    if (!inOn) continue;
    if (/^\S/.test(text)) break;
    const event = /^ {2}([a-z_]+):\s*$/.exec(text);
    if (event) {
      current = event[1];
      out[current] = [];
      inBranches = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}branches:\s*$/.test(text)) {
      inBranches = true;
      continue;
    }
    if (/^ {4}\S/.test(text)) inBranches = false;
    const branch = /^ {6}- ([^\s#]+)\s*$/.exec(text);
    if (inBranches && branch) out[current].push(branch[1]);
  }
  return out;
}

function assertCiJobLedger() {
  const why =
    "On 2026-10-19 a split of ci.yml from 4 jobs a run to 8 took the median billed minutes per run from 9 to 16 and the day " +
    "from 1,189 to 2,397 minutes, with nothing pinning it. Change CI_JOBS_BY_EVENT in tests/ci-runner-switch.test.ts — the " +
    "jobs AND billedPerRun AND its dated note — in the same PR, so the cost is read before the merge.";

  // Every trigger is a source of runs, so a new one is a new line on the bill.
  assert.deepEqual(
    ciTriggers(),
    CI_TRIGGERS,
    `ci.yml's triggers changed. Each trigger adds runs, and each run bills CI_JOBS_BY_EVENT's minutes. ${why}`,
  );

  const jobs = ciJobs();
  assert.ok(jobs.length >= 5, `expected to parse at least five ci.yml jobs, found ${jobs.length} — the job parser has stopped matching`);

  const derived: Record<EventKey, { jobs: string[]; optional: string[] }> = {
    pull_request: { jobs: [], optional: [] },
    push: { jobs: [], optional: [] },
    workflow_dispatch: { jobs: [], optional: [] },
  };
  for (const job of jobs) {
    const legs = job.matrix ? job.matrix.map((v) => `${job.id} (${v})`) : [job.id];
    const { always, optional } = eventsFor(job);
    for (const event of always) derived[event].jobs.push(...legs);
    for (const event of optional) derived[event].optional.push(...legs);
  }

  for (const event of ALL_EVENTS) {
    const entry = CI_JOBS_BY_EVENT[event];
    assert.deepEqual(
      [...derived[event].jobs].sort(),
      [...entry.jobs].sort(),
      `ci.yml now runs ${derived[event].jobs.length} job(s) on \`${event}\` (${derived[event].jobs.join(", ")}) but the ledger ` +
        `prices ${entry.jobs.length} (${entry.jobs.join(", ")}). ${why}`,
    );
    assert.deepEqual(
      [...derived[event].optional].sort(),
      [...(entry.optional ?? [])].sort(),
      `ci.yml's optional jobs on \`${event}\` (${derived[event].optional.join(", ") || "none"}) differ from the ledger's ` +
        `(${(entry.optional ?? []).join(", ") || "none"}). ${why}`,
    );
    const note = NOTE_SHAPE.exec(entry.note);
    assert.ok(
      note,
      `CI_JOBS_BY_EVENT.${event}.note must read "YYYY-MM-DD: … <n> billed min/run …" — the date it was measured and the ` +
        `number. It reads: ${entry.note}`,
    );
    assert.equal(
      Number(note[1]),
      entry.billedPerRun,
      `CI_JOBS_BY_EVENT.${event}: billedPerRun is ${entry.billedPerRun} but its note says ${note[1]} billed min/run. Change ` +
        `the two together, so the number always has a date and a source.`,
    );
  }
}
