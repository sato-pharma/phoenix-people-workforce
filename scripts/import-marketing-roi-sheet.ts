// Import the historical ROI sheet into the marketing module.
//
// DRY-RUN by default (no writes). Add --execute to actually write. --limit N imports only
// the first N importable line-items (useful for a staged first-batch check).
//
//   pnpm run marketing:roi-import                  # dry-run, full sheet
//   pnpm run marketing:roi-import -- --limit 1     # dry-run, first item
//   pnpm run marketing:roi-import -- --execute     # WRITE the whole sheet
//   pnpm run marketing:roi-import -- --execute --limit 5
//
// Targets whichever Supabase project .env.local points at.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { importRoiSheetRequests } from "@/lib/marketing-requests/roi-sheet-writer";
import { readRoiSheet } from "./lib/read-roi-sheet.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "import-marketing-roi-sheet",
  entry: import.meta.url,
  known: ["--execute", "--code-as-is", "--limit"],
});

function loadEnvLocal() {
  const candidates = [
    process.env.MARKETING_ENV_FILE,
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), "..", "phoenix-workforce", ".env.local"),
  ].filter((value): value is string => Boolean(value));
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const codeAsIs = args.includes("--code-as-is");
const limitArg = args.find((a) => a.startsWith("--limit"));
const limit = limitArg
  ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1])
  : undefined;

const sheetPath = path.resolve(
  process.cwd(),
  process.env.MARKETING_ROI_SHEET_XLSX?.trim() || "ROIxx.xlsx",
);

const rows = await readRoiSheet(sheetPath);
const result = await importRoiSheetRequests({
  rows,
  dryRun: !execute,
  codeAsIs,
  limit: Number.isFinite(limit) ? (limit as number) : undefined,
});

console.log(`=== Marketing ROI import (${execute ? "EXECUTE — writing" : "DRY-RUN — no writes"}) ===`);
console.log(`source: ${sheetPath}`);
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  console.error(`\n${result.errors.length} error(s):`);
  for (const error of result.errors.slice(0, 20)) console.error(`  - ${error}`);
  process.exitCode = 1;
}
