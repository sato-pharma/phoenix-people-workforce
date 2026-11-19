/**
 * Writes scripts/phoenix-inspect/generated/side-effect-routes.json: every API route whose GET writes,
 * serves a file or spends a paid quota, and every page whose server render writes, read from the app's
 * own source and its access registry (lib/side-effect-routes.ts). lib/fence.mjs refuses all of them.
 *
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --import ./tests/register-alias-loader.mjs scripts/phoenix-inspect/side-effect-routes.ts
 *
 * `--check` writes nothing and exits 1 when the committed file is stale. `--stdout` prints instead of
 * writing. Pure: no database, no network, no environment variables.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSideEffectList } from "./lib/side-effect-routes.ts";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "side-effect-routes",
  entry: import.meta.url,
  known: ["--check", "--stdout"],
});

export function renderSideEffectList(repoRoot: string): string {
  const list = buildSideEffectList(repoRoot);
  const rows = (items: { pattern: string }[]) => items.map((item) => `    ${JSON.stringify(item)}`).join(",\n");
  return `{\n  "note": ${JSON.stringify(list.note)},\n  "apiRoutes": [\n${rows(list.apiRoutes)}\n  ],\n  "renderWriterPages": [\n${rows(list.renderWriterPages)}\n  ]\n}\n`;
}

const repoRoot = process.cwd();
const target = path.join(repoRoot, "scripts", "phoenix-inspect", "generated", "side-effect-routes.json");
const json = renderSideEffectList(repoRoot);

if (process.argv.includes("--stdout")) {
  process.stdout.write(json);
} else if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== json) {
    console.error("side-effect-routes: STALE — re-run scripts/phoenix-inspect/side-effect-routes.ts and commit the result");
    process.exit(1);
  }
  console.log("side-effect-routes: current");
} else {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, json);
  const parsed = JSON.parse(json);
  console.log(`side-effect-routes: wrote ${parsed.apiRoutes.length} API routes and ${parsed.renderWriterPages.length} render-writer pages`);
}
