// ─────────────────────────────────────────────────────────────────────────────
// Rankings — the whole field ranked, over any window, through any slice.
//
// `rep-rank.ts` answers ONE question for ONE person: where does this rep stand, over every
// published month. This is the manager's version of the same board — who stands where across
// a line, several lines or the whole company; over a month, a quarter, a semester, a year or
// every published month; narrowed to a title, a region or one person — and how each name moved
// since the window before it.
//
// Five things are load-bearing, and four of them are the same four that govern the rep's badge:
//
//   1. IT RANKS THE ARITHMETIC THE REST OF THE SYSTEM USES. Achievement is covered-actual ÷
//      target off the SoS Monthly Closing engine, ranked by achievement and then by full sales —
//      the same comparator as /sales-vs-target, the closing matrix and the rep's own badge. A
//      second definition of "achievement" here is how a manager's board would start disagreeing
//      with the rep's own screen.
//
//   2. THE WINDOW IS SUMMED, THEN DIVIDED ONCE — never an average of monthly ratios. A 10%
//      month and a 400% month do not make 205%, and averaging is how a quarter drifts away
//      from the three months it is made of.
//
//   3. PUBLISHED ROWS ONLY, PER LINE (isRowPublished). An unpublished month is an unfinished
//      one, not a leaderboard. It drops Head Office for free: HO rows carry no line code, so
//      they can never be published.
//
//   4. LEAVERS COME OFF BEFORE THE RANKING, NOT AFTER. Source of Sales keeps a rep's money
//      after he resigns — he earned it — but a departed name holding 8th place pushes a serving
//      rep to 9th. A FAILED directory read ranks everybody rather than nobody: fail open.
//
//   5. A REP WITH NO TARGET IN THE WINDOW IS NOT RANKED. His achievement would be 0 by
//      arithmetic, not by performance, and ranking him last would be a lie about him.
//
// 🔒 THE FILTER DECIDES THE POPULATION, AND THEREFORE THE RANK. Filtering to one line ranks each
// rep on THAT line's money alone — not on his company total shown inside a line board — because
// the question a line filter asks is "who is best on this line". The same holds for a title or a
// region: the board always ranks exactly the people it is showing, against each other.
// ─────────────────────────────────────────────────────────────────────────────

import { periodLabel, windowLabel } from "@/lib/business-review/period-format";
import type { RepEstablishment } from "@/lib/employee-portal/rep-establishment";
import { buildManagerChain, matchesManagerFilter } from "@/lib/org/manager-filter";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { lineName } from "@/lib/sales/monthly-targets";
import { isRowPublished, rollupByDm, type VsTargetNode } from "@/lib/sales/vs-target";

/** How a window is chosen. `published` is every published month there is — the cumulative board. */
export type RankingWindowMode = "month" | "quarter" | "semester" | "year" | "published";

export const RANKING_WINDOW_MODES: readonly RankingWindowMode[] = [
  "month",
  "quarter",
  "semester",
  "year",
  "published",
];

export function isRankingWindowMode(value: unknown): value is RankingWindowMode {
  return typeof value === "string" && (RANKING_WINDOW_MODES as readonly string[]).includes(value);
}

export type RankingWindow = {
  mode: RankingWindowMode;
  /** The month the window was built around, `YYYY-MM`. */
  anchor: string;
  /** Every published month inside it, ascending. Never empty for a non-null window. */
  periods: string[];
  from: string;
  to: string;
  /** What the window is called: "Aug 2026", "Q3 2026", "H2 2026", "2026", "Jul – Aug 2026". */
  label: string;
  /** The months spelled out — always a range, even when `label` is a quarter's name. */
  rangeLabel: string;
  /** The window this one is compared against. Null when there is nothing before it. */
  prior: { periods: string[]; from: string; to: string; label: string } | null;
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthNumber(period: string): number {
  return Number(period.slice(5, 7));
}

function monthsOf(year: number, first: number, count: number): string[] {
  const months: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const month = first + index;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

/** The calendar months a mode covers around one anchor — before anything is checked for publication. */
function candidateMonths(mode: RankingWindowMode, anchor: string): string[] {
  const year = Number(anchor.slice(0, 4));
  const month = monthNumber(anchor);
  if (mode === "month") return [anchor];
  if (mode === "quarter") return monthsOf(year, Math.floor((month - 1) / 3) * 3 + 1, 3);
  if (mode === "semester") return monthsOf(year, month <= 6 ? 1 : 7, 6);
  if (mode === "year") return monthsOf(year, 1, 12);
  return [];
}

/** The same shape of window, one step earlier: the previous month, quarter, semester or year. */
function priorCandidateMonths(mode: RankingWindowMode, anchor: string): string[] {
  const year = Number(anchor.slice(0, 4));
  const month = monthNumber(anchor);
  if (mode === "month") {
    return [month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`];
  }
  if (mode === "quarter") {
    const first = Math.floor((month - 1) / 3) * 3 + 1;
    return first === 1 ? monthsOf(year - 1, 10, 3) : monthsOf(year, first - 3, 3);
  }
  if (mode === "semester") {
    return month <= 6 ? monthsOf(year - 1, 7, 6) : monthsOf(year, 1, 6);
  }
  if (mode === "year") return monthsOf(year - 1, 1, 12);
  return [];
}

function modeLabel(mode: RankingWindowMode, anchor: string, from: string, to: string): string {
  const year = anchor.slice(0, 4);
  const month = monthNumber(anchor);
  if (mode === "month") return periodLabel(anchor);
  if (mode === "quarter") return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
  if (mode === "semester") return `${month <= 6 ? "H1" : "H2"} ${year}`;
  if (mode === "year") return year;
  return windowLabel(from, to);
}

/**
 * PURE. A window of PUBLISHED months for a mode and an anchor, plus the window it is compared to.
 *
 * `published` is every month with at least one published line, ascending. A mode's calendar months
 * are intersected with it, so a quarter two months into its life is a two-month quarter rather
 * than a quarter with a hole — and a window that would contain nothing published falls back to the
 * newest published month, never to an empty board.
 *
 * The cumulative mode (`published`) has no "window before it", so its comparison is the same
 * window one month shorter: the standing as it was before the newest month landed. That is what
 * "vs last month" means on a cumulative board, and it is the only reading under which the rep's
 * own badge and this board move together.
 */
export function rankingWindow(
  mode: RankingWindowMode,
  anchor: string | null | undefined,
  published: readonly string[],
): RankingWindow | null {
  const months = [...published].filter((period) => PERIOD_RE.test(period)).sort();
  if (months.length === 0) return null;
  const newest = months[months.length - 1];
  const wanted = anchor && PERIOD_RE.test(anchor) ? anchor : newest;
  // Anchor on a month that exists: the newest published month at or before the one asked for.
  const resolved = months.filter((period) => period <= wanted).pop() ?? months[0];

  const inWindow =
    mode === "published" ? [...months] : candidateMonths(mode, resolved).filter((period) => months.includes(period));
  const periods = inWindow.length > 0 ? inWindow : [resolved];
  const from = periods[0];
  const to = periods[periods.length - 1];

  const priorPeriods =
    mode === "published"
      ? periods.slice(0, -1)
      : priorCandidateMonths(mode, resolved).filter((period) => months.includes(period));

  return {
    mode,
    anchor: resolved,
    periods,
    from,
    to,
    label: modeLabel(mode, resolved, from, to),
    rangeLabel: windowLabel(from, to),
    prior:
      priorPeriods.length > 0
        ? {
            periods: priorPeriods,
            from: priorPeriods[0],
            to: priorPeriods[priorPeriods.length - 1],
            label:
              mode === "published"
                ? windowLabel(priorPeriods[0], priorPeriods[priorPeriods.length - 1])
                : modeLabel(mode, priorPeriods[priorPeriods.length - 1], priorPeriods[0], priorPeriods[priorPeriods.length - 1]),
          }
        : null,
  };
}

/** Hyphen- and case-insensitive HR-id key: canonical "B100" and stored "B-100" both match. */
export function rankingHrKey(value: string | null | undefined): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** One person as the board shows them — names and titles, never a code (owner rule). */
export type RankingPerson = {
  hrId: string;
  name: string;
  title: string;
  /** The line on the person's HR record. The board's own line comes from his sales, not from this. */
  lineName: string;
  regionName: string;
  areaName: string;
  managerName: string;
  hasPhoto: boolean;
};

export type RankingFilters = {
  /** Engine line codes (`cns`, `pedia`, `anti_infective`). Empty means every line — the company. */
  lines: readonly string[];
  /** Job titles exactly as the HR record spells them. Empty means every title. */
  titles: readonly string[];
  /** Region names. Empty means every region. */
  regions: readonly string[];
  /** A name (or HR id) typed into the search box. Empty means everybody. */
  query: string;
  /**
   * A manager's NAME. Keeps everybody beneath him — a District Manager's reps, a Regional or
   * National Sales Manager's whole chain (src/lib/org/manager-filter.ts). Empty or absent means
   * everybody. Added so a manager's reps can be found on the board (owner, 2026-10-20).
   */
  manager?: string;
};

export const EMPTY_RANKING_FILTERS: RankingFilters = { lines: [], titles: [], regions: [], query: "", manager: "" };

export type RankingEntry = {
  key: string;
  hrId: string;
  name: string;
  title: string;
  /** The line this rep's money is on inside the window — the one he actually sold. */
  lineCode: string;
  lineLabel: string;
  regionName: string;
  hasPhoto: boolean;
  rank: number;
  achievementPercent: number;
  /** Full sales, targeted or not — the tiebreaker, and the money column. */
  salesValue: number;
  /** Sales that had a target to be measured against — the numerator of the achievement. */
  coveredValue: number;
  targetValue: number;
  /** Where the same person stood in the comparison window, and by how much he moved. */
  priorRank: number | null;
  /** Positive = moved UP the board. Null when he was not ranked in the prior window. */
  trend: number | null;
};

export type RankingLineBoard = {
  lineCode: string;
  lineLabel: string;
  entries: RankingEntry[];
  /** Rep seats on this line, vacancies included, or null when the seat model could not be read. */
  seats: number | null;
  vacant: number | null;
};

export type RankingBoards = {
  /** The filtered population, ranked against itself. */
  overall: RankingEntry[];
  /** The same people split by the line their money is on — one board per line in scope. */
  byLine: RankingLineBoard[];
  /** How many people the window could actually score. */
  ranked: number;
  /**
   * The District Managers, ranked by their TEAM's achievement — the closing's own district grain,
   * not a sum of this board's rows (see districtManagerBoard). Owner, 2026-10-20.
   */
  districtManagers: RankingEntry[];
  /**
   * Rep seats behind the board — the organogram's own count, vacancies included (owner rule).
   *
   * NULL whenever a title, region, manager or name filter is on: the seat model counts REP seats, so it
   * answers a question the filtered board is no longer asking. The board then says how many it
   * ranked, which is true of any slice.
   */
  seats: number | null;
  vacant: number | null;
};

type Totals = { covered: number; target: number; full: number };

function emptyTotals(): Totals {
  return { covered: 0, target: 0, full: 0 };
}

function addTo(totals: Totals, row: AchievementRow): void {
  totals.target += row.targetValue ?? 0;
  totals.full += row.actualValue;
  if (row.hasTarget) totals.covered += row.actualValue;
}

/** Achievement first, full sales as the tiebreaker — the comparator every board in the app uses. */
function byStanding(a: { totals: Totals }, b: { totals: Totals }): number {
  const left = a.totals.covered / a.totals.target;
  const right = b.totals.covered / b.totals.target;
  return right - left || b.totals.full - a.totals.full;
}

type Collected = {
  /** key -> totals across every line the filter admits. */
  overall: Map<string, Totals>;
  /** lineCode -> key -> totals. */
  byLine: Map<string, Map<string, Totals>>;
  /** key -> the line carrying most of his money, for the label on his row. */
  ownLine: Map<string, string>;
};

function collect(
  rows: readonly AchievementRow[],
  publishedKeys: ReadonlySet<string>,
  periods: ReadonlySet<string>,
  admits: (key: string, lineCode: string) => boolean,
): Collected {
  const overall = new Map<string, Totals>();
  const byLine = new Map<string, Map<string, Totals>>();
  const lineWeight = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (!periods.has(row.period)) continue;
    if (!isRowPublished(row, publishedKeys)) continue;
    const lineCode = row.lineCode;
    if (!lineCode) continue;
    // No resolved rep seat: the row belongs to the area, never to whoever is nearby.
    const key = rankingHrKey(row.repHrId);
    if (!key) continue;
    if (!admits(key, lineCode)) continue;

    let totals = overall.get(key);
    if (!totals) overall.set(key, (totals = emptyTotals()));
    addTo(totals, row);

    let board = byLine.get(lineCode);
    if (!board) byLine.set(lineCode, (board = new Map<string, Totals>()));
    let lineTotals = board.get(key);
    if (!lineTotals) board.set(key, (lineTotals = emptyTotals()));
    addTo(lineTotals, row);

    let weights = lineWeight.get(key);
    if (!weights) lineWeight.set(key, (weights = new Map<string, number>()));
    weights.set(lineCode, (weights.get(lineCode) ?? 0) + row.actualValue);
  }

  // A rep CAN hold rows on two lines. His row is labelled with the line carrying most of his
  // money — never the first line the engine happened to return.
  const ownLine = new Map<string, string>();
  for (const [key, weights] of lineWeight) {
    const best = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) ownLine.set(key, best[0]);
  }
  return { overall, byLine, ownLine };
}

function rankOf(totals: Map<string, Totals>): Map<string, number> {
  const ranked = [...totals.entries()]
    .filter(([, value]) => value.target > 0)
    .map(([key, value]) => ({ key, totals: value }))
    .sort(byStanding);
  const places = new Map<string, number>();
  ranked.forEach((entry, index) => places.set(entry.key, index + 1));
  return places;
}

function toEntries(
  totals: Map<string, Totals>,
  options: {
    people: ReadonlyMap<string, RankingPerson>;
    ownLine: ReadonlyMap<string, string>;
    priorRanks: ReadonlyMap<string, number> | null;
    lineCode?: string;
  },
): RankingEntry[] {
  return [...totals.entries()]
    // Note 5: no target in the window means no rank, and no seat in the denominator either.
    .filter(([, value]) => value.target > 0)
    .map(([key, value]) => ({ key, totals: value }))
    .sort(byStanding)
    .map((entry, index) => {
      const person = options.people.get(entry.key);
      const lineCode = options.lineCode ?? options.ownLine.get(entry.key) ?? "";
      const priorRank = options.priorRanks?.get(entry.key) ?? null;
      const rank = index + 1;
      return {
        key: entry.key,
        hrId: person?.hrId ?? entry.key,
        name: person?.name ?? entry.key,
        title: person?.title ?? "",
        lineCode,
        lineLabel: lineName(lineCode),
        regionName: person?.regionName ?? "",
        hasPhoto: person?.hasPhoto ?? false,
        rank,
        achievementPercent: (entry.totals.covered / entry.totals.target) * 100,
        salesValue: entry.totals.full,
        coveredValue: entry.totals.covered,
        targetValue: entry.totals.target,
        priorRank,
        // Positive is UP the board: 3rd from 8th is +5, the way the badge reads it.
        trend: priorRank == null ? null : priorRank - rank,
      };
    });
}

/**
 * PURE. Published achievement rows → every board the page draws.
 *
 * `rows` and `priorRows` may span any range; the window sets are what decide which months count,
 * so a caller may hand over one range covering both and let this split it.
 */
export function buildRankingBoards(options: {
  rows: readonly AchievementRow[];
  priorRows: readonly AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  periods: readonly string[];
  priorPeriods: readonly string[];
  people: ReadonlyMap<string, RankingPerson>;
  /** The serving roster as hyphen-insensitive keys. Null or empty ranks everybody (note 4). */
  activeKeys?: ReadonlySet<string> | null;
  establishment?: RepEstablishment | null;
  filters: RankingFilters;
}): RankingBoards {
  const { filters } = options;
  const lines = new Set(filters.lines);
  const titles = new Set(filters.titles.map((title) => title.toLowerCase()));
  const regions = new Set(filters.regions.map((region) => region.toLowerCase()));
  const query = filters.query.trim().toLowerCase();
  const manager = String(filters.manager ?? "").trim();
  // The chain is read from every person the board knows — managers included, though they carry no
  // sales of their own — so a manager two levels up still finds the reps at the bottom.
  const chain = manager
    ? buildManagerChain([...options.people.values()].map((person) => ({ employeeName: person.name, managerName: person.managerName })))
    : null;
  const active = options.activeKeys && options.activeKeys.size > 0 ? options.activeKeys : null;

  const admits = (key: string, lineCode: string): boolean => {
    if (lines.size > 0 && !lines.has(lineCode)) return false;
    if (active && !active.has(key)) return false;
    const person = options.people.get(key);
    if (titles.size > 0 && !titles.has((person?.title ?? "").toLowerCase())) return false;
    if (regions.size > 0 && !regions.has((person?.regionName ?? "").toLowerCase())) return false;
    if (chain && !matchesManagerFilter({ employeeName: person?.name, managerName: person?.managerName }, manager, chain)) return false;
    if (query) {
      const haystack = `${person?.name ?? ""} ${person?.hrId ?? key}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  };

  const current = collect(options.rows, options.publishedKeys, new Set(options.periods), admits);
  const prior =
    options.priorPeriods.length > 0
      ? collect(options.priorRows, options.publishedKeys, new Set(options.priorPeriods), admits)
      : null;

  const priorOverallRanks = prior ? rankOf(prior.overall) : null;
  const overall = toEntries(current.overall, {
    people: options.people,
    ownLine: current.ownLine,
    priorRanks: priorOverallRanks,
  });

  const byLine: RankingLineBoard[] = [...current.byLine.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lineCode, totals]) => {
      const seat = options.establishment?.byLine.get(lineCode) ?? null;
      const unsliced = titles.size === 0 && regions.size === 0 && !query && !manager;
      return {
        lineCode,
        lineLabel: lineName(lineCode),
        entries: toEntries(totals, {
          people: options.people,
          ownLine: current.ownLine,
          priorRanks: prior ? rankOf(prior.byLine.get(lineCode) ?? new Map()) : null,
          lineCode,
        }),
        seats: unsliced && seat && seat.seats > 0 ? seat.seats : null,
        vacant: unsliced && seat && seat.seats > 0 ? seat.vacant : null,
      };
    });

  // The seat count answers "out of how many rep seats" — which only means anything while the board
  // still IS the rep population. Any slice narrower than a line turns it off rather than quoting a
  // denominator the board no longer matches.
  const unsliced = titles.size === 0 && regions.size === 0 && !query && !manager;
  let seats: number | null = null;
  let vacant: number | null = null;
  if (unsliced && options.establishment) {
    if (lines.size === 0) {
      seats = options.establishment.company.seats > 0 ? options.establishment.company.seats : null;
      vacant = seats == null ? null : options.establishment.company.vacant;
    } else {
      let total = 0;
      let empty = 0;
      for (const lineCode of lines) {
        const seat = options.establishment.byLine.get(lineCode);
        if (!seat) continue;
        total += seat.seats;
        empty += seat.vacant;
      }
      seats = total > 0 ? total : null;
      vacant = seats == null ? null : empty;
    }
  }

  const districtManagers = districtManagerBoard({
    rows: options.rows,
    priorRows: options.priorRows,
    publishedKeys: options.publishedKeys,
    periods: options.periods,
    priorPeriods: options.priorPeriods,
    people: options.people,
    active,
    lines,
    admitsPerson: (key) => {
      const person = options.people.get(key);
      if (regions.size > 0 && !regions.has((person?.regionName ?? "").toLowerCase())) return false;
      if (chain && !matchesManagerFilter({ employeeName: person?.name, managerName: person?.managerName }, manager, chain)) return false;
      if (query) {
        const haystack = `${person?.name ?? ""} ${person?.hrId ?? key}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    },
  });

  return { overall, byLine, ranked: overall.length, districtManagers, seats, vacant };
}

/**
 * THE DISTRICT MANAGER BOARD (owner, 2026-10-20: "a second board ranks the District Managers by
 * their team's sales against target, read from the published Monthly Closing").
 *
 * A District Manager's figure is the closing's OWN district grain — `rollupByDm`, the managers level
 * of /sales/vs-target — over the same published rows the rep board reads: his team's sales VALUE
 * divided by his team's target VALUE, graded the way the closing divides (`totalRows`). Never a sum
 * of the rep board's percentages and never units, so a manager's place cannot disagree with the
 * closing his team is reported in. Ranked by that achievement, then by full sales, like every board.
 *
 * A row with no District Manager on it (a vacant district seat) belongs to nobody here, as a row
 * with no rep belongs to nobody on the rep board, and a manager who has left comes off before the
 * ranking. The line filter narrows the MONEY; the region, manager and name filters choose WHICH
 * District Managers stand on the board, and it ranks exactly those. The title filter is the rep
 * board's — its options are the reps' titles — so it does not reach this one.
 */
function districtManagerBoard(options: {
  rows: readonly AchievementRow[];
  priorRows: readonly AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  periods: readonly string[];
  priorPeriods: readonly string[];
  people: ReadonlyMap<string, RankingPerson>;
  active: ReadonlySet<string> | null;
  lines: ReadonlySet<string>;
  admitsPerson: (key: string) => boolean;
}): RankingEntry[] {
  const scope = (source: readonly AchievementRow[], periods: readonly string[]): AchievementRow[] => {
    const months = new Set(periods);
    return source.filter((row) => {
      if (!months.has(row.period) || !isRowPublished(row, options.publishedKeys)) return false;
      if (!row.lineCode || (options.lines.size > 0 && !options.lines.has(row.lineCode))) return false;
      const key = rankingHrKey(row.dmHrId);
      if (!key) return false;
      return !options.active || options.active.has(key);
    });
  };
  const nameOf = (hrId: string) => options.people.get(rankingHrKey(hrId))?.name ?? "District Manager";
  const names = { lineName, regionName: (code: string) => code, areaName: (code: string) => code, employeeName: nameOf };
  const ranked = (nodes: VsTargetNode[]) =>
    nodes
      .filter((node) => node.current.targetValue > 0 && node.current.achievementValue != null)
      .filter((node) => options.admitsPerson(rankingHrKey(node.key)))
      .sort(
        (left, right) =>
          (right.current.achievementValue ?? 0) - (left.current.achievementValue ?? 0) ||
          right.current.actualValue - left.current.actualValue,
      );

  const currentRows = scope(options.rows, options.periods);
  const current = ranked(rollupByDm(currentRows, null, names));
  const priorRanks = new Map<string, number>();
  if (options.priorPeriods.length > 0) {
    ranked(rollupByDm(scope(options.priorRows, options.priorPeriods), null, names)).forEach((node, index) =>
      priorRanks.set(rankingHrKey(node.key), index + 1),
    );
  }

  // His row names the line carrying most of his team's money, as a rep's row does.
  const lineWeight = new Map<string, Map<string, number>>();
  for (const row of currentRows) {
    const key = rankingHrKey(row.dmHrId);
    let weights = lineWeight.get(key);
    if (!weights) lineWeight.set(key, (weights = new Map<string, number>()));
    weights.set(row.lineCode ?? "", (weights.get(row.lineCode ?? "") ?? 0) + row.actualValue);
  }

  return current.map((node, index) => {
    const key = rankingHrKey(node.key);
    const person = options.people.get(key);
    const lineCode = [...(lineWeight.get(key)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const rank = index + 1;
    const priorRank = options.priorPeriods.length > 0 ? priorRanks.get(key) ?? null : null;
    return {
      key,
      hrId: person?.hrId ?? node.key,
      name: person?.name ?? node.name,
      title: person?.title ?? "District Manager",
      lineCode,
      lineLabel: lineName(lineCode),
      regionName: person?.regionName ?? "",
      hasPhoto: person?.hasPhoto ?? false,
      rank,
      achievementPercent: (node.current.achievementValue ?? 0) * 100,
      salesValue: node.current.actualValue,
      coveredValue: node.current.gradedActualValue,
      targetValue: node.current.targetValue,
      priorRank,
      trend: priorRank == null ? null : priorRank - rank,
    };
  });
}
