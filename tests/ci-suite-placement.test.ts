// The unit suite runs on EVERY event, in the `unit` job and nowhere else, and the required `checks`
// status cannot go green without it.
//
// WHY THIS EXISTS. The suite has moved five times: out of `validate` into its own `test` job
// (2026-09-17), into `checks` (09-27), back into `validate` (09-30), into BOTH split by event
// (2026-10-06), and on 2026-10-19 into its own `unit` job — a matrix of three parts, so the suite's
// ~5 minutes of serial work runs beside the build and the lint+typecheck instead of in front of them.
// Each move was for wall clock and each was right at the time, but the class of mistake they share
// cost a real incident: on 2026-09-17 the suite left a required check and the new job's name was not
// added to branch protection, so for a day a PR whose tests were RED showed every required check
// green and merged (#3950).
//
// `unit` is NOT a required check by name — and must not become one without repointing protection
// (tests/required-check-names.test.ts owns that rule). What makes its result count is `checks`, the
// required status, which `needs` it and goes green only on the literal result `success`. So this pins
// the whole chain, because a break anywhere in it is the same silent failure:
//
//   * the suite step exists in `unit`, runs on every event (no `if:`), and is the sharded runner in
//     PART mode — three parts of two shards — so the coverage record the gate needs is written;
//   * the suite is in NO other job, so it never runs twice on an event;
//   * `checks` needs `unit` (and `static`), is not skipped when they fail, and demands `success`;
//   * `checks` runs the coverage gate over the parts' records, so a leg that never ran, or ran twice,
//     is a red required check rather than a smaller suite reporting success.
//
// The suite may move again; what it may not do is leave an event uncovered, or land where the
// required check does not stand behind it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = ".github/workflows/ci.yml";

/** The jobs declared in ci.yml, as name -> that job's text. Node builtins only: no YAML parser here. */
function jobs(yml: string): Map<string, string> {
  const lines = yml.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(start, -1, `${WORKFLOW} has no top-level \`jobs:\` block`);
  const found = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (name) found.set(name, body.join("\n"));
      name = header[1];
      body = [];
      continue;
    }
    if (name) body.push(line);
  }
  if (name) found.set(name, body.join("\n"));
  return found;
}

/** A job's text with whole-line comments removed — what the runner reads, not what a header explains. */
function code(job: string): string {
  return job
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** The text of the step named `name` inside one job, up to the next step, or null. */
function step(job: string, name: string): string | null {
  const at = job.indexOf(`      - name: ${name}\n`);
  if (at === -1) return null;
  const next = job.indexOf("\n      - name:", at + 1);
  return job.slice(at, next === -1 ? undefined : next);
}

export function runCiSuitePlacementTests() {
  const declared = jobs(readFileSync(resolve(WORKFLOW), "utf8").replace(/\r\n/g, "\n"));
  for (const job of ["validate", "static", "unit", "checks"]) {
    assert.ok(declared.has(job), `${WORKFLOW} no longer declares a \`${job}\` job`);
  }
  const unit = code(declared.get("unit") ?? "");
  const checks = code(declared.get("checks") ?? "");

  // 1 — the suite step, unconditional, sharded, in part mode.
  const test = step(unit, "Test");
  assert.notEqual(
    test,
    null,
    "the `unit` job has no step named `Test`: the unit suite does not run on ANY event. Every check would " +
      "still report green, on a pull request and on `main` alike — and `main`'s green releases the production deploy.",
  );
  assert.doesNotMatch(
    test ?? "",
    /^ {8}if:/m,
    "the `Test` step in `unit` is conditional. The suite runs on EVERY event; a condition here is an event on " +
      "which nothing runs the tests while every job still reports green.",
  );
  assert.doesNotMatch(
    unit.slice(0, unit.indexOf("steps:")),
    /^ {4}if:/m,
    "the `unit` job itself is conditional, which skips the suite on some event — and a skipped job reports " +
      "no failure of its own.",
  );
  assert.match(test ?? "", /run: pnpm run test:sharded/, "`unit`'s Test step must run the sharded runner (it is what proves every test ran)");
  assert.match(test ?? "", /PHX_TEST_PART: \$\{\{ matrix\.part \}\}\/\$\{\{ strategy\.job-total \}\}/, "the Test step must run in PART mode over the whole matrix");
  assert.match(test ?? "", /PHX_TEST_SHARDS: "\d+"/, "part mode needs an explicit shards-per-part, identical in every part");
  assert.match(test ?? "", /PHX_TEST_RESULT_FILE: .*unit-coverage-\$\{\{ matrix\.part \}\}\.json/, "each part must write its own coverage record");
  assert.match(unit, /part: \[1, 2, 3\]/, "the matrix must name exactly the parts the runner is told about");
  assert.match(unit, /fail-fast: false/, "one red part must not cancel a second red one out of view");
  assert.match(unit, /name: unit-coverage-\$\{\{ matrix\.part \}\}/, "each part must upload its coverage record for `checks`");

  // 2 — and nowhere else.
  for (const [name, body] of declared) {
    if (name === "unit") continue;
    assert.doesNotMatch(
      code(body),
      /test:sharded|pnpm run test(?![:\w-])/,
      `\`${name}\` also runs the unit suite. It belongs in \`unit\` alone, or it runs twice on every event.`,
    );
  }

  // 3 — the required status stands behind it.
  assert.match(checks, /needs: \[static, unit\]/, "`checks` no longer needs `unit`: the required status can go green before the suite finishes");
  assert.match(
    checks,
    /^ {4}if: \$\{\{ !cancelled\(\) \}\}/m,
    "`checks` must run when a job it needs failed (a skipped required check blocks a PR for ever instead of failing it), " +
      "and must not be `always()` — a superseded run is cancelled on purpose",
  );
  assert.match(checks, /UNIT_RESULT: \$\{\{ needs\.unit\.result \}\}/, "`checks` does not read `unit`'s result");
  assert.match(
    checks,
    /\[ "\$\{result\}" = "success" \]/,
    "`checks` must require the literal result `success` — anything else (failure, cancelled, skipped) is red",
  );

  // 4 — and it proves the parts add up, instead of trusting that each one ran.
  assert.match(checks, /pattern: unit-coverage-\*/, "`checks` must download every part's coverage record");
  assert.match(checks, /merge-multiple: true/, "the records must land in one folder for the coverage gate");
  assert.match(
    checks,
    /node scripts\/ci-unit-coverage\.mjs unit-coverage/,
    "`checks` no longer runs the coverage gate. Without it a leg that never ran, or ran twice, is a smaller " +
      "suite reporting success — the 2026-09-17 shape (#3950).",
  );
}
