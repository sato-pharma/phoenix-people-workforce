#!/usr/bin/env node
/**
 * The old name for the field day papers — kept working, as a LAUNCHER and nothing else.
 *
 * Until 2026-10-08 this path held a self-contained printer of its own: the first cut of these
 * papers, documented as `node field-day.mjs [YYYY-MM-DD]`, with its own query, its own layout and
 * its own copy of the note rules. It was the ancestor of `scripts/field-day/print-day.mjs` and had
 * been overtaken by it long before #5573 and #5574, so by tonight a hand-run from here printed the
 * company's documents from code nobody had read in days. It is retired, not deleted, to
 * `F:\Phoenix Workforce\_retired-scripts\field-day.mjs.pre-5574`.
 *
 * The name survives only because it is the one in muscle memory and in the old file's own usage
 * line. It now does exactly what `field-day-print.mjs` beside it does: hands the arguments to the
 * one real printer and forwards its exit code. Same CLI as before, so nothing a person types here
 * has to change.
 *
 *   node xlsx/field-day.mjs [YYYY-MM-DD]             (default: today in Cairo)
 *
 * 🔴 IT SPAWNS, AND MUST NOT IMPORT, for the reason spelled out in `field-day-print.mjs`:
 * `print-day.mjs` prints only under a main-module guard, so an `import` would load it, print
 * nothing and exit 0 — a silent no-op that reads as a clean run.
 *
 * It spawns the PRINTER, not the sibling launcher: one hop, so a failure's exit code and stderr
 * come straight from the printer rather than through a chain of node processes. The few lines below
 * are deliberately the only thing duplicated between the two names — there is no query, no layout
 * and no note rule in either, so there is nothing here that can drift apart.
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

if (!existsSync(printer)) {
  console.error(`field-day: no printer at ${printer} — has scripts/field-day/print-day.mjs moved?`);
  process.exit(1);
}

const run = spawnSync(process.execPath, [printer, ...process.argv.slice(2)], { stdio: "inherit" });

if (run.error) {
  console.error(`field-day: could not start the printer — ${run.error.message}`);
  process.exit(1);
}

process.exit(run.status ?? 1);
