#!/usr/bin/env node
// Runs ONE connector — holiday_bridge — for one month, and writes its candidates.
//
// Deliberately not the full collection. The other four connectors already
// produced this month's candidates; re-running them could create rows unrelated
// to the change being validated, so this drives a single registered connector
// through the same entry point the admin UI uses.
//
//   pnpm exec ... scripts/run-holiday-bridge-collection.ts 2026-07

import { collectOneConnectorForMonth } from "../src/lib/deductions/collect.ts";

async function main() {
  const monthKey = process.argv[2] ?? "";
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    console.error("Usage: run-holiday-bridge-collection <YYYY-MM>");
    process.exit(2);
  }
  const [year, month] = monthKey.split("-").map(Number);

  console.log(`\n=== RUNNING holiday_bridge collection for ${monthKey} ===\n`);
  const result = await collectOneConnectorForMonth({
    month: month!,
    year: year!,
    createdBy: "holiday-bridge-collection",
    connector: "holiday_bridge",
  });

  console.log(`created         : ${result.created}`);
  console.log(`skippedExisting : ${result.skippedExisting}`);
  console.log(`warnings        : ${result.warnings.length}`);
  for (const warning of result.warnings) console.log(`  - ${warning}`);
  console.log("\n=== DONE ===\n");
}

main().catch((error) => {
  console.error("collection threw:", error);
  process.exit(1);
});
