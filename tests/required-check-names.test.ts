import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The required-check list must not drift between branch protection, the workflows that produce the
 * checks, and the files a session reads in order to merge.
 *
 * WHY THIS EXISTS. The list has changed four times — 4 → 5 → 6 → 4 — and after every single change
 * the repository went on stating the old one:
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
 * Node builtins only, and no YAML parser — the same rule tests/ci-gate-parity.test.ts records at its
 * line 125. Job ids are read as top-level two-space keys under `jobs:`, which is how ci-gate-parity
 * already reads them.
 */
const WORKFLOW_DIR = ".github/workflows";

/** The three names that stopped being checks on 2026-09-27 (#4527). */
const RETIRED_CHECK_NAMES = ["lint", "typecheck", "test"] as const;

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
 * The list AGENTS.md §2 declares: "branch-protected with **N required checks** — `a`, `b`, `c`, `d`".
 * Parsed rather than restated, so the count and the names cannot disagree with each other — the
 * exact shape tests/supabase-project-refs.test.ts uses to hold AGENTS.md §3's project table.
 */
function declaredRequiredChecks(agents: string): { count: number; names: string[] } {
  const bullet = agents
    .split("\n")
    .find((line) => /branch-protected with \*\*\d+ required checks\*\*/.test(line));
  assert.ok(
    bullet,
    "AGENTS.md §2 must carry a bullet reading `branch-protected with **N required checks** — `a`, `b`, …`. " +
      "It is the declaration every other file in the repo is held against; without it this test proves nothing.",
  );
  const count = Number(/\*\*(\d+) required checks\*\*/.exec(bullet)![1]);
  // Only the names BEFORE the first semicolon: `allow_auto_merge: false` and the rot warning follow.
  const listPart = bullet.slice(bullet.indexOf("required checks**")).split(";")[0];
  const names = [...listPart.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
  return { count, names };
}

export function runRequiredCheckNamesTests() {
  const agents = readFileSync("AGENTS.md", "utf8");
  const { count, names } = declaredRequiredChecks(agents);

  // ── 1. The declaration must be internally consistent ────────────────────────────────────────
  assert.ok(names.length >= 3, `expected AGENTS.md §2 to name at least three required checks, parsed ${names.length}`);
  assert.equal(
    names.length,
    count,
    `AGENTS.md §2 says **${count} required checks** but names ${names.length} (${names.join(", ")}). ` +
      "The count is the half of this sentence that has rotted every single time — it has been 4, 5, 6 and 4 again.",
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
