// ─────────────────────────────────────────────────────────────────────────────
// Where one Medical Rep stands among the others — company-wide and inside his own line —
// over every PUBLISHED month so far. Backs the two honour badges on the rep's landing page
// (owner, 2026-10-03: "if his ach% is from the top 15 medical reps in the company show him
// 'you ranked the 8th out of' and tell the medical reps count of the company in the period
// from to … the same thing but if from the top 7 in his line").
//
// 🔒 THE WINDOW IS CUMULATIVE, NOT ONE MONTH (owner, 2026-10-03, correcting the first build:
// "do not calculate only August, calculate up to date — example for now 7 and 8, when 9
// closing is published then 7 8 9"). It is every published month from the engine's floor to
// the latest published one, summed and then divided ONCE — never an average of the monthly
// ratios, which would let a tiny month outweigh a large one (summarizeAchievement's own rule).
// It widens on its own the day he publishes a closing; nothing here needs touching for that.
//
// Five more things are load-bearing.
//
//   1. IT RANKS THE MONTHLY CLOSING'S OWN ARITHMETIC. Achievement is ALL sales ÷ target off the
//      SoS Monthly Closing engine — what `closingAchievement` divides, and what his portal
//      overview's achievement already divides — the same as /sales-vs-target and the Rankings
//      board his manager reads (Rule #1), ranked achievement then sales like every one of them.
//      It divided COVERED sales until 2026-10-25, which is how a badge read 21.76% beside a
//      closing of 25.90%. A second definition of "achievement" here is how a rep's badge would
//      start disagreeing with the boards his own manager reads.
//
//   2. THE WINDOW IS NAMED ON THE BADGE. A rank means nothing without the period it was won
//      over, and this window is NOT the month the Achievement keycard shows — the keycard is
//      one month, this is all of them. The standing carries `fromPeriod`/`toPeriod` and the
//      spelled-out label, so the badge says "Jul – Aug 2026" out loud and the two can never be
//      read as the same number.
//
//   3. PUBLISHED ROWS ONLY, PER LINE (isRowPublished). The same gate every other sales surface
//      uses — an unpublished month is an unfinished one, not a leaderboard. It also drops Head
//      Office for free: HO rows carry no line code, so they can never be published. When lines
//      publish on different days (July 2026 staggered across 2026-08-08 to 08-12) each rep's
//      own number covers his own line's published months, and the label spans the board's —
//      which is why the label is a stated range rather than a claim about every rep's months.
//
//   4. LEAVERS COME OFF BEFORE THE RANKING, NOT AFTER. Source of Sales keeps a rep's money
//      after he resigns — correct, he earned it — but a departed name holding 8th place pushes
//      a serving rep to 9th and inflates the "out of N" every rep reads. Measured on production
//      for 2026-08: 3 of the 73 ranked seats had already left, one of them 8th. Same rule, same
//      reason, as splitDepartedRoster on every manager's board. A FAILED directory read ranks
//      everybody rather than nobody — fail open, never fail empty.
//
//   5. A REP WITH NO TARGET IN THE WHOLE WINDOW IS NOT RANKED, and is not in the denominator
//      either. His achievement would be 0 by arithmetic, not by performance (au.monthly_targets
//      starts at 2026-07, and a rep hired after a month's targets were set has none). Ranking
//      him last would be a lie about him; counting him in "out of N" would be a lie to everyone
//      else. So "out of N medical reps" means the reps this window can actually score.
// ─────────────────────────────────────────────────────────────────────────────

import { windowLabel } from "@/lib/business-review/period-format";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { loadRepEstablishment, type RepEstablishment } from "@/lib/employee-portal/rep-establishment";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { lineName } from "@/lib/sales/monthly-targets";
import type { SeatCount } from "@/lib/employee-portal/rep-establishment";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  loadAchievementRange,
  loadPublishedPeriodKeys,
  salesVsTargetPeriods,
} from "@/lib/sales/vs-target";

/**
 * How far down each board a badge is still awarded. The owner's own numbers — 15 in the
 * company, 7 in the line — and outside them the rep is shown NOTHING at all, not a greyed
 * badge and not a "keep going" line: a badge everyone gets is not a badge.
 */
export const COMPANY_RANK_BADGE_LIMIT = 15;
export const LINE_RANK_BADGE_LIMIT = 7;

/** One placing: the rank, the company it was won against, and the % that won it. */
export type RepRankPlace = {
  rank: number;
  /**
   * The "out of N" the badge prints: every MEDICAL REP SEAT in the structure, vacant ones included.
   *
   * 🔒 Owner, 2026-10-03: *"do not show the current medical reps, only show total structure of
   * medical reps count vacants."* Not the number who scored — that shrinks the company to whoever
   * sold something and MOVES every month, so the same performance would read as a better rank in a
   * thin month. Falls back to `ranked` only when the seat model could not be read at all.
   */
  outOf: number;
  /** How many reps could actually be scored in the window. Kept for the card, never on the badge. */
  ranked: number;
  /** Empty seats inside `outOf`. Shown on the performance card, never on the badge. */
  vacant: number;
  achievementPercent: number;
};

export type RepRankStanding = {
  /** First published month in the window, `YYYY-MM`. */
  fromPeriod: string;
  /** Last published month in the window, `YYYY-MM`. Equal to `fromPeriod` for a single month. */
  toPeriod: string;
  /** "Jul – Aug 2026" — the window spelled out, which is what the badge prints. */
  windowLabel: string;
  /** Inside the top COMPANY_RANK_BADGE_LIMIT company-wide, else null. */
  company: RepRankPlace | null;
  /** Inside the top LINE_RANK_BADGE_LIMIT of his own line, else null. */
  line: (RepRankPlace & { lineName: string }) | null;
};

/** Hyphen- and case-insensitive HR-id key: canonical "B100" and stored "B-100" both match. */
function hrKey(value: string | null | undefined): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type Totals = { target: number; full: number };

// Every pound counts, targeted product or not — the closing divides all sales (note 1).
function addTo(totals: Totals, row: AchievementRow): void {
  const target = row.targetValue ?? 0;
  totals.target += target;
  totals.full += row.actualValue;
}

function emptyTotals(): Totals {
  return { target: 0, full: 0 };
}

type Standing = { key: string; totals: Totals };

/**
 * Rank a board and find one rep's 1-based position on it.
 *
 * Achievement first, full sales as the tiebreaker — the same comparator rankMembers and every
 * portal leaderboard already use, so a rep cannot be 4th here and 5th on his manager's screen.
 *
 * The ratio is taken from the SUMMED window, never averaged across its months: a 10% month and
 * a 400% month do not make 205%, and averaging is how a cumulative figure drifts away from the
 * months it is made of.
 */
function placeOn(board: readonly Standing[], ownKey: string, establishment: SeatCount | null): RepRankPlace | null {
  const ranked = board
    .filter((entry) => entry.totals.target > 0)
    .sort((a, b) => {
      const left = a.totals.full / a.totals.target;
      const right = b.totals.full / b.totals.target;
      return right - left || b.totals.full - a.totals.full;
    });
  const index = ranked.findIndex((entry) => entry.key === ownKey);
  if (index < 0) return null;
  const own = ranked[index];
  // The structure when we have it, the scored count when we do not — never zero, which would print
  // "of 0 medical reps" on a rep's own keepsake.
  const seats = establishment && establishment.seats > 0 ? establishment.seats : ranked.length;
  return {
    rank: index + 1,
    outOf: seats,
    ranked: ranked.length,
    vacant: establishment && establishment.seats > 0 ? establishment.vacant : 0,
    achievementPercent: (own.totals.full / own.totals.target) * 100,
  };
}

/**
 * PURE. Published achievement rows → this rep's two placings over the whole published window,
 * gated to the badge limits.
 *
 * `rows` may span any range; everything unpublished is dropped here, so the window is exactly
 * the published months the rows contain. `activeHrKeys` is the serving roster as
 * hyphen-insensitive keys; pass null (or an empty set) to rank everybody, which is what a
 * failed directory read must do — see note 4.
 */
export function repRankStanding(
  rows: readonly AchievementRow[],
  publishedKeys: ReadonlySet<string>,
  options: { hrId: string; activeHrKeys?: ReadonlySet<string> | null; establishment?: RepEstablishment | null },
): RepRankStanding | null {
  const ownKey = hrKey(options.hrId);
  if (!ownKey) return null;
  const active = options.activeHrKeys && options.activeHrKeys.size > 0 ? options.activeHrKeys : null;

  const company = new Map<string, Totals>();
  // lineCode -> repKey -> totals. A rep seat is per line × area, so a rep CAN hold rows on two
  // lines (2 of 73 did in 2026-08): the company board adds them, the line boards keep them apart.
  const byLine = new Map<string, Map<string, Totals>>();
  const ownLines = new Map<string, Totals>();
  const periods = new Set<string>();

  for (const row of rows) {
    if (!isRowPublished(row, publishedKeys)) continue;
    const key = hrKey(row.repHrId);
    // No resolved rep seat: the row belongs to the area, never to whoever is nearby.
    if (!key) continue;
    if (active && !active.has(key)) continue;
    const lineCode = row.lineCode;
    if (!lineCode) continue;
    periods.add(row.period);

    let companyTotals = company.get(key);
    if (!companyTotals) company.set(key, (companyTotals = emptyTotals()));
    addTo(companyTotals, row);

    let lineBoard = byLine.get(lineCode);
    if (!lineBoard) byLine.set(lineCode, (lineBoard = new Map<string, Totals>()));
    let lineTotals = lineBoard.get(key);
    if (!lineTotals) lineBoard.set(key, (lineTotals = emptyTotals()));
    addTo(lineTotals, row);

    if (key === ownKey) {
      let ownLineTotals = ownLines.get(lineCode);
      if (!ownLineTotals) ownLines.set(lineCode, (ownLineTotals = emptyTotals()));
      addTo(ownLineTotals, row);
    }
  }

  if (!company.has(ownKey) || periods.size === 0) return null;
  const sorted = Array.from(periods).sort();
  const fromPeriod = sorted[0];
  const toPeriod = sorted[sorted.length - 1];

  const toBoard = (totals: Map<string, Totals>): Standing[] =>
    Array.from(totals, ([key, value]) => ({ key, totals: value }));

  const establishment = options.establishment ?? null;
  const companyPlace = placeOn(toBoard(company), ownKey, establishment?.company ?? null);

  // THE REP'S OWN LINE is the one carrying the most of his money — not the first row seen. A rep
  // straddling two lines belongs on the board where he actually sells; picking by row order would
  // put him on whichever line the engine happened to return first.
  const ownLine =
    Array.from(ownLines.entries()).sort(
      (a, b) => b[1].full - a[1].full || b[1].target - a[1].target,
    )[0] ?? null;
  const linePlace = ownLine
    ? placeOn(toBoard(byLine.get(ownLine[0]) ?? new Map()), ownKey, establishment?.byLine.get(ownLine[0]) ?? null)
    : null;

  const companyBadge = companyPlace && companyPlace.rank <= COMPANY_RANK_BADGE_LIMIT ? companyPlace : null;
  const lineBadge =
    ownLine && linePlace && linePlace.rank <= LINE_RANK_BADGE_LIMIT
      ? { ...linePlace, lineName: lineName(ownLine[0]) }
      : null;
  // NULL WHEN NOTHING WAS EARNED, never a standing with two empty halves. That keeps the contract
  // worth reading — a non-null standing means "there is a badge to draw" — and it is the shape the
  // owner's rule asks for: outside both bands the rep sees nothing, so there is nothing to hand over.
  if (!companyBadge && !lineBadge) return null;
  return {
    fromPeriod,
    toPeriod,
    windowLabel: windowLabel(fromPeriod, toPeriod),
    company: companyBadge,
    line: lineBadge,
  };
}

/**
 * One rep's standing over every published month so far, loaded.
 *
 * Takes NO period: the window is the published months themselves, which is what makes it widen
 * by itself the day a closing is published (owner, 2026-10-03). `loadAchievementRange` is cached
 * PER MONTH, so this shares its entries with the rep's own history load on the same request
 * rather than paying for a second trip. Returns null when nothing is published, when the rep has
 * nothing scorable, or when he is outside both bands; the caller renders no badge for null.
 */
export async function loadRepRankStanding(hrId: string): Promise<RepRankStanding | null> {
  if (!hrId) return null;
  const { current } = salesVsTargetPeriods();
  const [rows, publishedKeys, directoryRows, establishment] = await Promise.all([
    loadAchievementRange(SALES_VS_TARGET_FLOOR, current),
    loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, current),
    // Active employees only by default — see isActiveDirectoryEmployee. Caught, because a badge
    // must never be the thing that fails a landing page; an empty set then ranks everybody.
    getEmployeeDirectoryRows().catch(() => []),
    // The "out of N" on every badge — the organogram's rep seats, vacancies included (owner,
    // 2026-10-03). Never throws; zeros mean the badge falls back to the scored count.
    loadRepEstablishment(),
  ]);
  const activeHrKeys = new Set(directoryRows.map((row) => hrKey(row.hrId)).filter(Boolean));
  // Merge Fayoum/Beni Suef BEFORE grouping, like every other consumer of these rows: the merge
  // rewrites areaCode, and a rep on a merging line would otherwise be split across two codes.
  return repRankStanding(applyAchievementAreaMerges(rows), publishedKeys, { hrId, activeHrKeys, establishment });
}
