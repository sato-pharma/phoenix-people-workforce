// The Railway IaC pre-apply guard: it must read the committed `.railway/railway.ts` correctly and,
// above all, FLAG a live variable that the committed file would delete on apply. That flag is the
// whole reason the guard exists (a `railway config apply` deletes any live variable absent from the
// file's env block, and the file drifts ~13 names in 9 days), so the would-delete case is the
// positive control here: if classifyDrift stopped catching it, this test goes red.
//
// These are behaviour assertions on the exported pure functions — no live Railway call — so the
// suite runs the same on CI, where there are no Railway credentials, as locally.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseRailwayIacEnv,
  classifyDrift,
  variableNamesFromCliJson,
} from "../scripts/railway-iac-preapply-check.mjs";

export function runRailwayIacPreapplyTests() {
  // 1. The parser understands the real committed file: every service with an env block is found,
  //    and a few load-bearing names land in the right service.
  const iac = readFileSync(resolve(".railway/railway.ts"), "utf8");
  const byService = parseRailwayIacEnv(iac);

  const app = byService.get("phoenix-people-workforce");
  assert.ok(app && app.size > 0, "phoenix-people-workforce env block should be parsed");
  assert.ok(app.has("SUPABASE_SERVICE_ROLE_KEY"), "the app's service-role key must be seen as declared");
  assert.ok(app.has("PHOENIX_AUTH_SECRET"), "the app's auth secret must be seen as declared");

  const worker = byService.get("phoenix-workforce-worker");
  assert.ok(worker && worker.has("PHOENIX_PROCESS_ROLE"), "the worker's process-role var must be seen");

  const headwind = byService.get("phoenix-headwind");
  assert.ok(headwind && headwind.has("SQL_PASS"), "the Headwind DB password must be seen");

  const cron = byService.get("phoenix-cron");
  assert.ok(cron && cron.has("CRON_SECRET"), "the cron secret must be seen");

  // 2. POSITIVE CONTROL — the guard's reason to exist. A live variable absent from the committed
  //    block is reported as a would-delete. If this assertion ever stops firing, the guard is inert.
  const drift = classifyDrift(["A", "B"], ["A", "B", "C_LIVE_ONLY"]);
  assert.deepEqual(drift.wouldDelete, ["C_LIVE_ONLY"], "a live-only variable must be flagged for deletion");
  assert.deepEqual(drift.wouldAdd, [], "no committed-only variable here");

  // 3. A clean match deletes nothing, and platform RAILWAY_* names are ignored on both sides.
  const clean = classifyDrift(["A", "B", "RAILWAY_STATIC_URL"], ["B", "A", "RAILWAY_PRIVATE_DOMAIN"]);
  assert.deepEqual(clean.wouldDelete, [], "a clean match must delete nothing");
  assert.deepEqual(clean.wouldAdd, [], "platform-injected names must never count as drift");

  // 4. A committed name not yet live is an add, never a delete.
  const add = classifyDrift(["A", "B"], ["A"]);
  assert.deepEqual(add.wouldDelete, [], "a committed-only name is not a deletion");
  assert.deepEqual(add.wouldAdd, ["B"], "a committed-only name is an add");

  // 5. The CLI JSON normalizer handles every shape `railway variable list --json` can return.
  assert.deepEqual(
    variableNamesFromCliJson([{ name: "X" }, { name: "Y" }]).sort(),
    ["X", "Y"],
    "array of {name} objects",
  );
  assert.deepEqual(
    variableNamesFromCliJson({ variables: { X: "1", Y: "2" } }).sort(),
    ["X", "Y"],
    "variables as an object",
  );
  assert.deepEqual(
    variableNamesFromCliJson({ variables: [{ name: "X" }] }),
    ["X"],
    "variables as an array of {name}",
  );
  assert.deepEqual(
    variableNamesFromCliJson({ X: "1", Y: "2" }).sort(),
    ["X", "Y"],
    "a plain name->value object",
  );
}
