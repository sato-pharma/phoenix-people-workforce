import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * CI <-> package.json gate parity.
 *
 * `ci` is a package.json-only string; `.github/workflows/ci.yml` re-lists the same gate steps
 * separately. The two silently diverge: a `check:*` added to the `ci` script alone NEVER runs on a
 * PR (it needs BOTH edits). This test pins it: every `check:*` step the gate runs must also appear
 * in at least one workflow file.
 *
 * There used to be a second assertion here, that `ci` and `check:harden` were byte-identical. That
 * mattered while `check:harden` was the local pre-push gate and a green local run was supposed to
 * predict a green PR. `check:harden` was retired on 2026-08-18 — the workflow is the only gate now,
 * so there is no second string left to keep in lockstep, and `ci` is kept purely as the one-shot
 * way to run the whole thing by hand.
 *
 * Scope is deliberately the `check:*` steps only. lint / typecheck / test / build have their own CI
 * jobs invoked in varied ways (e.g. the runner runs as its own process, not `pnpm run test`), so a
 * strict `pnpm run <step>` match there would false-positive.
 */
const WORKFLOW_DIR = ".github/workflows";

export function runCiGateParityTests() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const ciScript = pkg.scripts?.ci ?? "";
  assert.ok(ciScript.length > 0, "package.json must define a `ci` script");

  // Retired, and pinned so it does not quietly come back as a second gate to keep in sync.
  assert.equal(
    pkg.scripts?.["check:harden"],
    undefined,
    "`check:harden` was retired on 2026-08-18 — the CI workflow is the gate. Reintroducing it " +
      "recreates the divergence trap this test exists to catch.",
  );

  const gateChecks = Array.from(new Set(ciScript.match(/\bcheck:[a-z0-9-]+/gi) ?? [])).sort();
  assert.ok(gateChecks.length > 0, "expected the `ci` script to run at least one check:* step");

  const workflowText = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => readFileSync(path.join(WORKFLOW_DIR, name), "utf8"))
    .join("\n");

  const missing = gateChecks.filter((check) => !workflowText.includes(check));
  assert.deepEqual(
    missing,
    [],
    `these check:* steps run in the package.json \`ci\` gate but appear in NO ` +
      `${WORKFLOW_DIR}/*.yml file, so they NEVER run on a PR: [${missing.join(", ")}]. ` +
      `Add each to a workflow — the workflow is the only thing that actually gates a merge.`,
  );
}

/**
 * The docs-only fast path must never let a change to the AUTO-LOADED INSTRUCTION FILES skip the
 * suite that polices them.
 *
 * WHY THIS EXISTS. Each of `validate` / `lint` / `typecheck` / `test` answers, inline, whether the
 * PR is documentation only, and skips its expensive steps when it is. The classification counted
 * every `*.md` and every `docs/` path as inert. But three tests in the `test` job exist ONLY to
 * police the auto-loaded files — `autoload-footprint-budget` (CLAUDE.md + AGENTS.md against the
 * enforced byte budget), `memory-index-reachability` (a memory slug orphaned by an AGENTS.md edit),
 * and `agents-long-hooks-cite-docs` (AGENTS.md hooks must point at a docs/ account). Measured on PR
 * #4147 (AGENTS.md + docs/agents-*.md only): the `test` job reported success in 8 seconds with
 * every real step SKIPPED. So the moment someone grew AGENTS.md past budget or orphaned a memory,
 * the checks that would catch it skipped, the PR went green on five of six required checks, and a
 * merge to `main` ships to production immediately (§2 / §2.1) — the failure surfacing only
 * afterwards as a red `main`, which still builds and serves.
 *
 * The fix makes those files NOT count as inert docs. This test proves the shipped classifier's
 * BEHAVIOUR, not its source text: it lifts the real decision out of `ci.yml` — the two `grep`
 * conditions verbatim — and RUNS them (through the same `bash`/`grep` the runner uses) against a
 * table of changed-file lists, asserting the docs_only verdict for each. A reverted or weakened
 * fix flips a verdict and fails here. It also pins that all four copies of the step stay identical,
 * because the step is duplicated per job and the four must not drift.
 */

/** The changed-file lists and the docs_only verdict the classifier must return for each. */
const DOCS_ONLY_CASES: ReadonlyArray<{ files: string[]; docsOnly: boolean; why: string }> = [
  // Auto-loaded instruction files — policed by the `test` job, so they must run the full suite.
  { files: ["AGENTS.md"], docsOnly: false, why: "AGENTS.md is graded by the footprint + reachability tests" },
  { files: ["CLAUDE.md"], docsOnly: false, why: "CLAUDE.md is graded by the footprint budget test" },
  { files: ["docs/agents-owner-rules.md"], docsOnly: false, why: "docs/agents-*.md holds the auto-loaded accounts" },
  { files: ["docs/agents-session-traps.md"], docsOnly: false, why: "docs/agents-*.md holds the auto-loaded accounts" },
  { files: ["AGENTS.md", "README.md"], docsOnly: false, why: "one policed file is enough to force the suite" },
  // Genuinely inert docs — the fast path must survive for these, or the fix is worthless.
  { files: ["README.md"], docsOnly: true, why: "a plain README that no test asserts on" },
  { files: ["docs/architecture.md"], docsOnly: true, why: "an ordinary docs/ page, not an agents- account" },
  { files: ["docs/foo/bar.md", "docs/other.md"], docsOnly: true, why: "several inert docs/ pages" },
  // Code and config always ran the suite; that must not regress.
  { files: ["src/lib/payroll/policy.ts"], docsOnly: false, why: "source code" },
  { files: [".github/workflows/ci.yml"], docsOnly: false, why: "the workflow itself is config, not a doc" },
];

/**
 * Extract every copy of the docs-only decision from `ci.yml` — the two `if … grep …` blocks plus
 * the final `answer true`. All copies are meant to be byte-identical; this returns them all so the
 * caller can assert that and then execute one.
 */
function extractDocsOnlyDecisions(ciYml: string): string[] {
  const re =
    /if echo "\$files" \| grep -qE '\(\^AGENTS[\s\S]*?answer true "documentation only"/g;
  return ciYml.match(re) ?? [];
}

/**
 * The jobs that actually gate a step on `docs_only`, read out of `ci.yml` itself.
 *
 * DERIVED, NOT HARD-CODED, AND THAT IS THE POINT. This assertion used to read `=== 4`, naming
 * validate/lint/typecheck/test. Merging lint+typecheck+test into one `checks` job (2026-09-27, to
 * stop paying GitHub's per-job minute rounding four times) legitimately took it to 2, and a
 * hard-coded count cannot tell that apart from a copy being DELETED — which is the thing this test
 * exists to catch. Counting the jobs that consume the decision keeps the real invariant: every job
 * that takes the fast path must carry the full classifier.
 *
 * `mobile` is deliberately not counted. It has an `id: detect` step too, but it answers
 * `mobile_changed`, not `docs_only`, so it is not a docs-only job — which is why counting
 * `id: detect` (3) would be wrong where counting the consumers (2) is right.
 *
 * Node builtins only: this file has no YAML parser and must not grow one.
 */
function jobsGatedOnDocsOnly(ciYml: string): string[] {
  const lines = ciYml.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  // Only look below `jobs:` — `on:` also has two-space keys (`pull_request:`, `push:`).
  const body = start === -1 ? [] : lines.slice(start + 1);
  const gated: string[] = [];
  let job: string | null = null;
  let uses = false;
  const flush = () => {
    if (job && uses) gated.push(job);
  };
  for (const line of body) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      flush();
      job = header[1];
      uses = false;
      continue;
    }
    if (job && line.includes("steps.detect.outputs.docs_only")) uses = true;
  }
  flush();
  return gated;
}

export function runCiDocsOnlyClassifierTests() {
  const ciYml = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");

  // Every job that gates a step on `docs_only` must answer the question inline, with the full
  // classifier. A job missing its copy would take the fast path and skip the tests that police the
  // auto-loaded instruction files; a count that no longer matches means a copy was removed or the
  // fix never landed in all of them. Either way the guarantee is broken.
  const decisions = extractDocsOnlyDecisions(ciYml);
  const gated = jobsGatedOnDocsOnly(ciYml);
  assert.ok(
    gated.length >= 2,
    `expected at least two jobs gating on docs_only (validate plus the lint/typecheck/test job), ` +
      `found ${gated.length}: ${gated.join(", ") || "none"}. Zero would make the equality below ` +
      `pass vacuously with every classifier deleted.`,
  );
  assert.equal(
    decisions.length,
    gated.length,
    `expected one identical docs-only decision block per job that gates on it — ${gated.length} ` +
      `job(s): ${gated.join(", ")} — but found ${decisions.length} block(s). The block must lead ` +
      `with \`grep -qE '(^AGENTS\\.md$|^CLAUDE\\.md$|^docs/agents-.*\\.md$)'\` before the ` +
      `inert-docs check, in EVERY copy — a change to AGENTS.md/CLAUDE.md/docs/agents-*.md must not ` +
      `take the docs-only fast path, or the tests that police those files skip and a red rule merges.`,
  );

  // The copies must not drift. The step is duplicated per job on purpose (a shared `changes` job
  // cost a billed minute on every run); the price of that is four copies that must stay identical.
  assert.equal(
    new Set(decisions).size,
    1,
    "the four docs-only decision blocks have drifted apart — they must be byte-identical, or one " +
      "job classifies a PR differently from another. Fix every copy the same way.",
  );

  const decision = decisions[0];
  // Both halves must be present, or the block is only half a gate.
  assert.match(
    decision,
    /grep -qE '\(\^AGENTS\\\.md\$\|\^CLAUDE\\\.md\$\|\^docs\/agents-\.\*\\\.md\$\)'/,
    "the policed-file check must match AGENTS.md, CLAUDE.md and docs/agents-*.md exactly",
  );
  assert.match(
    decision,
    /grep -qvE '\(\\\.md\$\|\^docs\//,
    "the original inert-docs check must still follow the policed-file check (the fast path is kept)",
  );

  // Run the REAL decision, not a re-implementation: stub `answer` to print its verdict word, inject
  // each sample file list through an env var (so stdin carries only the script), and execute the
  // extracted block under the same bash/grep the GitHub runner uses. `answer` exits on first call,
  // so the printed word is exactly the classifier's docs_only result.
  const run = (files: string[]): string => {
    const script = `answer() { printf '%s' "$1"; exit 0; }\nfiles="$PHX_FILES"\n${decision}\n`;
    return execFileSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PHX_FILES: files.join("\n") },
    }).trim();
  };

  for (const { files, docsOnly, why } of DOCS_ONLY_CASES) {
    const verdict = run(files);
    assert.ok(
      verdict === "true" || verdict === "false",
      `the classifier returned "${verdict}" for [${files.join(", ")}] — expected the literal ` +
        `token from an \`answer\` call. bash/grep may be unavailable on this runner.`,
    );
    assert.equal(
      verdict,
      String(docsOnly),
      `docs_only for [${files.join(", ")}] should be ${docsOnly} (${why}), but the shipped ci.yml ` +
        `classifier returned ${verdict}. ` +
        (docsOnly
          ? "The fast path must survive for genuinely inert docs."
          : "This change must run the full suite; the docs-only fast path would skip the checks that police it."),
    );
  }
}
