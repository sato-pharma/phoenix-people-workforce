/**
 * Has a month's distributor upload set landed in full — and if it has, is its frozen store split
 * now worth rebuilding?
 *
 * WHY THIS EXISTS (owner, 2026-10-09). He parked the September store-split rebuild on a condition,
 * not a date: "rebuild September's split once the last books are in, not now". A frozen month keeps
 * drifting with every upload — 2026-09 went from 839,283.83 EGP on different areas in the morning
 * to 1,030,551.19 EGP the same evening, after thirteen books landed — so the rebuild is worth
 * exactly one shot, at the end. This script is what notices the end has arrived.
 *
 * 🔴 IT JUDGES COMPLETENESS WITH THE REPO'S OWN RULE, NEVER A COUNT. "N of 17 sources" is never a
 * finding: the expectation is what fed the month BEFORE, plus whatever another source's file
 * carried for it then (EPDA-BULK), and a source that stopped months ago is not this month's hole
 * (chimipharm, last seen 2026-05). All of that lives in `summarizeMonthCompleteness`; this script
 * adds nothing of its own.
 *
 * 🔴 IT REPORTS, IT NEVER REBUILDS. Rebuilding a published month's net restates an announced
 * number, which is the owner's decision alone (AGENTS.md §4) and starts with HIS unpublish on the
 * Monthly Closing publication screen. The drift read here only tells him whether that is worth
 * doing yet.
 *
 * The expensive half is conditional on purpose: the drift read recomputes the live split for every
 * line, so it runs only once the month is complete. An incomplete month costs one batch query.
 *
 * Usage (from the repo root, with a populated .env.local — this READS PRODUCTION):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/check-sos-month-complete.ts [period] [--fail-on-incomplete]
 *
 * With no period it asks about the PREVIOUS calendar month in Cairo — the one being closed.
 * Exit code is 0 either way unless `--fail-on-incomplete` is passed, so a scheduled caller reads the
 * final `sos-month-complete:` line rather than branching on a status it cannot interpret.
 */
import { isFrozenStoreSplitPeriod } from "@/lib/sales/closing-store-split-net";
import { buildSosCoverageReport, type SosCoverageBatch } from "@/lib/sales/sos-coverage";
import { describeMonthCompleteness, summarizeMonthCompleteness } from "@/lib/sales/sos-month-complete";
import { loadStoreSplitDrift } from "@/lib/sales/store-split-drift";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const argv = process.argv.slice(2);
const failOnIncomplete = argv.includes("--fail-on-incomplete");
const requested = argv.filter((arg) => /^\d{4}-\d{2}$/.test(arg));

// An unknown flag is REFUSED rather than ignored, exactly as check-store-split-drift.ts does: an
// ignored flag runs different behaviour from the one the operator asked for while reporting success.
const unknown = argv.filter((arg) => arg.startsWith("-") && arg !== "--fail-on-incomplete");
if (unknown.length > 0) {
  console.error(`check-sos-month-complete: unknown flag(s) ${unknown.join(", ")} — refusing to run`);
  process.exit(64);
}

/** The previous calendar month in CAIRO — the owner's timezone, never the box's. */
function previousCairoMonth(): string {
  const cairoNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" }),
  );
  const year = cairoNow.getMonth() === 0 ? cairoNow.getFullYear() - 1 : cairoNow.getFullYear();
  const month = cairoNow.getMonth() === 0 ? 12 : cairoNow.getMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Every validated batch, keyset-paged on `id`.
 *
 * Paged rather than fetched flat because PostgREST caps a response at 1,000 rows and returns the
 * truncation silently — a short read here would invent coverage holes out of the rows it never saw.
 */
async function loadValidatedBatches(): Promise<SosCoverageBatch[]> {
  const supabase = getSupabaseAdmin();
  const batches: SosCoverageBatch[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from("source_of_sales_import_batches")
      // The NAME travels with the code because every line of output names sources, never codes.
      .select("id,period,distributor_code,distributor_name,total_value")
      .eq("status", "validated")
      .order("id", { ascending: true })
      .limit(1000);
    if (cursor !== null) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    for (const row of page) {
      batches.push({
        distributorCode: String(row.distributor_code ?? ""),
        distributorName: row.distributor_name == null ? null : String(row.distributor_name),
        period: String(row.period ?? ""),
        totalValue: row.total_value == null ? 0 : Number(row.total_value),
      });
    }
    if (page.length < 1000) break;
    const last = String(page[page.length - 1]?.id ?? "");
    if (!last) break; // no usable cursor — stop rather than loop forever
    cursor = last;
  }
  return batches;
}

const period = requested[0] ?? previousCairoMonth();

const batches = await loadValidatedBatches();
const summary = summarizeMonthCompleteness({
  batches,
  period,
  report: buildSosCoverageReport(batches),
});

console.log("");
console.log(describeMonthCompleteness(summary));
for (const source of summary.missing) {
  console.log(`    still missing   ${source.name}`);
}

let driftLine = "drift=not-read";
if (summary.complete) {
  // Only now: the live recompute is the expensive part, and on an incomplete month its answer is
  // guaranteed to change again with the next upload.
  const frozen = await isFrozenStoreSplitPeriod("CNS", period);
  const drift = await loadStoreSplitDrift(period);
  console.log("");
  console.log(`  store split: ${frozen ? "FROZEN (the period holds a live publication)" : "live (nothing published)"}`);
  if (drift.drifted) {
    console.log(
      `  ${drift.absoluteValueDelta.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP moved each way; ` +
        `${drift.cells.length} cell(s) across ${drift.byArea.length} line x area pair(s)`,
    );
    console.log(
      frozen
        ? "  → worth rebuilding now: the owner unpublishes the period, then the backfill and the refresh run."
        : "  → nothing to rebuild: an unpublished period already recomputes live on every read.",
    );
  } else {
    console.log("  no drift — the frozen net already matches what the rule says today.");
  }
  driftLine = `drift=${drift.drifted ? drift.absoluteValueDelta.toFixed(2) : "0"} frozen=${frozen ? "yes" : "no"}`;
}

// The machine-readable line a scheduled caller greps. Last, and one line, so a partial read cannot
// be mistaken for a verdict.
console.log("");
console.log(
  `sos-month-complete: ${summary.complete ? "COMPLETE" : "INCOMPLETE"} ${period} missing=${summary.missing.length} ${driftLine}`,
);

if (!summary.complete && failOnIncomplete) process.exit(2);
