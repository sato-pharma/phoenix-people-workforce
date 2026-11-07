import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { SPARE_SKIPPED_TESTS, SPARE_SKIP_SWITCH, spareSkipRefusal, spareSkips } from "./spare-skip.ts";

/**
 * Pins the spare laptop's one skip (tests/spare-skip.ts): one test, only when armed, never on CI, never counted.
 */
export function runSpareSkipTests() {
  const armed = { [SPARE_SKIP_SWITCH]: "1" };

  // Exactly one test, by its execute function's name.
  assert.deepEqual([...SPARE_SKIPPED_TESTS], ["runCvTextIsolationTests"], "the skip list is the CV worker test and nothing else");
  assert.equal(spareSkips(armed, "runCvTextIsolationTests"), true, "armed, the CV worker test is left out");
  for (const other of ["runCredentialEmailMirrorTests", "runErrorScreenPictureFilterTests", "runSpareSkipTests", ""]) {
    assert.equal(spareSkips(armed, other), false, `armed, ${JSON.stringify(other)} still runs`);
  }

  // Only the exact value 1 arms it.
  for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
    assert.equal(
      spareSkips({ [SPARE_SKIP_SWITCH]: value }, "runCvTextIsolationTests"),
      false,
      `${SPARE_SKIP_SWITCH}=${JSON.stringify(value)} must not skip`,
    );
  }

  // Refused on CI, so the required checks always run every test.
  assert.match(spareSkipRefusal({ ...armed, CI: "true" }) ?? "", /refused on CI \(CI set\)/);
  assert.match(spareSkipRefusal({ ...armed, GITHUB_ACTIONS: "true" }) ?? "", /refused on CI \(GITHUB_ACTIONS set\)/);
  assert.match(spareSkipRefusal({ ...armed, CI: "1", GITHUB_ACTIONS: "true" }) ?? "", /CI, GITHUB_ACTIONS set/);
  assert.equal(spareSkipRefusal(armed), null, "armed off CI, the run goes ahead");
  assert.equal(spareSkipRefusal({ CI: "true" }), null, "on CI with the switch off, nothing is refused");
  assert.equal(spareSkipRefusal({ ...armed, CI: "false" }), null, "CI=false is not CI");

  // The runner: the refusal stops it before any test, the skip sits after the shard deal and BEFORE ran is
  // counted, and a skipping shard prints its own line while PHX_SHARD_RESULT keeps its exact format.
  const runner = readFileSync(path.join(process.cwd(), "tests", "run-tests.ts"), "utf8");
  assert.match(runner, /const spareSkipStop = spareSkipRefusal\(process\.env\);\nif \(spareSkipStop\) \{\n  console\.error\(spareSkipStop\);\n  process\.exit\(2\);/);
  const body = /\nasync function runTest\(([\s\S]*?)\n\}\n/.exec(runner)?.[1] ?? "";
  const mine = body.indexOf("if (!mine) return;");
  const skip = body.indexOf("if (spareSkips(process.env, execute.name)) {");
  const ran = body.indexOf("ranCount += 1;");
  assert.ok(mine >= 0 && skip > mine, "the skip is decided after the shard deal, so every shard still sees every test");
  assert.ok(ran > skip, "a skipped test is never counted as ran");
  assert.match(body.slice(skip, ran), /spareSkipped\.push\(execute\.name\);[\s\S]*return;/, "a skipped test is recorded and returns");
  assert.match(runner, /console\.log\(`PHX_SHARD_RESULT shard=\$\{shardIndex\}\/\$\{shardTotal\} seen=\$\{seenCount\} ran=\$\{ranCount\}`\);/);
  assert.match(runner, /PHX_SHARD_SKIPPED shard=\$\{shardIndex\}\/\$\{shardTotal\} skipped=\$\{spareSkipped\.length\}/);
  assert.match(runner, /\n  runCvTextIsolationTests,\n\);/, "the name on the skip list is a real registered test");

  // No workflow ever sets the switch.
  const workflows = path.join(process.cwd(), ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    assert.ok(!readFileSync(path.join(workflows, file), "utf8").includes(SPARE_SKIP_SWITCH), `${file} must never set ${SPARE_SKIP_SWITCH}`);
  }
}
