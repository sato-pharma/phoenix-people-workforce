// `scripts/check-dockerfile.mjs` must keep catching what it was built to catch, and keep NOT firing
// on the two valid patterns that made the first two versions of it useless.
//
// WHY THIS EXISTS. A Dockerfile is the one thing here that reaches production with no CI coverage:
// `validate` skips the Build on a pull request (deliberately — tests/ci-pr-skips-build-and-smoke.test.ts
// has the measured reason) and Railway builds the image only AFTER the merge. So the check script is
// the entire gate, and a gate nobody tests is a gate that quietly stops working.
//
// 🔴 THIS FILE EXISTS BECAUSE THE HEADLINE RULE SHIPPED INERT ONCE ALREADY. The first version of the
// script collected a line's own declarations BEFORE scanning its references, so that `ENV X=$X` would
// not be reported against itself. That is exactly the shape an orphan takes when its `ARG X` is
// deleted — so the one case the script was written for passed clean. It was caught only by breaking it
// on purpose and watching nothing happen. Hence a fixture per rule, asserted by RULE SLUG.
//
// The two negative fixtures matter as much as the positive ones. An earlier version scanned `RUN`
// bodies and produced 30 false positives on infra/headwind-phoenix-actions/Dockerfile — every one a
// shell variable the script itself assigned. A required check that reds a valid file is a check
// somebody turns off, so "does not fire here" is pinned too.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/check-dockerfile.mjs";

/** One fixture: a Dockerfile body, and the rule slug it must (or must not) produce. */
type Fixture = {
  readonly name: string;
  readonly body: string;
  /** The rule slug expected in the output, or null when the fixture must pass clean. */
  readonly rule: string | null;
  readonly why: string;
};

const FIXTURES: readonly Fixture[] = [
  {
    name: "a valid two-stage file",
    body: 'FROM node:22-alpine AS base\nARG GOOD=1\nENV GOOD=$GOOD\nCMD ["node","x.js"]\n',
    rule: null,
    why: "the ordinary shape of both real Dockerfiles must pass, or the check is unusable",
  },
  {
    name: "a misspelled instruction",
    body: "FROM node:22-alpine\nENN NODE_ENV=production\n",
    rule: "unknown-instruction",
    why: "docker refuses the whole build on this, and nothing else in CI would see it",
  },
  {
    name: "COPY --from naming a stage that does not exist",
    body: "FROM node:22-alpine AS base\nCOPY --from=builder /app/x ./x\n",
    rule: "unknown-stage",
    why: "docker reads an unknown stage as an IMAGE and fails with a registry error that hides the typo",
  },
  {
    name: "the legacy ENV space form",
    body: "FROM node:22-alpine\nENV NODE_ENV production\n",
    rule: "legacy-env-format",
    why: "it warns on every production build; the app Dockerfile's five instances were removed 2026-09-30",
  },
  {
    name: "an ENV reading a variable whose ARG was deleted",
    body: "FROM node:22-alpine\nENV NEXT_PUBLIC_COMMIT_SHA=$NEXT_PUBLIC_COMMIT_SHA\n",
    rule: "undeclared-variable",
    why:
      "🔴 THE CASE THE SCRIPT EXISTS FOR — this is exactly what #4981 would have left behind had it " +
      "removed `ARG NEXT_PUBLIC_COMMIT_SHA` and kept the ENV line. Docker does not fail on it: it " +
      "substitutes an empty string, so the image builds green and ships with the value gone. This " +
      "assertion passed a clean bill of health on the first version of the script.",
  },
  {
    name: "shell variables inside a RUN body",
    body:
      "FROM node:22-alpine\nARG SHA\n" +
      'RUN set -eu; MARKER=x; echo "$MARKER" > "/tmp/$MARKER"\n' +
      'CMD ["sh","-c","echo $UNSET_AT_RUNTIME"]\n',
    rule: null,
    why:
      "🔴 THE FALSE-POSITIVE GUARD. A RUN body goes to a SHELL, which expands $VAR at run time and " +
      "may have assigned it in the same script. Scanning these produced 30 false positives on the " +
      "Headwind Dockerfile, which is correct — the rule was not.",
  },
  {
    name: "ENV reading an ARG declared above it",
    body: "FROM node:22-alpine\nARG SHA\nENV SHA=$SHA\n",
    rule: null,
    why: "the legitimate pass-through form; firing here would red both real Dockerfiles",
  },
];

function runCheck(target: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, target], { encoding: "utf8" });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function runDockerfileParseGateTests(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-dockerfile-gate-"));

  // 1. Every fixture behaves as declared — asserted by RULE SLUG, not by message wording, so the
  //    prose in the script stays free to improve without this test going red on it.
  for (const { name, body, rule, why } of FIXTURES) {
    const target = join(dir, name.replace(/[^a-z0-9]+/gi, "-"));
    writeFileSync(target, body, "utf8");
    const { status, output } = runCheck(target);

    if (rule === null) {
      assert.equal(
        status,
        0,
        `🔴 check:dockerfile FIRED on a valid fixture ("${name}"). ${why}\n\nIt printed:\n${output}`,
      );
      continue;
    }

    assert.notEqual(
      status,
      0,
      `🔴 check:dockerfile did NOT fire on "${name}", so that rule is INERT and the Dockerfile it ` +
        `was meant to protect ships unchecked. ${why}\n\nIt printed:\n${output}`,
    );
    assert.match(
      output,
      new RegExp(`\\[${rule}\\]`),
      `🔴 check:dockerfile rejected "${name}" but not under the rule [${rule}] — so it failed for ` +
        `the wrong reason, and the rule this fixture pins may still be inert. ${why}`,
    );
  }

  // 2. The real files must pass. This is what `validate` actually runs, and a check that only works
  //    on fixtures would red every PR from the moment it merged.
  const real = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(
    real.status,
    0,
    "🔴 check:dockerfile rejects a Dockerfile that is currently SHIPPING. Either the file really is " +
      "broken — in which case production's next image build was going to fail — or the check has a " +
      "false positive, which in a required job blocks every merge. It printed:\n" +
      `${real.stdout ?? ""}${real.stderr ?? ""}`,
  );

  // 3. It must run inside the REQUIRED `validate` job, ungated except for the docs-only skip every
  //    sibling check carries. In `checks` it would be beside the typecheck rather than the contracts,
  //    and outside CI entirely it is a script nobody runs (AGENTS.md §7: a pinned check belongs in
  //    `validate`).
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const step = workflow.indexOf("run: pnpm run check:dockerfile");
  assert.ok(
    step > 0,
    "🔴 ci.yml no longer runs check:dockerfile. A Dockerfile then has NO CI coverage at all — the " +
      "Build is gated off pull requests and Railway builds the image only after the merge, so the " +
      "next broken Dockerfile surfaces as a failed production deploy on a green commit.",
  );

  const validateAt = workflow.indexOf("\n  validate:");
  const checksAt = workflow.indexOf("\n  checks:");
  assert.ok(
    validateAt > 0 && checksAt > 0,
    "ci.yml no longer has both a `validate` and a `checks` job under the names branch protection " +
      "requires — read the protection API before changing this test.",
  );
  const jobEnd = validateAt < checksAt ? checksAt : workflow.length;
  assert.ok(
    step > validateAt && step < jobEnd,
    "🔴 check:dockerfile moved out of the `validate` job. It must sit with the other `check:*` " +
      "contracts inside a REQUIRED check, or a red result stops blocking the merge it exists to stop.",
  );

  // 4. And it must be reachable by hand, the way every sibling contract is.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(
    pkg.scripts?.["check:dockerfile"],
    "node scripts/check-dockerfile.mjs",
    "🔴 the `check:dockerfile` npm script is gone or repointed. ci.yml invokes it by that name, so " +
      "the step would fail with a missing-script error rather than a Dockerfile finding.",
  );
  assert.match(
    pkg.scripts?.ci ?? "",
    /check:dockerfile/,
    "🔴 `pnpm run ci` no longer includes check:dockerfile, so the one hand-run whole-gate command " +
      "skips it and disagrees with what CI enforces.",
  );
}
