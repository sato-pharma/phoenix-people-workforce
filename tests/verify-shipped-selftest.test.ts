// `verify-shipped.mjs --selftest` must actually RUN somewhere, and its load-bearing cases must
// still be in it.
//
// WHY THIS EXISTS. The ship skill's verifier carries 32 pure-function cases covering the verdict
// table, ancestry resolution, the withheld classification and — since 2026-09-28 — the rule that a
// deploy is WITHHELD only when its commit is ALSO absent from what production is serving. Every one
// of them was protected by nothing: no file under tests/ referenced verify-shipped, and it was not
// registered in run-tests.ts, so by this repo's own rule (docs/testing.md: a test not registered
// never runs) the selftest executed only when a human typed it. `classifyDeployRow` could have been
// broken and all four required checks would have stayed green.
//
// That gap mattered more than an ordinary untested script, because of WHAT the verifier says. It is
// the thing a session reads to decide whether a merge reached production. A broken classifier there
// does not fail loudly — it prints a confident WITHHELD on a healthy deploy, which points the reader
// at `railway redeploy`, forbidden by AGENTS.md §2.3 and useless anyway. A wrong answer that
// produces no symptom is the expensive kind.
//
// WHAT IS ASSERTED, AND WHY EXIT 0 IS NOT ENOUGH. Three layers, because each one alone is defeatable:
//   1. the selftest runs and reports 0 failed — catches a broken function;
//   2. the case COUNT never falls — catches deleting a case to make a failure go away, which layer 1
//      would report as a perfectly green run;
//   3. the load-bearing cases are still present BY NAME — catches swapping a hard case for an easy
//      one, which keeps both the count and the exit code intact.
// Layer 3 is the one that survives a determined tidy-up, and the three names pinned below are the
// three that encode the 2026-09-28 fix: the real WITHHELD, the CARRIED case that must not be called
// withheld, and the unknown-ancestry case that must print no accusation at all.
//
// It drives the real script as a subprocess rather than importing it, for the same reason
// local-typecheck-guard.test.ts drives the real hook: an import would test a copy of the logic while
// the shipped entry point could be wired to nothing. It needs no network and no `gh` — that is
// asserted too, since a selftest that quietly required credentials would go red in CI for a reason
// that has nothing to do with the code.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(REPO_ROOT, ".claude", "skills", "ship", "verify-shipped.mjs");

// A ratchet, not an equality: cases may RISE freely and must never FALL. Raise this number when you
// add cases; never lower it to make a red test green — lowering it is precisely the move this guards.
const MIN_CASES = 48;

// The cases that carry the withheld rule, then the two that carry `--wait`'s stop rule (2026-10-19).
// Matched on a distinctive fragment rather than the whole sentence, so rewording a case name does not
// fail the build, but deleting the case does.
const LOAD_BEARING = [
  "never succeeded and NOT serving",
  "NOT withheld when the commit IS serving",
  "ancestry UNKNOWN never prints the accusation",
  // `--wait` stops on a settled verdict, and a timeout is never reported as one.
  "a settled verdict stops at once",
  "at the limit it stops and says TIMED OUT, never settled",
];

export function runVerifyShippedSelftestTests() {
  assert.ok(
    existsSync(SCRIPT),
    `the ship skill's verifier must exist at ${SCRIPT} — if it moved, move this test's path with it rather than deleting the test`,
  );

  const run = spawnSync(process.execPath, [SCRIPT, "--selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // No GitHub token and no network are needed by --selftest. Stripping the token proves it: if
    // the selftest ever starts calling `gh`, this fails HERE with a clear reason rather than in CI
    // as an unexplained credential error.
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    timeout: 120_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(
    run.status,
    0,
    `verify-shipped --selftest must exit 0 with no network and no gh token.\nexit=${run.status}\n${output}`,
  );

  const summary = /SELFTEST verify-shipped: (\d+) cases, (\d+) failed/.exec(output);
  assert.ok(
    summary,
    `--selftest must print its own summary line so this test can read the counts; got:\n${output}`,
  );

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `verify-shipped selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the verify-shipped selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a green run with fewer cases is exactly the failure this ratchet exists to catch. " +
      "If cases were genuinely consolidated, lower MIN_CASES in the same commit and say why in the message.",
  );

  for (const fragment of LOAD_BEARING) {
    assert.ok(
      output.includes(fragment),
      `the verify-shipped selftest no longer covers "${fragment}". ` +
        "The first three encode the rule that a deploy is WITHHELD only when its commit is also absent from what is serving " +
        "(2026-09-28, production deployment 6712985148: its only status was in_progress while /api/healthz served that exact revision). " +
        "Without them the verifier can go back to printing WITHHELD on a healthy deploy and nothing will notice. " +
        "The last two encode `--wait`: it must stop on a settled verdict and must never present a timeout as one.",
    );
  }

  // Every case the run printed must have PASSed. The summary says 0 failed, but a case that threw
  // before reporting would never appear in either column — so the lines are counted too.
  const passLines = (output.match(/^PASS /gm) || []).length;
  assert.equal(
    passLines,
    cases,
    `the selftest printed ${passLines} PASS lines for ${cases} counted cases — a case vanished between running and reporting:\n${output}`,
  );
}
