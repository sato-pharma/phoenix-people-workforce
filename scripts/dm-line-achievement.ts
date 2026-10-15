/**
 * Every district manager's achievement for a month, on all three tracked lines at once.
 *
 * Why it reads the Performance Review and not the seat tables. The review already answers "whose
 * areas are these" the way the rest of the system does: the manager is the REP seat's PARENT seat
 * in the AU organogram, dated to the end of the month being read, so an acting DM is picked up
 * automatically and authority follows the seat rather than a job title. Re-deriving a DM from area
 * codes or from `dm_seat_id` would be a second implementation that agrees with it today and drifts
 * tomorrow. `loadClosingPerformanceReview` also carries the closing's own sales AND target through
 * the live engine, which is what the area listing printed, so the two cannot disagree.
 *
 * It prints, per line, each manager's areas, sales, target and achievement; then one combined table
 * across the three lines, with each manager's total (summed VALUE over summed target — never an
 * average of percentages, and never units, which are not addable across products).
 *
 * An area whose rep seat hangs off the organogram's catch-all pseudo-DM has no manager, and the
 * review labels it "<region> · no manager seat" rather than inventing one. Those rows are kept and
 * marked, because dropping them would make the line's manager rows add up to less than the line.
 *
 * Read-only. It writes nothing.
 *
 * Usage (from a tree on origin/main; it reads the database .env.local points at, PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/dm-line-achievement.ts [--period=2026-09] [--lines=CNS,Pedia,Anti Infective]
 */
import { loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";
import { isOfficeRespreadPair } from "@/lib/sales/office-distributor";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "dm-line-achievement",
  entry: import.meta.url,
  known: ["--period", "--lines"],
});

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const period = flag("period", "2026-09");
const lines = flag("lines", "CNS,Pedia,Anti Infective")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const key = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

type Group = {
  achievement: number | null;
  areaCount: number;
  label: string;
  regionName: string;
  salesValue: number;
  targetValue: number | null;
};

function table(head: string[], body: string[][], leftColumns = 1): void {
  const width = head.map((_, column) =>
    Math.max(head[column].length, ...body.map((cells) => cells[column].length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column < leftColumns ? cell.padEnd(width[column]) : cell.padStart(width[column]),
      )
      .join("  ");
  console.log(render(head));
  console.log(width.map((size) => "-".repeat(size)).join("  "));
  for (const cells of body) console.log(render(cells));
}

async function main(): Promise<void> {
  console.log(`District manager achievement — ${period}, ${lines.join(" · ")}.`);
  console.log(
    "Manager = the rep seat's parent seat in the organogram, as it stood at the end of the month. Sales and target both come from the live closing engine, so CNS carries the read-time Office respread.",
  );

  const perLine = new Map<string, Group[]>();
  for (const line of lines) {
    const review = await loadClosingPerformanceReview({ line, period, months: 2 });
    if (key(String(review.line ?? "")) !== key(line) || review.period !== period) {
      throw new Error(
        `the engine answered ${review.line} ${review.period}, not ${line} ${period} — a line label that does not match falls back silently (available: ${review.availableLines.join(", ")})`,
      );
    }
    perLine.set(line, review.managers as Group[]);

    // On a line the respread touches, a manager's figure is only readable beside the one his areas
    // were carrying before it — the whole point of the rule is that it moves credit between areas,
    // and areas roll up into managers. The net is summed per area from the SAME split the closing
    // read, then attributed to the manager the review gave that area.
    const moved = new Map<string, number>();
    if (isOfficeRespreadPair(line, period)) {
      const labelByArea = new Map(
        review.areas.map((area) => [
          area.areaCode,
          area.managerName ?? `${area.regionName} · no manager seat`,
        ]),
      );
      const split = await loadClosingStoreSplit(line, period);
      for (const [cellKey, cell] of split.officeNet) {
        const label = labelByArea.get(cellKey.split("|")[0]);
        if (!label) continue;
        moved.set(label, (moved.get(label) ?? 0) + cell.value);
      }
    }

    const rows = [...(review.managers as Group[])].sort(
      (a, b) => (b.achievement ?? -1) - (a.achievement ?? -1),
    );
    console.log(`\n${line.toUpperCase()} ${period} — ${rows.length} manager rows`);
    const respread = moved.size > 0;
    table(
      [
        "district manager",
        "region",
        "areas",
        "sales EGP",
        "target EGP",
        ...(respread ? ["stored", "live", "moved EGP"] : ["achievement"]),
      ],
      rows.map((row) => {
        const net = moved.get(row.label) ?? 0;
        const target = row.targetValue;
        const stored =
          target && target > 0 ? pct((row.salesValue - net) / target) : "—";
        return [
          row.label,
          row.regionName,
          String(row.areaCount),
          money(row.salesValue),
          target === null ? "—" : money(target),
          ...(respread
            ? [stored, pct(row.achievement), net === 0 ? "—" : `${net > 0 ? "+" : ""}${money(net)}`]
            : [pct(row.achievement)]),
        ];
      }),
      2,
    );
    const totals = review.totals;
    console.log(
      `  line total ${money(totals.salesValue)} EGP against ${totals.targetValue === null ? "—" : money(totals.targetValue)} = ${pct(totals.achievement)}`,
    );
    const named = rows.filter((row) => !row.label.includes("no manager seat"));
    const managed = named.reduce((sum, row) => sum + row.salesValue, 0);
    console.log(
      `  under a named manager: ${named.length} of ${rows.length} rows, ${money(managed)} EGP (${((managed / (totals.salesValue || 1)) * 100).toFixed(1)}% of the line).`,
    );
  }

  // One row per manager across the lines. A DM normally runs one line's areas, so most rows carry a
  // single figure — the combined column exists for the few who carry more than one, and for reading
  // the three lines side by side without flipping between tables.
  const combined = new Map<
    string,
    { label: string; byLine: Map<string, Group>; sales: number; target: number | null }
  >();
  for (const [line, groups] of perLine) {
    for (const group of groups) {
      const seen = combined.get(group.label) ?? {
        label: group.label,
        byLine: new Map<string, Group>(),
        sales: 0,
        target: null,
      };
      seen.byLine.set(line, group);
      seen.sales += group.salesValue;
      if (group.targetValue !== null) seen.target = (seen.target ?? 0) + group.targetValue;
      combined.set(group.label, seen);
    }
  }

  const rows = [...combined.values()]
    .map((row) => ({
      ...row,
      achievement: row.target && row.target > 0 ? row.sales / row.target : null,
    }))
    .sort((a, b) => (b.achievement ?? -1) - (a.achievement ?? -1));

  console.log(`\nAll three lines together — ${rows.length} managers, ${period}`);
  table(
    ["district manager", ...lines.map((line) => line), "total sales EGP", "total"],
    rows.map((row) => [
      row.label,
      ...lines.map((line) => {
        const group = row.byLine.get(line);
        return group ? pct(group.achievement) : "—";
      }),
      money(row.sales),
      pct(row.achievement),
    ]),
  );

  const several = rows.filter((row) => row.byLine.size > 1);
  console.log(
    `\n${several.length} manager row(s) appear on more than one line${several.length > 0 ? `: ${several.map((row) => row.label).join(", ")}` : ""}.`,
  );
  const unmanaged = rows.filter((row) => row.label.includes("no manager seat"));
  if (unmanaged.length > 0) {
    console.log(
      `${unmanaged.length} row(s) have no manager seat at all — ${unmanaged.map((row) => `${row.label} (${money(row.sales)} EGP)`).join(", ")}.`,
    );
  }
}

await main();
