// Pay a weekly row to the AREAS its depot actually serves, instead of stopping at the manager above
// them all.
//
// THE OWNER'S RULE, 2026-08-27, in his own framing: a branch called "Minia and Assiut" distributes
// fifty percent of the money to Minia and fifty to Assiut; Minia then divides by two, so each Minia
// rep gets half of that. And on where the areas come from: "your source of trust in any
// distribution is the AU organogram."
//
// So a depot serving several territories is NOT unmappable. Its money spreads evenly across the
// places its name names, then evenly again inside each place, using the organogram's own line->area
// map. branch-name-scope.ts reads the name, branch-area-split.ts turns that reading into per-area
// weights ON ONE LINE, and this file applies those weights to the rows. Measured on production
// 2026-08-27 across CNS, Anti Infective and Pedia: EGP 55,319,105 that reached only a manager now
// reaches the areas — and therefore the reps — that earned it.
//
// FOUR THINGS ARE DELIBERATELY LEFT ALONE
//   1. A row that already carries an area. The owner mapped that branch by hand, and a hand mapping
//      outranks anything read out of a name. It is also how he OVERRIDES a reading he disagrees
//      with: set the Area on the mapping sheet and the split stops touching that branch.
//   2. A warehouse, a private hospital or a tender — see NON_TERRITORY_CLASSES. EGP 1,786,103.
//   3. A name that states no place AND carries no usable region: "Direct – National" is booked to
//      NATIONAL and "Unallocated POS" to nothing, and neither resolves to a single area. EGP
//      434,461 stays exactly where it is today.
//   4. Any line the organogram does not map a named place on. That part drops out and the remaining
//      parts share the whole, so a branch never short-pays because one place it names has no seat
//      on the line being measured.
//
// VALUE IS CONSERVED EXACTLY, not to a rounding tolerance. The parts are cut with splitProRata —
// the same largest-remainder split Monthly Closing uses on Direct — so they add back to the
// original to the last piastre. A mapping decision must never move a national total.

import { splitProRata } from "@/lib/sales/closing-organogram-regions";
import { lineName, SALES_LINES } from "@/lib/sales/monthly-targets";
import {
  describeBranchAreaShares,
  resolveBranchAreaShares,
  type WeeklyAreaShare,
  type WeeklyAreaSplitIndex,
} from "@/lib/sales/weekly/branch-area-split";
import { readWeeklyBranchName, type WeeklyBranchClass } from "@/lib/sales/weekly/branch-name-scope";
import { isWeeklyTrackedLine } from "@/lib/sales/weekly/tracked-lines";

/**
 * The fields a row must expose to be split. Deliberately structural rather than
 * `WeeklyFactExportRow`, so the same function can be pointed at any row shape carrying a branch,
 * a line and money — and so a test fixture does not have to invent twenty irrelevant fields.
 */
export type WeeklySplittableRow = {
  line: string;
  regionCode: string;
  areaCode: string | null;
  branchName: string;
  branchCode: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
};

export type WeeklyBranchSplitStats = {
  rowsIn: number;
  rowsOut: number;
  /** Branches whose name placed them somewhere — one area or several. */
  branchesPlaced: number;
  /** Branches whose value was divided across more than one area. */
  branchesSplit: number;
  /** Value that moved from region-level attribution down to areas. */
  valuePlaced: number;
};

const ZERO_STATS = (): WeeklyBranchSplitStats => ({
  rowsIn: 0, rowsOut: 0, branchesPlaced: 0, branchesSplit: 0, valuePlaced: 0,
});

/**
 * Expand each row into one row per area its branch serves, with the money divided by weight.
 *
 * Returns the SAME array reference when nothing could be split, so a caller that only ever sees
 * hand-mapped branches pays nothing for the feature.
 */
export function splitWeeklyRowsByBranch<T extends WeeklySplittableRow>(
  rows: T[],
  index: WeeklyAreaSplitIndex | null | undefined,
): { rows: T[]; stats: WeeklyBranchSplitStats } {
  const stats = ZERO_STATS();
  stats.rowsIn = rows.length;
  if (!index) {
    stats.rowsOut = rows.length;
    return { rows, stats };
  }

  // One reading per (line, branch): a depot repeats across every product and every week, and the
  // name says the same thing every time.
  const cache = new Map<string, WeeklyAreaShare[]>();
  const placedBranches = new Set<string>();
  const splitBranches = new Set<string>();

  const sharesFor = (row: WeeklySplittableRow): WeeklyAreaShare[] => {
    const branchKey = `${row.branchName}||${row.branchCode}||${row.regionCode}`;
    const key = `${row.line}||${branchKey}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const reading = readWeeklyBranchName(index, row.branchName || row.branchCode, row.regionCode);
    const shares = resolveBranchAreaShares(index, row.line, reading.scope)
      .slice()
      // Deterministic, so the pro-rata remainder always lands on the same area for the same branch
      // and two exports of the same week agree to the piastre.
      .sort((a, z) => a.areaCode.localeCompare(z.areaCode));
    cache.set(key, shares);
    if (shares.length > 0) placedBranches.add(branchKey);
    if (shares.length > 1) splitBranches.add(branchKey);
    return shares;
  };

  const out: T[] = [];
  let changed = false;
  for (const row of rows) {
    // Rule 1: the owner's own area mapping wins outright, and is how he overrides a reading.
    if (String(row.areaCode ?? "").trim()) {
      out.push(row);
      continue;
    }
    const shares = sharesFor(row);
    if (shares.length === 0) {
      out.push(row);
      continue;
    }
    changed = true;
    stats.valuePlaced += row.salesValue;
    if (shares.length === 1) {
      out.push({ ...row, areaCode: shares[0].areaCode });
      continue;
    }
    const weights = shares.map((share) => share.weight);
    const value = splitProRata(row.salesValue, weights);
    const units = splitProRata(row.salesUnits, weights);
    const stock = splitProRata(row.stockUnits, weights);
    shares.forEach((share, i) => {
      out.push({
        ...row,
        areaCode: share.areaCode,
        salesValue: value[i],
        salesUnits: units[i],
        stockUnits: stock[i],
      });
    });
  }

  stats.branchesPlaced = placedBranches.size;
  stats.branchesSplit = splitBranches.size;
  stats.rowsOut = changed ? out.length : rows.length;
  return { rows: changed ? out : rows, stats };
}

// ── What the mapping sheet shows ─────────────────────────────────────────────────────────────────
// The owner's instruction was not only "apply it" but "this concept you must show in the weekly
// mapping sheet that we are doing, with calculation like this". So the arithmetic is rendered for
// the same screen the mapping is done on, per line, rather than described in prose somewhere else.

/** The lines Weekly Sales is about, as official names. See tracked-lines.ts for the golden rule. */
const TRACKED_LINE_NAMES: string[] = SALES_LINES.map((line) => lineName(line.code)).filter((name) =>
  isWeeklyTrackedLine(name),
);

/** One area's cut, already rendered — so a screen can lay the parts out without redoing the maths. */
export type WeeklyBranchSplitShare = {
  areaCode: string;
  areaName: string;
  /** "25%" or "11.11%": the same rounding the workbook prints, so the two can never disagree. */
  percentLabel: string;
};

export type WeeklyBranchSplitArithmetic = {
  /** The lines that share this exact arithmetic — usually all three, so it is stated once. */
  lines: string[];
  /** "UE1 Minia 1 25%   ·   UE2 Minia 2 25%   ·   ..." — describeBranchAreaShares' own wording. */
  formula: string;
  /**
   * The same arithmetic as parts rather than one string.
   *
   * The owner's rule is that text must never be truncated and never wrap. A nine-area split is far
   * too long for a table cell, so the screen lays the parts out as separate chips — each one whole,
   * each one on a single line — instead of cutting the sentence. The workbook keeps `formula`.
   */
  shares: WeeklyBranchSplitShare[];
};

export type WeeklyBranchSplitPreview = {
  branchClass: WeeklyBranchClass | "pinned" | "excluded";
  /** One plain sentence: why it splits the way it does, or why it does not split. */
  note: string;
  /** Empty when the branch does not split. Grouped, so an identical split is printed once. */
  arithmetic: WeeklyBranchSplitArithmetic[];
};

/**
 * How one branch will be read, and the arithmetic that follows — for the mapping sheet and its
 * template. Pure: takes the loaded index, so the sheet and the export can never disagree with the
 * numbers actually applied.
 *
 * The split is computed PER LINE because it genuinely differs per line, and the owner's Beni Suef
 * ruling is the reason: it is Upper Egypt on Anti Infective, Giza on Pedia and Others on CNS. Lines
 * that land on the same answer are grouped into one row so the sheet stays readable.
 */
export function previewWeeklyBranchSplit(
  index: WeeklyAreaSplitIndex,
  input: {
    branchName: string | null | undefined;
    regionCode?: string | null;
    /** The Area column on the mapping sheet — set means the owner has pinned this branch by hand. */
    areaCode?: string | null;
    areaName?: string | null;
    excluded?: boolean;
  },
): WeeklyBranchSplitPreview {
  if (input.excluded) {
    return { branchClass: "excluded", note: "Excluded — this branch's rows never count.", arithmetic: [] };
  }

  const pinned = String(input.areaCode ?? "").trim().toUpperCase();
  if (pinned) {
    const name = input.areaName || index.areaNames.get(pinned) || pinned;
    return {
      branchClass: "pinned",
      note: `Pinned to ${name} by hand — the whole branch goes there and the name is not read.`,
      arithmetic: [],
    };
  }

  const reading = readWeeklyBranchName(index, input.branchName, input.regionCode ?? null);
  const byFormula = new Map<string, WeeklyBranchSplitArithmetic>();
  for (const line of TRACKED_LINE_NAMES) {
    const shares = resolveBranchAreaShares(index, line, reading.scope);
    if (shares.length === 0) continue;
    const formula = describeBranchAreaShares(index, shares);
    const existing = byFormula.get(formula);
    if (existing) {
      existing.lines.push(line);
      continue;
    }
    byFormula.set(formula, {
      lines: [line],
      formula,
      shares: shares.map((share) => {
        const pct = share.weight * 100;
        return {
          areaCode: share.areaCode,
          areaName: index.areaNames.get(share.areaCode) ?? share.areaCode,
          percentLabel: `${pct.toFixed(Math.abs(pct % 1) < 0.005 ? 0 : 2)}%`,
        };
      }),
    });
  }

  const arithmetic = [...byFormula.values()];
  // Only a branch that WAS read as a territory needs the extra sentence. A warehouse, a hospital or
  // a tender has already said why it is not being split, and appending a second reason on top of the
  // first reads as a contradiction on a screen where every word is being checked against a name.
  const unexplained = arithmetic.length === 0 && reading.scope != null;
  const note = unexplained
    ? `${reading.note} No line places it, so it stays with its region's manager.`
    : reading.note;
  return { branchClass: reading.branchClass, note, arithmetic };
}

/**
 * The whole preview as ONE line, for a spreadsheet cell.
 *
 * Owner rule: never truncate with an ellipsis and never wrap. So this stays a single line and the
 * column is made wide, rather than the text being cut to fit. A split shared by every tracked line
 * is printed once, unlabelled; only a genuine per-line difference names its lines — which in
 * practice is Beni Suef and nothing else.
 */
export function describeSplitPreview(preview: WeeklyBranchSplitPreview | null | undefined): string {
  if (!preview || preview.arithmetic.length === 0) return "";
  if (preview.arithmetic.length === 1) return preview.arithmetic[0].formula;
  return preview.arithmetic.map((entry) => `${entry.lines.join(" + ")}: ${entry.formula}`).join("      ||      ");
}
