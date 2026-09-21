import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The docs-only fast path must never skip the tests that police the docs.
 *
 * `.github/workflows/ci.yml` answers `docs_only=true` when every file a PR changed is Markdown or
 * lives under `docs/`, and each of the four gate jobs — validate, lint, typecheck, test — then
 * skips its real steps. That is a good trade for a typo fix in a README.
 *
 * It was a silent hole for the instruction files. Three registered tests exist for the sole purpose
 * of policing them:
 *
 *   - tests/autoload-footprint-budget.test.ts     grades CLAUDE.md + AGENTS.md against the budget
 *   - tests/memory-index-reachability.test.ts     catches a memory slug orphaned by an AGENTS.md edit
 *   - tests/agents-long-hooks-cite-docs.test.ts   reads AGENTS.md
 *
 * All three live in the `test` job. So editing AGENTS.md — the one change those tests exist to
 * check — classified as documentation-only and skipped them. Measured on PR #4147 (2026-09-21):
 * AGENTS.md grew by 362 bytes and FIVE of the six required checks did no work; only `secret-scan`
 * executed. `test` reported success in 8 seconds with Corepack / Node / Install / Test all skipped.
 * Because a merge to `main` ships to production immediately, the failure would surface as a red
 * `main` after the fact rather than as a blocked merge.
 *
 * This test does not check for a magic string. It extracts the two live patterns out of the
 * workflow and RUNS the classifier's own logic against real paths, so it fails if the behaviour
 * changes however the YAML is reworded. It also derives the list of doc inputs from the three
 * tests above rather than hardcoding it: add a new instruction file to one of them without
 * covering it in the gate, and this goes red.
 */
const WORKFLOW = ".github/workflows/ci.yml";

/** The exact step name each gated job repeats. `mobile` has a different detector of its own. */
const DETECT_STEP = "- name: Detect whether this PR is documentation only";

/** The gate jobs that carry the docs-only classifier. `mobile` uses a different detector. */
const GATED_JOBS = 4;

/** The tests whose inputs must never be skipped. Their .md references drive the coverage check. */
const INSTRUCTION_FILE_TESTS = [
  "tests/autoload-footprint-budget.test.ts",
  "tests/memory-index-reachability.test.ts",
  "tests/agents-long-hooks-cite-docs.test.ts",
];

type Classifier = { nonDoc: RegExp; instructionFile: RegExp };

/**
 * Pull each detect step's two greps out of the workflow. Both are plain EREs that happen to be
 * valid JavaScript regexes, so they can be executed here exactly as the shell runs them.
 */
function readClassifiers(yaml: string): Classifier[] {
  // Anchor on the step NAME, not on `echo "Changed files:"` — the mobile job prints that line too
  // from its own, different detector ("touches mobile/"), and catching it here would compare this
  // guard against a step that was never meant to have it.
  const blocks = yaml.split(DETECT_STEP).slice(1);
  return blocks.map((block, index) => {
    const body = block.split('answer true "documentation only"')[0] ?? "";
    const nonDoc = /grep -qvE '([^']+)'/.exec(body)?.[1];
    const instructionFile = /grep -qE '([^']+)'/.exec(body)?.[1];

    assert.ok(
      nonDoc,
      `detect step #${index + 1} in ${WORKFLOW} has no \`grep -qvE\` non-doc pattern`,
    );
    assert.ok(
      instructionFile,
      `detect step #${index + 1} in ${WORKFLOW} does not guard the instruction files. An ` +
        `AGENTS.md-only PR would classify as documentation-only and skip the very tests that ` +
        `exist to police AGENTS.md. Every copy of the detect step needs the guard, not just one.`,
    );

    return { nonDoc: new RegExp(nonDoc), instructionFile: new RegExp(instructionFile) };
  });
}

/** Reproduces the shell classifier: `grep -qvE` succeeds if ANY path fails to match. */
function isDocsOnly(classifier: Classifier, files: string[]): boolean {
  if (files.length === 0) return false;
  if (files.some((file) => !classifier.nonDoc.test(file))) return false;
  if (files.some((file) => classifier.instructionFile.test(file))) return false;
  return true;
}

/** Every .md path those tests name that really exists in the working tree. */
function derivedDocInputs(): string[] {
  const found = new Set<string>();
  for (const testFile of INSTRUCTION_FILE_TESTS) {
    assert.ok(existsSync(testFile), `${testFile} is missing — update INSTRUCTION_FILE_TESTS`);
    const text = readFileSync(testFile, "utf8");
    for (const match of text.matchAll(/["'`]([A-Za-z0-9_./-]+\.md)["'`]/g)) {
      const candidate = match[1];
      // Fixture names ("a.md", "gone.md") and files outside the repo (MEMORY.md lives in the
      // Claude memory directory) never appear in a PR's file list, so they cannot affect the gate.
      if (candidate && existsSync(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
}

export function runDocsOnlyGateCoversInstructionFilesTests() {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const classifiers = readClassifiers(yaml);

  assert.equal(
    classifiers.length,
    GATED_JOBS,
    `expected ${GATED_JOBS} docs-only detect steps in ${WORKFLOW} (validate, lint, typecheck, ` +
      `test) but found ${classifiers.length}. The step is duplicated per job on purpose; a fix ` +
      `applied to only some copies leaves the hole open on the rest.`,
  );

  const docInputs = derivedDocInputs();
  assert.ok(
    docInputs.includes("AGENTS.md") && docInputs.includes("CLAUDE.md"),
    `expected to derive at least AGENTS.md and CLAUDE.md from ${INSTRUCTION_FILE_TESTS.join(", ")}` +
      `, got [${docInputs.join(", ")}]. If those tests stopped reading them, this test is ` +
      `no longer measuring anything.`,
  );

  classifiers.forEach((classifier, index) => {
    const job = `detect step #${index + 1}`;

    // 1. Every doc the instruction tests actually read must force the suite to run.
    for (const file of docInputs) {
      assert.equal(
        isDocsOnly(classifier, [file]),
        false,
        `${job}: a PR changing only ${file} still classifies as documentation-only, so the ` +
          `tests that read it are skipped. That is the hole measured on PR #4147.`,
      );
    }

    // 2. One instruction file among inert docs is still enough to need the suite.
    assert.equal(
      isDocsOnly(classifier, ["README.md", "docs/architecture.md", "AGENTS.md"]),
      false,
      `${job}: AGENTS.md alongside inert docs must still run the suite`,
    );

    // 3. The fast path must survive — this fix is not an excuse to abolish it.
    assert.equal(
      isDocsOnly(classifier, ["README.md"]),
      true,
      `${job}: a README-only PR should still take the fast path; the point is to narrow the ` +
        `skip, not to remove it.`,
    );
    assert.equal(
      isDocsOnly(classifier, ["docs/architecture.md", "docs/deployment.md"]),
      true,
      `${job}: ordinary docs/ pages should still take the fast path`,
    );

    // 4. Code still runs everything, as it always did.
    assert.equal(
      isDocsOnly(classifier, ["src/lib/payroll/policy.ts"]),
      false,
      `${job}: a code change must never classify as documentation-only`,
    );
    assert.equal(
      isDocsOnly(classifier, ["README.md", "src/app/page.tsx"]),
      false,
      `${job}: one code path among docs must run the full suite`,
    );
  });
}
