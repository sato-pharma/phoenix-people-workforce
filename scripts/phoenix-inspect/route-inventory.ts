/**
 * Writes docs/phoenix-intelligence/route-inventory.json from the app's own navigation code.
 *
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-inspect/route-inventory.ts
 *
 * `--stdout` prints instead of writing. `--summary` prints one line per role.
 * Pure: no database, no network, no environment variables.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { buildRouteInventory } from "./lib/route-inventory.ts";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "route-inventory",
  entry: import.meta.url,
  known: ["--stdout", "--summary"],
});

const repoRoot = process.cwd();
const inventory = buildRouteInventory(repoRoot);
// One row per line: readable in a diff, a quarter of the size of a fully indented file.
const { entries, ...head } = inventory;
const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, "");
const json = `${headJson},\n  "entries": [\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]\n}\n`;

if (process.argv.includes("--stdout")) {
  process.stdout.write(json);
} else {
  const outDir = path.join(repoRoot, "docs", "phoenix-intelligence");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "route-inventory.json"), json);
  console.log(`route-inventory: wrote ${inventory.entries.length} rows for ${inventory.roles.length} roles`);
}

if (process.argv.includes("--summary")) {
  for (const role of inventory.roles) {
    const rows = inventory.entries.filter((entry) => entry.role === role);
    const kpis = rows.filter((entry) => entry.pagePath.includes("/kpis")).map((entry) => entry.route);
    const approx = rows.filter((entry) => entry.approximate).length;
    console.log(
      `${role.padEnd(28)} ${String(rows.length).padStart(3)} rows  ${rows[0]?.portal ?? "-"}  approx=${approx}  kpis=${kpis.join(" ") || "none"}`,
    );
  }
  if (inventory.unevaluated.length > 0) {
    console.log(`unevaluated conditions: ${inventory.unevaluated.length}`);
    for (const item of inventory.unevaluated.slice(0, 10)) console.log(`  ${item.role} ${item.route} :: ${item.condition}`);
  }
}
