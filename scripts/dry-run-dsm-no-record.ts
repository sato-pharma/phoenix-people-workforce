#!/usr/bin/env node
// DRY RUN ONLY — reports the DSM no-record candidates for a month, writes nothing.
//
// Safe by construction: collectDsmNoRecordCandidates returns drafts and performs
// no insert. The insert lives in collectOneConnectorForMonth, never called here.
//
//   ... scripts/dry-run-dsm-no-record.ts 2026-07

import { collectDsmNoRecordCandidates } from "../src/lib/deductions/connectors/dsm-no-record.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "dry-run-dsm-no-record",
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
    console.error("Usage: dry-run-dsm-no-record <YYYY-MM>");
    process.exit(2);
  }
  const [year, month] = monthKey.split("-").map(Number);

  console.log(`\n=== DRY RUN — DSM CRM no-record days, ${monthKey} ===`);
  console.log("Nothing is written.\n");

  const drafts = await collectDsmNoRecordCandidates({ month: month!, year: year!, createdBy: "dry-run" });

  console.log(`Would create ${drafts.length} candidate(s):\n`);
  let total = 0;
  for (const draft of drafts) {
    total += draft.estimatedAmount ?? 0;
    const days = (draft.dates ?? []).map((d) => d.slice(8, 10)).join(", ");
    console.log(
      `  ${(draft.employeeName ?? "Name unavailable").padEnd(44)} ${String(draft.rawValue).padStart(2)} day(s) ` +
        `${money(draft.estimatedAmount).padStart(11)} EGP   ${days}`,
    );
  }
  const first = drafts[0]?.evidence as Record<string, unknown> | undefined;
  if (first) {
    console.log(`\n  working days considered: ${first.workingDaysConsidered}`);
    console.log(`  holidays excluded      : ${(first.holidaysExcluded as string[] | undefined)?.join(", ") || "none"}`);
  }
  console.log(`\n  TOTAL ${String(drafts.length).padStart(3)} manager(s)   ${money(total)} EGP`);
  console.log("\n=== DRY RUN COMPLETE — nothing written ===\n");
}

main().catch((error) => {
  console.error("dry run threw:", error);
  process.exit(1);
});
