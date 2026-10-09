/**
 * Has a PUBLISHED month moved away from what was announced — and WHICH AREAS hold the difference?
 *
 * WHY THIS EXISTS. The publication drift check answers in three numbers, and the two that read like
 * a verdict are sums over the drifted cells, so a redistribution between areas cancels to zero in
 * both. Measured on production 2026-10-09, Anti Infective 2026-09:
 *
 *     drifted_cells 27   net_units_delta 0.000000   net_value_delta 0.000000   verdict unreviewed
 *
 * while Menoufia 2 had lost 1,111.50 EGP and Giza Centers had gained 858.45 against the published
 * figures. This prints that second half — the areas — and it also folds in the store-split layer,
 * which no snapshot of `source_of_sales_fact_rollup` can see at all. See
 * src/lib/sales/closing-publication-drift.ts for both halves in full.
 *
 * 🔴 IT REPORTS, IT NEVER WRITES, AND IT EXITS 0 EVEN WHEN IT FINDS DRIFT. Re-issuing a published
 * closing or rebuilding a frozen net restates an announced number, which is the owner's decision
 * alone. Pass `--fail-on-drift` to make it exit 2 for a caller that deliberately wants a gate — but
 * think first: this is expected to be non-empty while a month is still receiving uploads, and a
 * check that fires at the normal working level becomes wallpaper.
 *
 * WHICH PERIODS. By default every period that holds a live publication row — the only ones with an
 * announced number to drift away from. Name periods to override.
 *
 * Usage (from the repo root, with a populated .env.local — this READS PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/check-closing-publication-drift.ts [--fail-on-drift] [period ...]
 */
import {
  loadClosingPublicationDrift,
  loadPublishedPeriods,
  type PublicationDriftReport,
  type PublicationLineDrift,
} from "@/lib/sales/closing-publication-drift";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const argv = process.argv.slice(2);
const failOnDrift = argv.includes("--fail-on-drift");
const requested = argv.filter((arg) => /^\d{4}-\d{2}$/.test(arg));

// An unknown flag is REFUSED rather than ignored: an ignored flag runs different behaviour from the
// one the operator asked for while reporting success.
const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--fail-on-drift");
if (unknown.length > 0) {
  console.error(`check-closing-publication-drift: unknown flag(s) ${unknown.join(", ")} — refusing to run`);
  process.exit(64);
}

const supabase = getSupabaseAdmin();

/** Area NAMES, because a report a person reads never shows a raw code (AGENTS.md §4). */
async function areaNames(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("source_of_sales_areas").select("area_code, area_name");
  if (error) throw error;
  const names = new Map<string, string>();
  for (const row of (data ?? []) as { area_code?: unknown; area_name?: unknown }[]) {
    const code = String(row?.area_code ?? "").trim().toUpperCase();
    const name = String(row?.area_name ?? "").trim();
    if (code !== "" && name !== "") names.set(code, name);
  }
  return names;
}

function money(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/**
 * `announced` says whether this line has a publication row of its own. It changes what a missing
 * cell status MEANS: for an announced line it is a failed read and must say so, for an unpublished
 * one there is simply nothing announced to compare against — reporting that as a failure would send
 * a reader chasing a broken RPC that is working perfectly.
 */
function printLine(line: PublicationLineDrift, names: Map<string, string>, announced: boolean): void {
  if (!line.drifted) {
    console.log(`  ${line.line} — clean. Nothing has moved since it was published.`);
    return;
  }

  const cell = line.cellDrift;
  const head = cell
    ? `${cell.cells} drifted cell(s), net units ${money(cell.unitsDelta)}, net value `
      + `${cell.valueDelta === null ? "(snapshot predates value)" : money(cell.valueDelta)} — verdict ${cell.verdict}`
    : announced
      ? "the publication drift status could NOT be read for this line"
      : "not published for this period — nothing is announced for it yet";
  console.log(`  ${line.line} — ${head}`);

  // The whole point of this script: the figure the net deltas cancel away.
  console.log(
    `    ${money(line.areaValueMoved)} EGP ends up on a different area, across ${line.areasMoved} area(s)`,
  );
  if (line.splitOnly && announced) {
    console.log(
      "    🔴 the publication check reports this line CLEAN — every difference is in the store-split "
      + "layer, which its snapshot cannot see",
    );
  }
  for (const move of line.areaMoves) {
    const name = names.get(move.areaCode) ?? move.areaCode;
    const sign = move.valueDelta > 0 ? "+" : "";
    console.log(
      `      ${name.padEnd(24)} ${(sign + money(move.valueDelta)).padStart(16)}`
      + `   ${move.cells} cell(s)   ${move.layer}`,
    );
  }
}

function printReport(report: PublicationDriftReport, names: Map<string, string>): void {
  // FIRST, before anything that could be read as a verdict: a line whose own read failed makes every
  // other number here incomplete, and a reader who scrolls past it would take the rest for the whole.
  if (report.linesNotRead.length > 0) {
    console.log(
      `${report.period}  —  🔴 COULD NOT BE READ for ${report.linesNotRead.join(", ")} — `
      + "the figures below are incomplete for those lines",
    );
  }
  if (!report.drifted) {
    console.log(`${report.period}  —  no drift on any published line.`);
    return;
  }
  console.log(`${report.period}  —  DRIFTED`);
  console.log(`  ${money(report.areaValueMoved)} EGP ends up on a different area across the period`);
  if (report.netDeltasReadAsClean) {
    // Said out loud rather than left for a reader to notice: this is the exact shape that made the
    // existing summary unreadable.
    console.log(
      "  🔴 every drifted line's net unit AND net value delta is ZERO — read on its own, the "
      + "publication check's summary says nothing happened here",
    );
  }
  if (report.splitOnlyLines.length > 0) {
    console.log(
      `  🔴 the publication check calls these lines clean while money moved: ${report.splitOnlyLines.join(", ")}`,
    );
  }
  for (const line of report.lines) printLine(line, names, true);

  if (report.frozenNotPublished.length === 0) return;
  // Reported apart from the announced lines on purpose: nothing here is a restatement, it is the
  // opposite exposure — what the month will be published ONTO if the net is not rebuilt first.
  console.log("");
  console.log(
    `  🔴 NOT PUBLISHED, BUT FROZEN ANYWAY — ${money(report.frozenNotPublishedValueMoved)} EGP would be `
    + "published onto the wrong area",
  );
  console.log(
    "     Publishing one line freezes the split for EVERY line in the month, so these lines' frozen",
  );
  console.log(
    "     nets have gone stale with nothing announced for them yet. Rebuild before publishing them.",
  );
  for (const line of report.frozenNotPublished) printLine(line, names, false);
}

async function main(): Promise<void> {
  const candidates = requested.length > 0 ? [...new Set(requested)].sort() : await loadPublishedPeriods();
  if (candidates.length === 0) {
    console.log("no published periods — nothing has an announced number to drift away from");
    return;
  }

  const names = await areaNames();
  console.log(`checking ${candidates.length} published period(s): ${candidates.join(", ")}\n`);
  let drifted = 0;
  for (const period of candidates) {
    const report = await loadClosingPublicationDrift(period);
    if (!report.splitLayerRead) {
      // This script exists to print the half the publication check cannot see. A report without
      // the store-split layer would print the same figures the existing check already prints.
      throw new Error(`publication drift: ${period} came back without the store-split layer`);
    }
    printReport(report, names);
    if (report.drifted) drifted += 1;
    console.log("");
  }

  if (drifted === 0) {
    console.log("No drift anywhere. Every published line still matches what it announced.");
    return;
  }
  console.log(`${drifted} published period(s) drifted.`);
  console.log("Re-issuing a published closing restates an announced number — that is the OWNER's call,");
  console.log("on the Monthly Closing publication screen. For the store-split half specifically:");
  console.log("  he unpublishes the period, then scripts/backfill-attribution-store-split.ts --apply <period>,");
  console.log("  then select au.f_refresh_monthly_attribution('<period>'), then he re-publishes.");
  if (failOnDrift) process.exit(2);
}

await main();
