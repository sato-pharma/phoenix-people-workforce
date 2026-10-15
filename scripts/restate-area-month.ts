/**
 * Restate ONE area's month through the LIVE closing engine, on the read-time Office spread.
 *
 * Why this script and not SQL. The Monthly Closing module is the only source of truth for a sales
 * figure AND the target it is divided by, and since 2026-10-09 the Office channel's area shares are
 * recomputed on every READ for CNS from the September closing (OFFICE_RESPREAD_START_PERIOD).
 * So a raw query against source_of_sales_import_rows now answers a question the closing no longer
 * asks: the stored Office rows still carry the geography their upload stamped on them, and the
 * closing moves them at read time through `officeNet`. Reading the engine is the only way to get
 * the number a manager will actually see.
 *
 * It prints, for the area asked about: own sales (everything but Office), the Office credit as the
 * closing now reads it, the Office credit as the rows are STORED, the target, and the achievement
 * both ways — plus the national conservation check, because a respread moves money between areas
 * and must never create or destroy any.
 *
 * Read-only. It writes nothing.
 *
 * Usage (from a tree on origin/main; it reads the database .env.local points at, PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/restate-area-month.ts [--area="Sohag 1"] [--line=CNS] [--period=2026-09]
 *
 * The line is matched on the engine's own label ("CNS", "Anti Infective", "Pedia") and a miss
 * falls back to the first line SILENTLY — measured 2026-10-09, {line:"cns"} returned Anti
 * Infective's whole matrix for the right period with no error at all. So the line the engine
 * answered with is checked against the one asked for before a number is printed. Area names carry
 * no space either ("Sohag1"); both are normalised here.
 */
import { loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { OFFICE_RESPREAD_START_PERIOD } from "@/lib/sales/office-distributor";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "restate-area-month",
  entry: import.meta.url,
  known: ["--area", "--line", "--period"],
});

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// The data spells areas without a space ("Sohag1"), and the loader matches a LINE on its own label
// ("CNS", not "cns") — a miss falls back to the first line silently, which is how a restatement of
// CNS could come back carrying Anti Infective's numbers. Both are normalised, and the line the
// engine answered with is checked against the one asked for before anything is printed.
const key = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const areaWanted = key(flag("area", "Sohag 1"));
const line = flag("line", "CNS");
const period = flag("period", "2026-09");

const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const units = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

type Row = {
  areaCode: string;
  areaName: string;
  regionName: string;
  rowTotal: { salesUnits: number; salesValue: number; targetUnits: number | null; targetValue: number | null; achievement: number | null };
};

function findArea(regions: { areas: Row[] }[], wanted: string): Row | null {
  for (const region of regions) {
    for (const area of region.areas) {
      if (key(area.areaName) === wanted || key(area.areaCode) === wanted) return area;
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log(`Restating ${flag("area", "Sohag 1")} — ${line.toUpperCase()} ${period}, through the live closing engine.`);
  console.log(
    `Office read-time respread starts ${OFFICE_RESPREAD_START_PERIOD}, so this month is ${period >= OFFICE_RESPREAD_START_PERIOD ? "RECOMPUTED on every read" : "read from the stored rows"}.`,
  );

  const [parts, split] = await Promise.all([
    loadMonthlyClosingPartsWithStoreSplit({ line, period }),
    loadClosingStoreSplit(line, period),
  ]);

  if (key(String(parts.combined.line ?? "")) !== key(line) || parts.combined.period !== period) {
    throw new Error(
      `the engine answered ${parts.combined.line} ${parts.combined.period}, not ${line} ${period} — a line label that does not match falls back silently, so nothing is printed (available: ${parts.combined.availableLines.join(", ")})`,
    );
  }

  const combined = findArea(parts.combined.regions as unknown as { areas: Row[] }[], areaWanted);
  if (!combined) throw new Error(`no area row for "${flag("area", "Sohag 1")}" in ${line} ${period}`);
  const officeRow = parts.office
    ? findArea(parts.office.regions as unknown as { areas: Row[] }[], areaWanted)
    : null;

  // The Office slice the respread moved, for this area and nationally.
  let areaNetValue = 0;
  let areaNetQty = 0;
  let nationalNetValue = 0;
  let nationalNetQty = 0;
  let movedOut = 0;
  let movedIn = 0;
  const byArea = new Map<string, { qty: number; value: number }>();
  for (const [key, cell] of split.officeNet) {
    const areaCode = key.split("|")[0];
    const seen = byArea.get(areaCode) ?? { qty: 0, value: 0 };
    byArea.set(areaCode, { qty: seen.qty + cell.qty, value: seen.value + cell.value });
    nationalNetValue += cell.value;
    nationalNetQty += cell.qty;
    if (areaCode === combined.areaCode) {
      areaNetValue += cell.value;
      areaNetQty += cell.qty;
    }
  }
  for (const cell of byArea.values()) {
    if (cell.value < 0) movedOut += cell.value;
    else movedIn += cell.value;
  }

  const officeAfter = officeRow?.rowTotal ?? { salesUnits: 0, salesValue: 0 };
  const officeBeforeValue = officeAfter.salesValue - areaNetValue;
  const officeBeforeUnits = officeAfter.salesUnits - areaNetQty;
  const totalAfter = combined.rowTotal;
  const totalBeforeValue = totalAfter.salesValue - areaNetValue;
  const ownSales = totalAfter.salesValue - officeAfter.salesValue;
  const target = totalAfter.targetValue;
  const achAfter = target && target > 0 ? totalAfter.salesValue / target : null;
  const achBefore = target && target > 0 ? totalBeforeValue / target : null;
  const achOwnOnly = target && target > 0 ? ownSales / target : null;

  console.log(`\n${combined.areaName} — ${combined.regionName}, ${line.toUpperCase()} ${period}`);
  console.log(`  own sales (everything but Office)   ${money(ownSales).padStart(16)} EGP`);
  console.log(`  Office credit, AS THE CLOSING READS IT NOW  ${money(officeAfter.salesValue).padStart(16)} EGP   ${units(officeAfter.salesUnits)} units`);
  console.log(`  Office credit, as the rows are STORED       ${money(officeBeforeValue).padStart(16)} EGP   ${units(officeBeforeUnits)} units`);
  console.log(`  the respread moves                          ${money(areaNetValue).padStart(16)} EGP   ${units(areaNetQty)} units`);
  console.log(`  total sales now                     ${money(totalAfter.salesValue).padStart(16)} EGP`);
  console.log(`  total sales on the stored spread     ${money(totalBeforeValue).padStart(16)} EGP`);
  console.log(`  target                              ${money(target ?? 0).padStart(16)} EGP`);
  console.log(`  ACHIEVEMENT now                     ${pct(achAfter).padStart(16)}   (engine says ${pct(totalAfter.achievement)})`);
  console.log(`  achievement on the stored spread    ${pct(achBefore).padStart(16)}`);
  console.log(`  achievement on its OWN sales alone  ${pct(achOwnOnly).padStart(16)}`);

  console.log(`\nNational conservation of the Office respread (${line.toUpperCase()} ${period})`);
  console.log(`  areas that lose credit               ${money(movedOut).padStart(16)} EGP`);
  console.log(`  areas that gain credit               ${money(movedIn).padStart(16)} EGP`);
  console.log(`  NET (must be ~0.00 — credit only moves) ${money(nationalNetValue).padStart(13)} EGP   ${units(nationalNetQty)} units`);
  console.log(`  areas the respread touches           ${byArea.size}`);

  const national = parts.combined.grandTotal?.rowTotal;
  if (national) {
    console.log(
      `  national ${line.toUpperCase()} ${period} sales          ${money(national.salesValue).padStart(16)} EGP`,
    );
    console.log(
      `  ${combined.areaName}'s share of it            ${((totalAfter.salesValue / national.salesValue) * 100).toFixed(2)}%`,
    );
  }

  const biggest = [...byArea.entries()].sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value)).slice(0, 8);
  console.log(`\nThe eight largest movements, by value`);
  for (const [areaCode, cell] of biggest) {
    const name =
      findArea(parts.combined.regions as unknown as { areas: Row[] }[], areaCode.toLowerCase())?.areaName ?? areaCode;
    console.log(`  ${name.padEnd(26)} ${(cell.value >= 0 ? "+" : "") + money(cell.value)} EGP   ${(cell.qty >= 0 ? "+" : "") + units(cell.qty)} units`);
  }
}

await main();
