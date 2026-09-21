import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import { officeCommitMessage, settleStepConfirmation } from "../src/lib/sales/step-confirmation.ts";

// The Office commit saves the allocation, then confirms the run's Office step. That confirm ran
// inside `.catch(() => {})`: a failure left the step pending (so the period could not lock) while
// the operator read "Office allocation saved." — Source of Sales fix backlog, re-measured
// 2026-09-18, "#63's fix leaves one caller swallowing the new error".

export async function runOfficeCommitConfirmStepTests() {
  // 1. A confirm that succeeds reads as confirmed, and the message is the plain success.
  const ok = await settleStepConfirmation(async () => ({ id: "run" }));
  assert.deepEqual(ok, { confirmed: true });
  assert.equal(officeCommitMessage(ok), "Office allocation saved.");
  assert.equal(officeCommitMessage(null), "Office allocation saved.", "no run step to confirm (blocked or no batch)");

  // 2. A confirm that throws is reported with its reason, never swallowed.
  let seen: unknown = null;
  const failed = await settleStepConfirmation(
    async () => {
      throw new SalesWorkflowError("not_found", "No Monthly Sales run exists for 2026-09.", 404);
    },
    (error) => {
      seen = error;
    },
  );
  assert.deepEqual(failed, { confirmed: false, reason: "No Monthly Sales run exists for 2026-09." });
  assert.ok(seen instanceof SalesWorkflowError, "the failure is handed to the caller's logger");
  assert.equal(
    officeCommitMessage(failed),
    "Office allocation saved, but the Office step was NOT marked confirmed: No Monthly Sales run exists for 2026-09.",
    "the operator is told the step did not take, and why",
  );

  // 3. A database error object (not an Error) still settles, with a safe fallback reason.
  const dbError = await settleStepConfirmation(async () => {
    throw { code: "57014", message: "canceling statement due to statement timeout" };
  });
  assert.equal(dbError.confirmed, false);
  assert.ok(!dbError.confirmed && dbError.reason.length > 0);

  // 4. Source pins: the Office route settles the confirm and puts it in the reply; no route in the
  //    app swallows a step confirm with an empty catch again.
  const route = readFileSync("app/api/sales/monthly-sales/office/commit/route.ts", "utf8");
  assert.match(route, /settleStepConfirmation\(/, "the Office commit settles its confirm into a reported outcome");
  assert.match(route, /data: \{ \.\.\.result, stepConfirmation \}/, "the reply carries the confirm outcome");
  assert.match(route, /officeCommitMessage\(stepConfirmation\)/, "the reply's message names an unconfirmed step");
  let swallowed = "";
  try {
    swallowed = execFileSync(
      "git",
      ["grep", "-nE", String.raw`confirmStep\(.*\)\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)`, "--", "app", "src"],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    // git grep exits 1 when nothing matches — the passing case.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  assert.equal(swallowed, "", `a step confirm is swallowed by an empty catch again:\n${swallowed}`);
}
