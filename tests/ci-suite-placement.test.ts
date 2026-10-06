// The unit suite runs on EVERY event, in exactly one of the two required jobs — never in neither.
//
// WHY THIS EXISTS. The suite has moved four times: out of `validate` into its own `test` job
// (2026-09-17), into `checks` (09-27), back into `validate` (09-30), and on 2026-10-06 into BOTH,
// split by event — `validate` on a pull request, `checks` on everything else. Each move was for
// wall clock and each was right at the time, but the class of mistake they share is the one that
// cost a real incident: on 2026-09-17 the suite left a required check and the new job's name was
// not added to branch protection, so for a day a PR whose tests were RED showed every required
// check green and merged (#3950).
//
// The split by event makes that mistake cheaper to make and harder to see, because the two `if:`
// conditions must be exact complements. Get them wrong in one direction and the suite runs twice —
// wasteful, loud, harmless. Get them wrong in the OTHER direction and there is an event on which
// nothing runs the tests at all, with every job still green: on a pull request that is a merge gate
// that tests nothing, and on a push to `main` it is the production deploy gate (AGENTS.md §2)
// passing without them, because a red `main` still builds, ships and serves (next.config.ts sets
// `typescript.ignoreBuildErrors`).
//
// So this pins the invariant rather than the arrangement. The suite may move again; what it may not
// do is leave an event uncovered, or land in a job branch protection does not require.

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

/** The `if:` on the step named `Test` inside one job's text, or null when the job has no such step. */
function testStepCondition(job: string): string | null {
  const at = job.indexOf("      - name: Test\n");
  if (at === -1) return null;
  const step = job.slice(at, job.indexOf("\n\n", at) === -1 ? undefined : job.indexOf("\n\n", at));
  const condition = /^ {8}if: (.+)$/m.exec(step);
  return condition ? condition[1].trim() : "";
}

export function runCiSuitePlacementTests() {
  const yml = readFileSync(resolve(WORKFLOW), "utf8");
  const declared = jobs(yml);

  // The two jobs that gate a merge, as branch protection names them. They are read live by
  // scripts/check-required-checks.mjs; this file must not be the place that states the list, so it
  // only asserts that the suite lives in jobs that exist and that the OTHER tests already cover.
  const required = ["validate", "checks"];
  for (const job of required) assert.ok(declared.has(job), `${WORKFLOW} no longer declares a \`${job}\` job`);

  const conditions = new Map(required.map((job) => [job, testStepCondition(declared.get(job) ?? "")]));
  const homes = required.filter((job) => conditions.get(job) !== null);
  assert.notDeepEqual(
    homes,
    [],
    "neither required job has a `Test` step: the unit suite does not run on ANY event. Every check " +
      "would still report green, on a pull request and on `main` alike — and `main`'s green is what " +
      "releases the production deploy.",
  );

  // Exact complements: one runs on a pull request, the other on everything else.
  const onPr = homes.filter((job) => /event_name == 'pull_request'/.test(conditions.get(job) ?? ""));
  const offPr = homes.filter((job) => /event_name != 'pull_request'/.test(conditions.get(job) ?? ""));
  const unconditional = homes.filter((job) => conditions.get(job) === "");

  if (unconditional.length > 0) {
    // One job running it on every event is also correct — it is what the file did before 2026-10-06
    // — so it passes, as long as it is the ONLY home. Two unconditional homes run the suite twice.
    assert.deepEqual(
      homes,
      unconditional,
      `\`${unconditional.join(", ")}\` runs the suite on every event while \`${homes
        .filter((job) => !unconditional.includes(job))
        .join(", ")}\` also has a conditional \`Test\` step — the suite runs twice on some event, and ` +
        `whichever condition was meant to carry it is now unreadable.`,
    );
    assert.equal(unconditional.length, 1, "the suite has two unconditional homes; it would run twice on every event");
    return;
  }

  assert.equal(
    onPr.length,
    1,
    `exactly one required job must run the unit suite on a pull request; ${onPr.length} do ` +
      `(${onPr.join(", ") || "none"}). Zero means a PR merges without its tests ever running — the ` +
      `2026-09-17 shape (#3950), where a red suite showed green required checks for a day.`,
  );
  assert.equal(
    offPr.length,
    1,
    `exactly one required job must run the unit suite on a push, a dispatch and a schedule; ` +
      `${offPr.length} do (${offPr.join(", ") || "none"}). Zero means \`main\` — the production ` +
      `deploy gate — goes green without the tests, and a red main still builds, ships and serves.`,
  );
  assert.notDeepEqual(onPr, offPr, "both conditions landed on the same job, so one event runs no tests at all");

  // And the step must be the sharded runner in both, or one event silently takes several minutes
  // longer than the other for no reason anybody would think to look for.
  for (const job of homes) {
    const body = declared.get(job) ?? "";
    const at = body.indexOf("      - name: Test\n");
    const step = body.slice(at, at + 400);
    assert.match(
      step,
      /run: pnpm run test:sharded/,
      `\`${job}\`'s Test step no longer runs \`pnpm run test:sharded\`. The sharded runner is what ` +
        `proves every test ran exactly once (scripts/run-tests-sharded.mjs refuses otherwise); a bare ` +
        `\`pnpm run test\` is correct but serial, and the two homes drifting apart is how one event ` +
        `quietly keeps the slow path.`,
    );
  }
}
