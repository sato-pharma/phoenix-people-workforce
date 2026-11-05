// EVERY CI JOB READS ONE SWITCH — `${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}` — AND ONLY THE JOBS
// THAT NEED GITHUB'S OWN x64 MACHINES WITH DOCKER KEEP THE LITERAL.
//
// WHY THIS EXISTS. From 2026-10-19 every `runs-on` was the literal `ubuntu-latest`: the owner retired the
// self-hosted Hetzner box that day ("make all ci actions to be on github"). On 2026-11-05 he reversed that:
// the repository is on GitHub's FREE plan, November's 2,000 included Actions minutes were spent by the 5th,
// the spending limit is $0 and there is no money to raise it, so GitHub refuses to START every hosted job —
// and the release gate holds every production deploy until `checks` passes. Self-hosted minutes are not
// billed, so CI moves to a free Oracle Cloud ARM64 machine (scripts/setup-self-hosted-runner.sh). The
// switch is ONE repository variable: `CI_RUNNER_LABEL` = `phoenix-ci` sends every switchable job there;
// unset, the expression falls back to `ubuntu-latest` and nothing changes. This file pins that shape:
//
//   1. Every `runs-on` is EXACTLY the switch expression — not a variant, not a bare label, not a
//      different variable — so one variable moves all of CI and deleting it moves all of CI back.
//   2. The jobs in HOSTED_ONLY, and only those, keep the literal `ubuntu-latest` with a
//      `# hosted-only: <reason>` comment. Each builds, pulls or pushes the amd64 production or tablet-server
//      image with Docker: on an ARM64 machine with no Docker that image cannot be built or pulled the way
//      Railway and Fly.io run it. A HOSTED_ONLY entry with no matching job fails too, so the list cannot rot.
//   3. `CI_RUNNER_LABEL` is read nowhere but inside that expression, and the retired `CI_SELF_HOSTED`
//      nowhere at all — so the variable means one thing everywhere.
//   4. `runner.environment == 'self-hosted'` keys nothing: a step that behaves differently on the machine
//      is a second switch nobody reads. Make the step itself work on both (as `Install gitleaks` does
//      with RUNNER_ARCH) instead.
//
// 🔴 A LABEL THAT MATCHES NO ONLINE RUNNER DOES NOT FALL BACK — THE JOB QUEUES, WITH NOTHING RED. If the
// machine is down, DELETE the variable; the next run is GitHub-hosted again.
// Account and runbook: docs/ci-self-hosted-runner.md.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = ".github/workflows";
const HOSTED = "ubuntu-latest";
export const RUNNER_SWITCH = "${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}";

/** Workflows left exactly as they were on 2026-11-05, every job on the literal hosted label. */
const HOSTED_WORKFLOWS = new Set(["mobile-build.yml", "mobile-ota.yml"]);

/** file → job ids that must stay on GitHub's x64 runners, with the reason (2026-11-05). */
export const HOSTED_ONLY: Record<string, Record<string, string>> = {
  "fallback-image.yml": { image: "builds the amd64 production image with Docker" },
  "emergency-host.yml": {
    gate: "reads the image registry with Docker",
    standby: "pulls and pushes the amd64 image with Docker",
  },
  "headwind-image.yml": { build: "builds the amd64 tablet-server image with Docker" },
};

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
  let switched = 0;
  const hostedSeen = new Set<string>();
  const files = workflowFiles();

  for (const file of files) {
    let inJobs = false;
    let job: string | null = null;
    for (const { line, text } of live(file)) {
      if (/^jobs:\s*$/.test(text)) inJobs = true;
      else if (inJobs) {
        const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(text);
        if (id) job = id[1];
      }

      const runsOn = /^\s*runs-on:\s*(.*?)\s*(?:#\s*(.*))?$/.exec(text);
      if (runsOn) {
        runsOnLines += 1;
        const value = runsOn[1];
        const comment = runsOn[2] ?? "";
        const hostedReason = job ? HOSTED_ONLY[file]?.[job] : undefined;
        if (HOSTED_WORKFLOWS.has(file)) {
          // 2 — whole workflows left untouched keep the literal.
          assert.equal(value, HOSTED, `${file}:${line} must keep the literal \`runs-on: ${HOSTED}\`; this workflow is not switched.`);
        } else if (hostedReason) {
          // 2 — a hosted-only job keeps the literal AND says why, on the line itself.
          hostedSeen.add(`${file}#${job}`);
          assert.equal(
            value,
            HOSTED,
            `${file}:${line} (job \`${job}\`) must stay on the literal \`${HOSTED}\`: it ${hostedReason}, which the ARM64 ` +
              `self-hosted machine cannot do the way Railway and Fly.io run it.`,
          );
          assert.match(
            comment,
            /^hosted-only: \S/,
            `${file}:${line} (job \`${job}\`) keeps the literal \`${HOSTED}\` but carries no \`# hosted-only: <reason>\` ` +
              `comment, so the next reader cannot tell it was left on GitHub's runners on purpose.`,
          );
        } else {
          // 1 — every other job reads exactly the one switch.
          switched += 1;
          assert.equal(
            value,
            RUNNER_SWITCH,
            `${file}:${line} (job \`${job}\`) reads \`runs-on: ${value}\`, not \`${RUNNER_SWITCH}\`. Every job reads that ONE ` +
              `switch (owner, 2026-11-05: the free plan's Actions minutes ran out, so CI runs on a free self-hosted machine ` +
              `while CI_RUNNER_LABEL is set). A job that must stay on GitHub's runners goes in HOSTED_ONLY in ` +
              `tests/ci-runner-switch.test.ts with its reason, and wears \`# hosted-only: <reason>\` on the line.`,
          );
        }
        continue;
      }

      // 3 — the variable is read nowhere but on a runs-on line, and the retired one nowhere.
      assert.ok(
        !/\b(CI_SELF_HOSTED|CI_RUNNER_LABEL|vars\.CI_RUNNER\b)/.test(text),
        `${file}:${line} reads a runner-switch variable outside \`runs-on\`: ${text.trim()}. CI_RUNNER_LABEL means one thing ` +
          `— which machine runs the job — and CI_SELF_HOSTED was retired with the Hetzner box on 2026-10-19.`,
      );
      // 4 — and the runtime property is never a second switch.
      assert.ok(
        !/runner\.environment\s*==\s*'self-hosted'/.test(text),
        `${file}:${line} branches on \`runner.environment == 'self-hosted'\`: ${text.trim()}. Make the step work on both ` +
          `machines instead (key on RUNNER_ARCH, as \`Install gitleaks\` in security-scan.yml does).`,
      );
    }
  }

  // Every HOSTED_ONLY entry names a job that exists, so the list cannot quietly outlive its jobs.
  for (const [file, jobs] of Object.entries(HOSTED_ONLY)) {
    assert.ok(files.includes(file), `HOSTED_ONLY names ${file}, which is not a workflow any more. Remove it.`);
    for (const job of Object.keys(jobs)) {
      assert.ok(
        hostedSeen.has(`${file}#${job}`),
        `HOSTED_ONLY names job \`${job}\` in ${file}, but no such job carries a runs-on line. Remove the entry.`,
      );
    }
  }
  for (const file of HOSTED_WORKFLOWS) {
    assert.ok(files.includes(file), `HOSTED_WORKFLOWS names ${file}, which is not a workflow any more. Remove it.`);
  }

  // The scan above must have looked at something, or an empty directory would pass it.
  assert.ok(runsOnLines >= 20, `expected at least 20 \`runs-on\` lines across the workflows, found ${runsOnLines}`);
  assert.ok(switched >= 20, `expected at least 20 jobs on the runner switch, found ${switched}`);

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
