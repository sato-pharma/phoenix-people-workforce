#!/usr/bin/env node
/**
 * Retention for explorer runs: keep the newest 5 runs of each module and nothing older than 14 days.
 *
 *   node scripts/phoenix-inspect/prune.mjs [--root artifacts/phoenix-inspection] [--keep 5] [--days 14] [--dry]
 *
 * Only folders whose name is a run id (YYYYMMDD-HHMMSS) and that hold a manifest.json are touched.
 * Run folders hold PNG, YAML and JSON only (masked), so removing one deletes no protected document.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "prune",
  entry: import.meta.url,
  known: ["--root", "--keep", "--days", "--dry"],
  hints: ["node scripts/phoenix-inspect/prune.mjs [--root <folder>] [--keep 5] [--days 14] [--dry]"],
});

const RUN_ID = /^\d{8}-\d{6}(?:-[a-z0-9]{1,12})?$/;
const PROTECTED = /\.(html?|pdf|xlsx|xlsm|xls|docx?|svg)$/i;

export function planPrune(root, { keep = 5, days = 14, now = Date.now() } = {}) {
  const remove = [];
  if (!existsSync(root)) return remove;
  for (const moduleDir of readdirSync(root)) {
    const full = path.join(root, moduleDir);
    if (!statSync(full).isDirectory()) continue;
    const runs = readdirSync(full)
      .filter((name) => RUN_ID.test(name) && existsSync(path.join(full, name, "manifest.json")))
      .sort()
      .reverse();
    runs.forEach((name, index) => {
      const ageDays = (now - statSync(path.join(full, name)).mtimeMs) / 86_400_000;
      if (index >= keep || ageDays > days) remove.push(path.join(full, name));
    });
  }
  return remove;
}

function holdsProtected(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (holdsProtected(full)) return true;
    } else if (PROTECTED.test(name)) return true;
  }
  return false;
}

export function prune(root, options = {}) {
  const removed = [];
  const kept = [];
  for (const dir of planPrune(root, options)) {
    if (holdsProtected(dir)) {
      kept.push(`${dir} (holds a protected document type; left in place)`);
      continue;
    }
    if (!options.dry) rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { removed, kept };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const result = prune(value("--root", "artifacts/phoenix-inspection"), {
    keep: Number(value("--keep", 5)),
    days: Number(value("--days", 14)),
    dry: argv.includes("--dry"),
  });
  console.log(`prune: ${result.removed.length} run(s) ${argv.includes("--dry") ? "would be " : ""}removed`);
  for (const line of result.kept) console.log(`  kept: ${line}`);
}
