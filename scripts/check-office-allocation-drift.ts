/**
 * Has a month's committed Office allocation drifted away from where the rule would put it today?
 *
 * WHY THIS EXISTS. The Office channel carries no geography, so the owner's golden rule spreads it by
 * each area's share of the line's NON-Office value — and those shares are computed once, when the
 * Office file is committed, then written into the rows. Nothing re-runs them. So a distributor batch
 * whose customers are re-resolved AFTER the Office commit moves the base underneath a spread that is
 * already frozen, and until this existed nothing anywhere said so.
 *
 * 🔴 IT COMPARES WHERE THE UNITS SIT, AND BOTH SIDES TOTAL THE SAME UNITS PER LINE BY CONSTRUCTION.
 * The publication drift check compares a line's total units — one scalar — so it is structurally
 * blind to every difference printed here. See src/lib/sales/office-allocation-drift.ts.
 *
 * 🔴 IT REPORTS, IT NEVER WRITES, AND IT EXITS 0 EVEN WHEN IT FINDS DRIFT. Re-allocating a published
 * month restates an announced number, and a published and announced month is never corrected however
 * justified the fix (the owner's rule of 2026-09-07). Pass `--fail-on-drift` to make it exit 2 for a
 * caller that deliberately wants a gate — but think first: this is expected to be non-empty on
 * August 2026 until he decides otherwise, and a check that fires at the normal working level becomes
 * wallpaper.
 *
 * WHICH PERIODS. By default every period that has an Office batch. Name periods to override.
 *
 * Usage (from the repo root, with a populated .env.local — this READS PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/check-office-allocation-drift.ts [--fail-on-drift] [period ...]
 */
import {
  loadOfficeAllocationDrift,
  loadPeriodsWithOfficeBatch,
  type OfficeAllocationDriftReport,
} from "@/lib/sales/office-allocation-drift";
import { assertTreeIsCurrent } from "./lib/tree-is-current.ts";

const argv = process.argv.slice(2);
const failOnDrift = argv.includes("--fail-on-drift");
const requested = argv.filter((arg) => /^\d{4}-\d{2}$/.test(arg));

// An unknown flag is REFUSED rather than ignored: an ignored flag runs different behaviour from the
// one the operator asked for while reporting success.
const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--fail-on-drift");
if (unknown.length > 0) {
  console.error(`check-office-allocation-drift: unknown flag(s) ${unknown.join(", ")} — refusing to run`);
  process.exit(64);
}

/** Cairo local, never raw UTC — every time this repo prints is Cairo. */
function cairo(instant: string | null): string {
  if (!instant) return "never";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(date);
}

function print(report: OfficeAllocationDriftReport): void {
  if (!report.officeCommittedAt) {
    console.log(`\n${report.period}  no Office batch — nothing is frozen, so nothing can be stale`);
    return;
  }
  console.log(`\n${report.period}  Office committed ${cairo(report.officeCommittedAt)} Cairo`);
  if (report.baseTouchedAfterCommit.length > 0) {
    const names = report.baseTouchedAfterCommit
      .map((batch) => `${batch.distributorCode} (${cairo(batch.updatedAt)})`)
      .join(", ");
    console.log(`  base moved AFTER the commit: ${names}`);
  } else {
    console.log("  no brick-carrying batch was touched after the commit");
  }
  if (!report.drifted) {
    console.log("  -> the stored spread still matches the rule");
    return;
  }
  for (const line of report.lines) {
    console.log(
      `  ${line.lineCode}: ${line.unitsThatWouldMove.toFixed(0)} of ${line.officeUnits.toFixed(0)} Office units` +
        ` (${line.percentOfOfficeUnits.toFixed(2)}%) belong in a different area`,
    );
    for (const area of line.areas.slice(0, 8)) {
      const sign = area.unitsDelta > 0 ? "+" : "";
      console.log(
        `      ${area.areaCode.padEnd(6)} stored ${area.storedUnits.toFixed(0).padStart(7)}` +
          `   today ${area.todaysUnits.toFixed(0).padStart(7)}   ${sign}${area.unitsDelta.toFixed(0)}`,
      );
    }
    if (line.areas.length > 8) console.log(`      ... and ${line.areas.length - 8} more area(s)`);
  }
  console.log(
    `  line unit totals agree on both sides: ${report.lineUnitTotalsAgree}` +
      " — which is why the publication drift check cannot see any of this",
  );
}

// 🔴 THIS SCRIPT RECOMPUTES THE RULE, so the checkout it runs in is one of its inputs: today's side
// is built by this tree's own `buildOfficeAreaWeightsByLine`. A tree behind `origin/main` therefore
// answers with superseded shares and prints the result as production's. Refused after the flag
// check, so bad flags still exit 64 whatever the tree, and before the first production read.
assertTreeIsCurrent("check-office-allocation-drift");

const periods = requested.length > 0 ? requested : await loadPeriodsWithOfficeBatch();
let drifted = 0;
for (const period of periods) {
  const report = await loadOfficeAllocationDrift(period);
  print(report);
  if (report.drifted) drifted += 1;
}

console.log(
  `\nread ${periods.length} period(s); ${drifted} with drift. Nothing was written —` +
    " re-allocating a published month restates an announced number and is the owner's decision alone.",
);
if (drifted > 0 && failOnDrift) process.exit(2);
