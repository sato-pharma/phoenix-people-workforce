import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The parse and the retired-name list come from the SHARED module, not a copy. `scripts/
// check-required-checks.mjs` holds the same declaration against the LIVE gate, and two copies of this
// parse could disagree about what AGENTS.md says — which is the exact class of drift this area exists
// to stop. Importing the real thing also means this test drives the parse the script uses.
import { RETIRED_CHECK_NAMES, declaredRequiredChecks } from "../scripts/required-check-names.mjs";

/**
 * The required-check list must not drift between branch protection, the workflows that produce the
 * checks, and the files a session reads in order to merge.
 *
 * WHY THIS EXISTS. The list has changed five times — 4 → 5 → 6 → 4 → 2 — and after every single
 * change the repository went on stating the old one:
 *
 *   2026-09-17 (#3950)  the unit suite left `validate` for its own `test` job, and nobody added the
 *                       new name to protection. For a day a RED unit suite showed four green
 *                       required checks and merged. Fixed 09-18 by adding `test` and `mobile`.
 *   2026-09-27 (#4527)  `lint`, `typecheck` and `test` were folded into one `checks` job (GitHub
 *                       rounds every job up to the minute, so three jobs paid that rounding three
 *                       times). Protection was repointed at `checks` in the same window, and those
 *                       three names STOPPED EXISTING as check names. Nineteen places in the repo
 *                       still said "6 required checks" afterwards — including `.claude/skills/ship`
 *                       and `.claude/skills/verify-context`, the two files a session follows in
 *                       order to merge. A session followed `ship`, counted to six, and waited on
 *                       three checks that can never report again.
 *   2026-09-29          `mobile` and `secret-scan` were demoted DELIBERATELY, minutes before #4800
 *                       took them off the pull request. Those two steps are always one change: a
 *                       required check whose job stops reporting leaves every PR on "Expected —
 *                       waiting for status" and nothing can merge, while un-wiring the job first
 *                       leaves a gate that no longer gates. Not rot, then — but it is the shape
 *                       this test CANNOT see, and the reason clause 3 does not police it: the job
 *                       ids did not change, so no offline signal existed at all. Only the live half
 *                       caught the doc lag (`scripts/check-required-checks.mjs`), by being run.
 *
 * So there are two failure directions, and they are opposites:
 *   - a check that protection names but nothing produces blocks every PR forever;
 *   - a check a DOC names but protection does not makes a session wait for nothing.
 * This test cannot see branch protection (CI has no `gh` auth for it, and a test that hard-coded the
 * answer would defend a stale claim rather than catch one — that mistake is recorded in
 * tests/supabase-project-refs.test.ts). What it CAN hold is the half that lives in files: AGENTS.md
 * declares the list, every name it declares must be produced by a real job, the retired names must
 * not have quietly come back as jobs, and no file a session ACTS on may still name a retired check
 * as a gate.
 *
 * 🔴 SO A GREEN HERE IS NOT PROOF THAT THE DOCUMENTED LIST MATCHES THE GATE. It proves the docs and
 * the workflows agree with EACH OTHER. Repoint protection to a fifth arrangement and leave every doc
 * and job name mutually consistent, and this test stays green while every doc misstates the real
 * gate — the same failure it exists to prevent, one level up. `RETIRED_CHECK_NAMES` below is a
 * hand-maintained literal for the same reason, and whoever does the next rename has to extend it.
 * Nothing inside a test run can close that, deliberately: a live `gh api` read would make a REQUIRED
 * check depend on network and auth, so it would have to fail open, and a check that fails open is not
 * something to rely on. The durable half is the instruction in AGENTS.md §2 and the ship skill — read
 * `branches/main/protection/required_status_checks` live and count passes against what it returns,
 * never this file's verdict and never a number from a doc.
 *
 * Node builtins only, and no YAML parser — the same rule tests/ci-gate-parity.test.ts records at its
 * line 125. Job ids are read as top-level two-space keys under `jobs:`, which is how ci-gate-parity
 * already reads them.
 */
const WORKFLOW_DIR = ".github/workflows";

/** The live-gate half, which this test cannot perform and must not be mistaken for. */
const LIVE_CHECK_SCRIPT = "scripts/check-required-checks.mjs";

/**
 * Files a session ACTS on. A doc that narrates the history may — must, in fact — mention the retired
 * names; these five are the ones that tell a session what to wait for, so a retired name inside a
 * sentence about required checks here is the defect that cost a real wait.
 */
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/skills/ship/SKILL.md",
  ".claude/skills/verify-context/SKILL.md",
  ".github/pull_request_template.md",
];

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/** Top-level job ids in one workflow file: two-space keys after the `jobs:` line. */
function jobIds(source: string): string[] {
  const out: string[] = [];
  let inJobs = false;
  for (const line of source.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // a new top-level key ends the jobs block
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

/**
 * AGENTS.md §2's declaration, through the SHARED parse. The module returns a named `error` rather
 * than throwing, so the failure is phrased here for a test reader and in the script for its own.
 */
function declared(agents: string): { count: number; names: string[] } {
  const parsed = declaredRequiredChecks(agents);
  assert.ok(
    !parsed.error,
    `${parsed.error}\n  (parsed by scripts/required-check-names.mjs, which ${LIVE_CHECK_SCRIPT} shares)`,
  );
  return { count: parsed.count as number, names: parsed.names as string[] };
}

export function runRequiredCheckNamesTests() {
  const agents = readFileSync("AGENTS.md", "utf8");
  const { count, names } = declared(agents);

  // ── 0. THE LIVE HALF MUST EXIST AND BE WIRED, because this test cannot perform it ────────────
  // Everything below compares the docs to the WORKFLOWS. Nothing below reads branch protection, so a
  // green here never proves the documented list matches the gate. That half is
  // scripts/check-required-checks.mjs, reported by repo-doctor. If it is deleted or unwired, this
  // test keeps passing and the only thing that checks the real gate is gone — silently, which is how
  // the list rotted four times.
  assert.ok(
    existsSync(LIVE_CHECK_SCRIPT),
    `${LIVE_CHECK_SCRIPT} is missing. It is the ONLY thing that compares AGENTS.md §2 to what branch `
      + "protection actually requires; this test only compares the docs to the workflows, so without it a "
      + "green here means the docs and the workflows agree with each other and nothing more.",
  );
  const doctor = readFileSync("scripts/repo-doctor.mjs", "utf8");
  assert.ok(
    doctor.includes("required-check-names.mjs") && doctor.includes("REQUIRED CHECKS"),
    "scripts/repo-doctor.mjs must run the live required-check comparison and print it under a "
      + "REQUIRED CHECKS heading. A live check nobody runs is not a check — repo-doctor is where it "
      + "surfaces without being remembered, and it already pages a live API so it is the right home.",
  );

  // 🔴 AND IT MUST RUN ON A SCHEDULE, because repo-doctor alone was not enough and the reason is
  // specific: `repo-doctor.mjs` pages the PRODUCTION GoTrue admin API by default, so sessions are
  // told to pass `--no-auth` — and `--no-auth` SKIPS this very comparison, printing
  // "REQUIRED CHECKS -> skipped (--no-auth)". So the live half was reachable only by a human
  // remembering to run repo-doctor WITHOUT that flag, against a gate that has rotted five times
  // (4 → 5 → 6 → 4 → 2). Wired into the daily configuration drift alarm on 2026-10-01.
  //
  // Asserted by npm-script name rather than by workflow filename, so the alarm can be renamed or the
  // step moved to a different schedule without going red — what must not happen is the comparison
  // going back to running only when somebody remembers it.
  const scheduledWorkflows = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, source: readFileSync(path.join(WORKFLOW_DIR, name), "utf8") }))
    .filter(({ source }) => /^\s*schedule:\s*$/m.test(source));

  const runsIt = scheduledWorkflows.filter(({ source }) => source.includes("check-required-checks.mjs")
    || source.includes("check:required-checks"));

  assert.ok(
    runsIt.length > 0,
    "🔴 no SCHEDULED workflow runs the live required-check comparison any more. repo-doctor is not a "
      + "substitute: it pages the production GoTrue admin API by default, so sessions run it with "
      + "`--no-auth`, and that flag skips this exact check. Without a schedule the only thing that "
      + "catches the next rotation depends on somebody remembering — which is how the list rotted "
      + `five times. Scheduled workflows seen: ${scheduledWorkflows.map((w) => w.name).join(", ")}`,
  );

  // ── 1. The declaration must be internally consistent ────────────────────────────────────────
  // The floor is a PARSER sanity check — it exists so a regex that silently matches nothing cannot
  // pass forever — and it is NOT a policy minimum. It read `>= 3` until 2026-09-29, when `mobile`
  // and `secret-scan` left protection and the real list became two, so the floor itself became a
  // second stale claim about the gate: exactly what this file exists to stop, one level down. Two
  // is the lowest the gate has ever actually been. If it ever goes to one, lower this and say so
  // here — never pad §2 with a name protection does not require in order to satisfy a test.
  assert.ok(names.length >= 2, `expected AGENTS.md §2 to name at least two required checks, parsed ${names.length}`);
  assert.equal(
    names.length,
    count,
    `AGENTS.md §2 says **${count} required checks** but names ${names.length} (${names.join(", ")}). ` +
      "The count is the half of this sentence that has rotted every single time — it has been 4, 5, 6, 4 and now 2.",
  );

  // ── 2. Every declared name must be produced by a real job ───────────────────────────────────
  // A required check nothing produces is never "not yet reported"; it blocks every PR forever.
  const jobsByFile = new Map<string, string[]>();
  for (const file of workflowFiles()) {
    jobsByFile.set(file, jobIds(readFileSync(path.join(WORKFLOW_DIR, file), "utf8")));
  }
  const allJobs = [...jobsByFile.values()].flat();
  assert.ok(allJobs.length > 10, `expected to parse job ids from the workflows, found ${allJobs.length}`);

  for (const name of names) {
    assert.ok(
      allJobs.includes(name),
      `AGENTS.md §2 names \`${name}\` as a required check, but no workflow in ${WORKFLOW_DIR} declares a job with that id. ` +
        "A required context that never reports does not fail a PR — it blocks every PR forever, with no red anywhere. " +
        `Jobs that do exist: ${[...new Set(allJobs)].sort().join(", ")}.`,
    );
  }

  // ── 3. The retired names must not have come back as jobs ────────────────────────────────────
  // If one does, its check name exists again while protection does not require it — the 2026-09-17
  // shape, where a red unit suite showed four green required checks and merged.
  for (const retired of RETIRED_CHECK_NAMES) {
    if (names.includes(retired)) continue; // deliberately re-required: nothing to police
    for (const [file, jobs] of jobsByFile) {
      assert.ok(
        !jobs.includes(retired),
        `${file} declares a job \`${retired}\`, which was retired as a check name on 2026-09-27 (#4527) and is NOT ` +
          `in AGENTS.md §2's required list (${names.join(", ")}). Either add it to branch protection and to §2 in the ` +
          "same window, or keep it a STEP of `checks`. A job whose name protection does not require reports a check " +
          "that gates nothing, and reads on a PR exactly like one that does.",
      );
    }
  }

  // ── 4. No file a session ACTS on may still name a retired check as a gate ───────────────────
  // History may name them; instructions may not. The stale shape was always the same: the word
  // "required" and the retired names in one sentence.
  for (const file of INSTRUCTION_FILES) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!/required/i.test(line)) return;
      // A sentence that explicitly records the retirement is the fix, not the defect. These files are
      // hard-wrapped, so the disclaimer routinely lands on the NEXT line — judging a single line
      // false-flags the very correction this test exists to enforce. Read the sentence, not the line.
      const sentence = [lines[index - 1] ?? "", line, lines[index + 1] ?? "", lines[index + 2] ?? ""].join(" ");
      if (/no longer|retired|stopped existing|2026-09-27|are STEPS|rotted|STEPS of/i.test(sentence)) return;
      for (const retired of RETIRED_CHECK_NAMES) {
        if (names.includes(retired)) continue;
        assert.doesNotMatch(
          line,
          new RegExp("`" + retired + "`"),
          `${file}:${index + 1} names \`${retired}\` in a sentence about required checks, but it stopped existing as a ` +
            "check name on 2026-09-27 (#4527) — it is a STEP of `checks` now. A session following this line waits for a " +
            `check that can never report. The required list is ${names.join(", ")}; read it live from ` +
            "`branches/main/protection/required_status_checks` rather than restating it here.\n" +
            `  ${line.trim()}`,
        );
      }
    });
  }
}
