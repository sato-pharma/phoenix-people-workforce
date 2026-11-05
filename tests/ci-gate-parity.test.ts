import assert from "node:assert/strict";
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
 * THE DOCS-ONLY FAST PATH IS GONE, AND MUST NOT COME BACK.
 *
 * WHAT WAS HERE BEFORE. Each of `validate` and `checks` answered inline whether a PR was
 * documentation only and skipped its expensive steps when it was. This test used to prove the
 * classifier's BEHAVIOUR — it lifted the two `grep` conditions out of `ci.yml` and ran them against
 * a table of changed-file lists — because the first version of that classifier counted every `*.md`
 * and every `docs/` path as inert, and three tests in the suite exist ONLY to police the auto-loaded
 * instruction files. #4147 (AGENTS.md + docs/agents-*.md) reported success in 8 seconds with every
 * real step skipped.
 *
 * WHY IT WAS REMOVED RATHER THAN WIDENED AGAIN (2026-10-06). The exemption list was wrong a second
 * time, in a way the first fix did not suggest: `.claude/rules/*.md` and `.claude/cloud-context/**`
 * are read by tests/module-memory.test.ts, `docs/*-live-sheet.gs` is EXECUTED by
 * tests/cv-lifecycle-sheet-token-rotation.test.ts and pushed into a live Google Sheet on merge by
 * apps-script-push.yml, and everything under `docs/` is scanned by tests/docs-share-token-guard.ts,
 * which exists because share tokens were committed under `docs/` twice. PR #5182 was seven
 * `.claude/cloud-context/*.md` files: both required checks passed in ~10 seconds and the merge then
 * failed `validate` on `main` for three consecutive commits, withholding three production deploys.
 * A list of "inert" paths is a thing that is wrong until someone notices, and noticing costs a
 * production deploy each time. `docs_only` was true on 1 of 44 runs when it was measured — the whole
 * mechanism bought about four short runs a day.
 *
 * SO THE INVARIANT IS NOW SIMPLE AND UNFALSIFIABLE BY A PATH LIST: no step in `ci.yml` is SKIPPED
 * because of what the diff touched. The only conditional work left is gated on the EVENT, which no
 * file can change. From 2026-10-08 to 2026-11-05 one narrow exception stood: `validate`'s `Build risk`
 * step read the diff, but only to ADD the Build to a pull request. It is gone — since 2026-11-05 a
 * pull request never builds (owner: "Yes, skip the PR build") — so no required job reads the diff at
 * all, and `steps.buildrisk` must feed nothing.
 * The build and the login smoke keep their own test
 * (tests/ci-pr-skips-build-and-smoke.test.ts) and the suite keeps its own
 * (tests/ci-suite-placement.test.ts).
 */
export function runCiDocsOnlyClassifierTests() {
  const ciYml = readFileSync(path.join(WORKFLOW_DIR, "ci.yml"), "utf8");
  // Comments are stripped before the assertions below, and deliberately: ci.yml's header explains at
  // length WHY the fast path was removed, and that explanation names it. A guard that fired on its
  // own account would force the next reader to delete the reasoning in order to keep the rule — the
  // exact trade this repo refuses everywhere else. What is asserted is what the runner EXECUTES.
  const live = ciYml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  // 1 — nothing reads a docs-only verdict any more.
  assert.doesNotMatch(
    live,
    /docs_only/,
    "ci.yml refers to `docs_only` again. A fast path that skips steps because the diff looked like " +
      "documentation was removed on 2026-10-06 after it let PR #5182 (seven .claude/cloud-context " +
      "files) through both required checks in ~10 seconds and broke `main` for three commits, " +
      "withholding three production deploys. The tests that police those files live in the suite " +
      "this path skips, so it cannot be made safe by widening its exemption list — that list was " +
      "already wrong twice. If a fast path is genuinely wanted again, it must be gated on something " +
      "a diff cannot influence.",
  );

  // 2 — and no step is gated on the CHANGED FILES by any other spelling. This is the assertion that
  // survives a rename of the output: a `git diff --name-only` feeding an `if:` is the shape, not the
  // word `docs_only`. `mobile`'s classifier is the one deliberate exception — it runs the mobile
  // typecheck when `mobile/` changed, it is not a required check, and it fails towards doing MORE
  // work, so a mistake there costs a minute rather than a gate.
  const jobs = live.split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/);
  const offenders = jobs
    .filter((job) => /git diff --name-only/.test(job))
    .map((job) => /^ *([A-Za-z0-9_-]+):/.exec(job)?.[1] ?? "?")
    .filter((name) => name !== "mobile");
  const consumers = live.split("\n").filter((line) => /steps\.buildrisk\./.test(line));
  assert.deepEqual(
    consumers.map((line) => line.trim()),
    [],
    "`steps.buildrisk` feeds a condition again. Since 2026-11-05 a pull request never builds (owner: " +
      "\"Yes, skip the PR build\"), so nothing reads the diff to decide a step — a consumer is a skip list " +
      "waiting to be wrong, the 2026-10-02 incident.",
  );
  assert.deepEqual(
    offenders,
    [],
    `job(s) ${offenders.join(", ")} compute a changed-file list again. Only \`mobile\` may: it is not ` +
      `a required check and it errs towards running more. In a required job, a step skipped because ` +
      `of what the diff touched is a gate with a list of exceptions, and this repo has paid for that ` +
      `list being wrong twice.`,
  );
}
