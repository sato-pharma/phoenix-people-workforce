import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { newlyAddedJobKeys } from "../scripts/cron-autoarm.mjs";

/**
 * The deploy-time cron auto-arm (owner, 2026-10-05: "build the deploy-time cron auto-arm").
 *
 * What this pins:
 *   1. `newlyAddedJobKeys` returns ONLY the JOBS keys a push ADDED — never a removed one, never a
 *      reordered one, never a field edited inside an existing job, never a deeper quoted key.
 *   2. the runner honours cronjob-sync's "resist --all" rule — it arms one job at a time with
 *      `--job … --apply` and never sweeps.
 *   3. the workflow triggers only on a push to main that touches scripts/cronjob-sync.mjs, and carries
 *      both secrets the arming needs.
 */
export function runCronAutoarmTests(): void {
  // ── 1. the pure extractor ───────────────────────────────────────────────────────────────────
  // A job added at the usual two-space indent.
  assert.deepEqual(
    newlyAddedJobKeys('@@\n+  "phoenix-crm-visit-rollup": {\n+    title: "x",\n'),
    ["phoenix-crm-visit-rollup"],
    "an added JOBS key is armed",
  );

  // Several at once, in order.
  assert.deepEqual(
    newlyAddedJobKeys('+  "alpha-job": {\n   context\n+  "beta-job": {\n'),
    ["alpha-job", "beta-job"],
    "every added key is returned",
  );

  // A removed key is never armed.
  assert.deepEqual(newlyAddedJobKeys('-  "retired-job": {\n'), [], "a removed key is not armed");

  // A reorder/reformat shows the same key on both sides — not a new declaration.
  assert.deepEqual(
    newlyAddedJobKeys('-  "moved-job": {\n+  "moved-job": {\n'),
    [],
    "a key present on both sides is not a new job",
  );

  // Editing a field inside an existing job declares no new key.
  assert.deepEqual(
    newlyAddedJobKeys('-    requestTimeout: 300,\n+    requestTimeout: 120,\n'),
    [],
    "an edit inside an existing job arms nothing",
  );

  // A deeper quoted key (the create payload's headers, six-space indent) is not a JOBS entry.
  assert.deepEqual(
    newlyAddedJobKeys('+      "Authorization": authHeader,\n'),
    [],
    "a deeper quoted key is not mistaken for a JOBS entry",
  );

  // An empty diff (file touched elsewhere) arms nothing.
  assert.deepEqual(newlyAddedJobKeys(""), [], "an empty diff arms nothing");

  // ── 2. the runner stays within cronjob-sync's one-at-a-time rule ─────────────────────────────
  const runner = readFileSync(new URL("../scripts/cron-autoarm.mjs", import.meta.url), "utf8");
  assert.ok(
    runner.includes('"--job", key, "--apply"'),
    "arms one job at a time with the sanctioned --job … --apply",
  );
  assert.ok(
    !runner.includes('"--all"'),
    "never passes --all as an argument to cronjob-sync (no bulk sweep)",
  );
  assert.ok(
    runner.includes("CRONJOB_API_KEY"),
    "fails loudly when the API key is missing and there is a job to arm",
  );

  // ── 3. the workflow is scoped and carries both secrets ──────────────────────────────────────
  const wf = readFileSync(new URL("../.github/workflows/cron-autoarm.yml", import.meta.url), "utf8");
  assert.ok(/on:\s[\s\S]*push:/.test(wf), "triggers on push");
  assert.ok(/branches:\s*\[main\]/.test(wf), "only on main");
  assert.ok(/paths:[\s\S]*scripts\/cronjob-sync\.mjs/.test(wf), "only when the JOBS map file changes");
  assert.ok(wf.includes("secrets.CRON_SECRET"), "passes CRON_SECRET");
  assert.ok(wf.includes("secrets.CRONJOB_API_KEY"), "passes CRONJOB_API_KEY");
  assert.ok(wf.includes("node scripts/cron-autoarm.mjs"), "runs the arming script");

  console.log("cron auto-arm: OK");
}
