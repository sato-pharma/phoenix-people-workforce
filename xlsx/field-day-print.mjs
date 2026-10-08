#!/usr/bin/env node
/**
 * The field day printer, as reached from `xlsx/` — a LAUNCHER for it, and deliberately nothing else.
 *
 * Until 2026-10-08 this path held a COPY of `scripts/field-day/print-day.mjs`, taken on 2026-10-03
 * and never updated again. It drifted 453 lines behind, and because it kept the original `notesFor`
 * keyed by rep name alone — no date, and not one of the 24 `restDay` guards the real printer now
 * carries — a hand-run from here would have reprinted both defects fixed that day:
 *
 *   #5573 (ee634cea5) a public holiday reading as fifteen reps who did nothing
 *   #5574 (2e46a7ec4) a 3 October judgement printing on a later working day
 *
 * onto the papers that go to a district manager, and into the summary read by the Chief Executive.
 * That copy is retired to `F:\Phoenix Workforce\_retired-scripts\field-day-print.mjs.pre-5574`.
 *
 * So this file holds NO logic — no query, no layout, no note rule, not one figure. It forwards the
 * arguments and the exit code to the real printer and gets out of the way. There is nothing here
 * that can fall out of date, which is the whole point of it.
 *
 * 🔴 IT SPAWNS, AND MUST NOT IMPORT. `print-day.mjs` prints only under a main-module guard
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`). Imported from here, `argv[1]` is
 * THIS file, the guard is false, and the module would load, print nothing and exit 0 — a silent
 * no-op that reads as a clean run. Spawning makes the printer `argv[1]` itself, so the guard fires.
 *
 *   node xlsx/field-day-print.mjs [YYYY-MM-DD]        (default: today in Cairo)
 *
 * The papers still land in the PRIMARY checkout's `xlsx/`: `print-day.mjs` resolves that itself with
 * `--git-common-dir`, and this launcher sets no paths and no environment. The nightly Scheduled Task
 * does not come through here — it builds a fresh worktree of `origin/main` and runs the printer
 * directly (`scripts/field-day/run-nightly.mjs`), so it was never exposed to the stale copy.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const printer = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "field-day",
  "print-day.mjs",
);

// Loud, never silent: the only thing worse than an out-of-date paper is no paper and no reason given.
if (!existsSync(printer)) {
  console.error(`field-day: no printer at ${printer} — has scripts/field-day/print-day.mjs moved?`);
  process.exit(1);
}

const run = spawnSync(process.execPath, [printer, ...process.argv.slice(2)], { stdio: "inherit" });

if (run.error) {
  console.error(`field-day: could not start the printer — ${run.error.message}`);
  process.exit(1);
}

// `status` is null when the printer was killed by a signal; that is a failure, not a clean exit.
process.exit(run.status ?? 1);
