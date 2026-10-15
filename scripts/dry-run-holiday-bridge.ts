#!/usr/bin/env node
// DRY RUN ONLY — reports what the governmental-holiday bridging connector WOULD
// create for a month, and writes nothing.
//
// Safe by construction, not by promise: `collectHolidayBridgeCandidates` returns
// drafts and performs no insert. The insert lives in `collectOneConnectorForMonth`
// (service.insertCandidateDrafts), which this script never calls. Nothing here
// touches deductions_candidates.
//
//   pnpm run dry-run:holiday-bridge -- 2026-07

import { getHolidayBridgeDaysForMonth } from "../src/lib/deductions/service.ts";
import { collectHolidayBridgeCandidates } from "../src/lib/deductions/connectors/holiday-bridge.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "dry-run-holiday-bridge",
  entry: import.meta.url,
  known: [],
});

function money(value: number | null | undefined): string {
  if (value == null) return "requires review";
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value);
}

async function main() {
  const monthKey = process.argv[2] ?? "";
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    console.error("Usage: dry-run-holiday-bridge <YYYY-MM>");
    process.exit(2);
  }
  const [year, month] = monthKey.split("-").map(Number);

  console.log(`\n=== DRY RUN — governmental-holiday bridging, ${monthKey} ===`);
  console.log("Nothing is written. This only reports what a real collection would create.\n");

  const { bridgeDays, calendarReachable } = await getHolidayBridgeDaysForMonth(monthKey);
  console.log(`Egypt holiday calendar reachable: ${calendarReachable ? "yes" : "NO"}`);
  if (!calendarReachable) {
    console.log(
      "\nThe holiday list may be incomplete, so the connector REFUSES rather than risk\n" +
        "deducting a day that was actually a public holiday. Nothing would be created.\n",
    );
  }

  console.log(`\nBridge days found: ${bridgeDays.length}`);
  for (const bridge of bridgeDays) {
    console.log(
      `  ${bridge.date}  ${bridge.adjacentTo.padEnd(6)}  ${bridge.holidayName}` +
        `  (holiday ${bridge.holidayStartDate}${bridge.holidayEndDate !== bridge.holidayStartDate ? `..${bridge.holidayEndDate}` : ""})`,
    );
  }

  let drafts: Awaited<ReturnType<typeof collectHolidayBridgeCandidates>> = [];
  try {
    drafts = await collectHolidayBridgeCandidates({ month, year, createdBy: "dry-run" });
  } catch (error) {
    console.log(`\nConnector refused: ${error instanceof Error ? error.message : String(error)}`);
    console.log("\n=== DRY RUN COMPLETE — nothing written ===\n");
    return;
  }

  console.log(`\nWould create ${drafts.length} candidate(s):\n`);
  let total = 0;
  const byCause = new Map<string, number>();
  for (const draft of drafts) {
    const cause = String((draft.evidence as Record<string, unknown> | undefined)?.cause ?? "?");
    byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
    total += draft.estimatedAmount ?? 0;
    // Employee NAME, never the HR code.
    console.log(
      `  ${(draft.employeeName ?? "Name unavailable").padEnd(42)} ${draft.dates[0]}  ` +
        `${cause.padEnd(10)} ${money(draft.estimatedAmount).padStart(10)} EGP`,
    );
  }

  console.log(`\n  ${"TOTAL".padEnd(42)} ${String(drafts.length).padStart(10)} day(s)  ${money(total).padStart(10)} EGP`);
  for (const [cause, count] of byCause) console.log(`    by cause — ${cause}: ${count}`);
  console.log("\n=== DRY RUN COMPLETE — nothing written ===\n");
}

main().catch((error) => {
  console.error("dry run threw:", error);
  process.exit(1);
});
