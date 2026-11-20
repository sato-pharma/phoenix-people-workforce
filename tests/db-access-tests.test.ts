import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACCESS_TEST_FILE, readTap } from "../scripts/lib/db-access-tests.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// The pgTAP access tests (supabase/tests/database/access.test.sql) run every Monday inside the
// database the schema restore check has just rebuilt. They need Docker and a Postgres, so the suite
// cannot run them; it pins what can be pinned without one:
//   1. the verdict — readTap passes only a run where every planned test printed ok, and nothing else;
//   2. the file — it rolls itself back, and its plan() matches the number of assertions in it, so a
//      test added without raising the plan is caught here, not on a Monday morning;
//   3. the wiring — the weekly job runs it after the restore, with no secret, and its alert says
//      ACCESS rather than REBUILD.
// Account: docs/security/schema-restore-check.md, "The access tests".
// ─────────────────────────────────────────────────────────────────────────────

const RESTORE_WORKFLOW = ".github/workflows/schema-restore-check.yml";

export function runDbAccessTestsTests() {
  // ── 1. The verdict ───────────────────────────────────────────────────────────────────────────────
  const clean = readTap(["1..3", "ok 1 - a", "ok 2 - b", "ok 3 - c"].join("\n"));
  assert.equal(clean.ok, true, "every planned test printed ok: a pass");
  assert.equal(clean.passed, 3);

  const crlf = readTap("1..2\r\nok 1 - a\r\nok 2 - b\r\n");
  assert.equal(crlf.ok, true, "Windows line endings read the same");

  const oneFailed = readTap(["1..2", "ok 1 - a", "not ok 2 - b", "# Failed test 2: \"b\""].join("\n"));
  assert.equal(oneFailed.ok, false, "a not ok line fails the run");
  assert.deepEqual(oneFailed.failed, ["not ok 2 - b"], "the failed test is named");
  assert.equal(oneFailed.passed, 1, "a not ok line is never counted as ok");

  const stoppedHalfWay = readTap(["1..5", "ok 1 - a", "ok 2 - b"].join("\n"));
  assert.equal(stoppedHalfWay.ok, false, "a run that stopped part way is never a pass, though nothing printed not ok");
  assert.match(stoppedHalfWay.reasons.join(" "), /2 of 5 planned/);

  assert.equal(readTap("").ok, false, "a run that printed nothing is never a pass");
  assert.equal(readTap("ok 1 - a\nok 2 - b").ok, false, "ok lines with no plan line are never a pass");
  assert.equal(readTap("1..0").ok, false, "a plan of zero tests is never a pass");
  assert.equal(readTap("1..1\nok 1 - a\nok 2 - extra").ok, false, "more tests than planned is never a pass");

  // ── 2. The file ──────────────────────────────────────────────────────────────────────────────────
  const sql = readFileSync(ACCESS_TEST_FILE, "utf8").replace(/\r\n/g, "\n");
  assert.match(sql, /^begin;$/m, "the tests run in one transaction");
  assert.match(sql, /^rollback;\s*$/m, "and roll it back, so the database is left as it was found");
  assert.doesNotMatch(sql, /^commit;/im, "nothing is ever committed");
  const plan = Number(/^select plan\((\d+)\);$/m.exec(sql)?.[1]);
  const assertions = sql.match(/^select (?:is|isnt|ok|throws_ok|lives_ok|is_empty|isnt_empty|set_eq|bag_eq|results_eq)\(/gm) ?? [];
  assert.ok(plan > 0, "the file declares a plan");
  assert.equal(assertions.length, plan, `plan(${plan}) must equal the ${assertions.length} assertions in ${ACCESS_TEST_FILE}`);
  assert.match(sql, /set local role authenticated/, "the tests sign in as the browser role, not as an administrator");
  assert.match(sql, /set local role anon/, "and as the anonymous key");

  // ── 3. The wiring ────────────────────────────────────────────────────────────────────────────────
  const wf = readFileSync(RESTORE_WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const restoreJob = /^ {2}restore:\n([\s\S]*?)\n {2}notify:\n/m.exec(wf)?.[1] ?? "";
  const restoreAt = restoreJob.indexOf("run: node scripts/schema-baseline.mjs --restore-check");
  const accessAt = restoreJob.indexOf("run: node scripts/db-access-tests.mjs");
  assert.ok(restoreAt > 0, "the weekly job still runs the restore");
  assert.ok(accessAt > restoreAt, "the access tests run in the same job, after the restore");
  const accessStep = restoreJob.slice(restoreJob.lastIndexOf("- name:", accessAt));
  assert.match(accessStep, /^ {8}id: access$/m, "the step is named so the job output can read it");
  assert.doesNotMatch(accessStep, /continue-on-error|^ {8}if:/m, "a failed access test turns the run red, and only follows a passed restore");
  assert.match(accessStep, /SCHEMA_RESTORE_URL: postgresql:\/\/supabase_admin@127\.0\.0\.1:5432\/postgres/, "it runs against the runner's own container");
  assert.match(wf, /access_failed: \$\{\{ steps\.access\.outcome == 'failure' \}\}/, "the job says when the access tests failed");
  assert.match(wf, /DATABASE ACCESS TESTS FAILED\\n/, "and the alert names the access tests, on one line with its escapes intact");
  for (const path of ["scripts/db-access-tests.mjs", "scripts/lib/db-access-tests.mjs", "supabase/tests/database/**"]) {
    assert.ok(wf.includes(`- "${path}"`), `a merge that changes ${path} runs the check once on main`);
  }
}
