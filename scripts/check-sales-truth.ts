// Does every sales surface print the same number for the same area? Read-only.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//     scripts/check-sales-truth.ts [YYYY-MM]
//
// Or: pnpm run sales:check-truth            (EVERY month that has closing data)
//     pnpm run sales:check-truth -- 2026-07 (one month)
//
// Monthly Closing is the truth; every other surface is measured against it, area by area, in money.
// Exits 1 on any mismatch so a cron or a CI job can gate on it. Reads production when .env.local is
// loaded, and writes nothing anywhere.
//
// It sweeps ALL months by default on purpose. The running month is usually clean because little has
// been loaded into it yet, so checking only the newest month is how a broken published month goes
// unnoticed — which is exactly what had happened when this was written.

import { describeSurfaceResult, type SalesTruthReport } from "@/lib/sales/sales-truth-reconciliation";
import { loadSalesTruthReport, loadSalesTruthReports } from "@/lib/sales/sales-truth-report";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-sales-truth",
  entry: import.meta.url,
  known: ["--verbose"],
});

const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function printReport(report: SalesTruthReport, verbose: boolean): void {
  const header = `── ${report.period} ${report.ok ? "— every surface agrees" : "— MISMATCH"}`;
  console.log(`\n${header}`);

  if (report.unreadableLines.length > 0) {
    console.log(`  ! closing unreadable for: ${report.unreadableLines.join(", ")} — NOT compared`);
  }

  for (const surface of report.surfaces) {
    console.log(`  ${surface.ok ? "PASS" : "FAIL"}  ${describeSurfaceResult(surface)}`);
    if (surface.ok && !verbose) continue;
    console.log(
      `        closing total ${money(surface.closingTotal)}   surface total ${money(surface.surfaceTotal)}`,
    );
    for (const finding of surface.findings.slice(0, 40)) {
      console.log(
        `        ${finding.lineName.padEnd(15)} ${finding.areaName.padEnd(24)}` +
          ` closing ${money(finding.closingValue).padStart(14)}` +
          `  surface ${money(finding.surfaceValue).padStart(14)}` +
          `  diff ${money(finding.diff).padStart(14)}  ${finding.kind}`,
      );
    }
    if (surface.findings.length > 40) console.log(`        … and ${surface.findings.length - 40} more`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args.find((argument) => /^\d{4}-\d{2}$/.test(argument)) ?? null;
  const verbose = args.includes("--verbose");

  const reports = requested ? [await loadSalesTruthReport(requested)] : await loadSalesTruthReports();

  console.log("\nSALES TRUTH CHECK   (Monthly Closing is the source of truth)");
  if (reports.length === 0 || reports.every((report) => !report.period)) {
    console.log("\nNo closing period available — nothing to reconcile.\n");
    return;
  }

  for (const report of reports) printReport(report, verbose);

  const failed = reports.filter((report) => !report.ok);
  if (failed.length === 0) {
    console.log(
      `\nEVERY SURFACE AGREES WITH MONTHLY CLOSING ON EVERY AREA, ` +
        `across ${reports.length} month${reports.length === 1 ? "" : "s"}.\n`,
    );
    return;
  }
  console.log(
    `\nMISMATCH in ${failed.length} month${failed.length === 1 ? "" : "s"}: ` +
      `${failed.map((report) => report.period).join(", ")}\n`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("sales truth check failed to run:", error);
  process.exit(2);
});
