// ─────────────────────────────────────────────────────────────────────────────
// Rankings — the page's data, loaded.
//
// Everything the Rankings tab draws comes from here: the published months it may be anchored on,
// the window the filters resolve to, the boards themselves, and the choices offered in the filter
// bar. The ranking arithmetic is `rankings.ts` and is pure; this file only reads.
//
// 🔒 IT READS THE MONTHLY CLOSING ENGINE AND NOTHING ELSE (AGENTS.md §4, the source-of-truth
// golden rule). `loadAchievementRange` is the same loader /sales/vs-target, the closing matrix and
// the rep's own badge use — cached PER MONTH, so a page sharing months with another surface on
// the same request pays for them once. A query of its own here is how a manager's board would
// start disagreeing with the closing it is supposed to be reporting.
//
// The window and its comparison are loaded as ONE range: the months themselves decide which rows
// belong to which side, so two loads would only re-fetch what the cache already holds.
// ─────────────────────────────────────────────────────────────────────────────

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { loadRepEstablishment } from "@/lib/employee-portal/rep-establishment";
import { buildManagerChain, managerFilterOptions } from "@/lib/org/manager-filter";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import { lineName } from "@/lib/sales/monthly-targets";
import {
  EMPTY_RANKING_FILTERS,
  buildRankingBoards,
  isRankingWindowMode,
  rankingHrKey,
  rankingWindow,
  type RankingBoards,
  type RankingEntry,
  type RankingFilters,
  type RankingPerson,
  type RankingWindow,
  type RankingWindowMode,
} from "@/lib/sales/rankings";
import {
  SALES_VS_TARGET_FLOOR,
  loadAchievementRange,
  loadPublishedPeriodKeys,
  salesVsTargetPeriods,
} from "@/lib/sales/vs-target";

export type RankingsSearchParams = {
  mode?: string;
  period?: string;
  lines?: string;
  titles?: string;
  regions?: string;
  q?: string;
  /** A manager's name — see RankingFilters.manager. */
  manager?: string;
};

export type RankingOption = { value: string; label: string };

/** One person's two placings, for the pair of hero cards at the top of the page. */
export type RankingFocus = {
  entry: RankingEntry;
  company: { rank: number; outOf: number; outOfIsSeats: boolean; trend: number | null };
  line: { lineLabel: string; rank: number; outOf: number; outOfIsSeats: boolean; trend: number | null } | null;
};

export type RankingsPageData = {
  mode: RankingWindowMode;
  window: RankingWindow;
  filters: RankingFilters;
  boards: RankingBoards;
  /** The standing of the one person a search narrowed the board to, else null. */
  focus: RankingFocus | null;
  /** Every month with a published closing, ascending — what the month picker offers. */
  publishedMonths: string[];
  /** The anchors each mode can be set to, newest first, already labelled. */
  anchorOptions: RankingOption[];
  lineOptions: RankingOption[];
  titleOptions: RankingOption[];
  regionOptions: RankingOption[];
  /**
   * The managers the board can be narrowed to, by NAME (never an HR code): every direct manager of
   * a rep the window can score, and every manager above them (owner, 2026-10-20).
   */
  managerOptions: RankingOption[];
  /** True when nothing at all has been published yet — the page says so rather than showing zeros. */
  nothingPublished: boolean;
};

function splitList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The months carrying at least one published line, ascending. */
function publishedMonthsOf(publishedKeys: ReadonlySet<string>): string[] {
  const months = new Set<string>();
  for (const key of publishedKeys) {
    const period = key.slice(key.indexOf("|") + 1);
    if (period) months.add(period);
  }
  return [...months].sort();
}

/** The anchors a mode offers: every published month, or the quarters / semesters / years they fall in. */
function anchorOptionsFor(mode: RankingWindowMode, months: readonly string[]): RankingOption[] {
  if (mode === "published") return [];
  const seen = new Map<string, string>();
  for (const period of months) {
    const year = period.slice(0, 4);
    const month = Number(period.slice(5, 7));
    if (mode === "month") {
      seen.set(period, period);
    } else if (mode === "quarter") {
      seen.set(`${year}-Q${Math.floor((month - 1) / 3) + 1}`, period);
    } else if (mode === "semester") {
      seen.set(`${year}-${month <= 6 ? "H1" : "H2"}`, period);
    } else {
      seen.set(year, period);
    }
  }
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([bucket, period]) => ({
      value: period,
      label:
        mode === "month"
          ? `${monthNames[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`
          : mode === "year"
            ? bucket
            : `${bucket.slice(5)} ${bucket.slice(0, 4)}`,
    }));
}

function focusOf(boards: RankingBoards, filters: RankingFilters): RankingFocus | null {
  // A search that lands on exactly one person turns the page into HIS standing — the two cards
  // the owner's concept opens with. Two matches are still a board, not a card.
  if (!filters.query.trim() || boards.overall.length !== 1) return null;
  const entry = boards.overall[0];
  const lineBoard = boards.byLine.find((board) => board.lineCode === entry.lineCode) ?? null;
  const lineEntry = lineBoard?.entries.find((row) => row.key === entry.key) ?? null;
  return {
    entry,
    company: {
      rank: entry.rank,
      outOf: boards.seats ?? boards.ranked,
      outOfIsSeats: boards.seats != null,
      trend: entry.trend,
    },
    line:
      lineBoard && lineEntry
        ? {
            lineLabel: lineBoard.lineLabel,
            rank: lineEntry.rank,
            outOf: lineBoard.seats ?? lineBoard.entries.length,
            outOfIsSeats: lineBoard.seats != null,
            trend: lineEntry.trend,
          }
        : null,
  };
}

/**
 * The whole page, loaded for one set of filters.
 *
 * Caller asserts the permission; this reads company-wide, which is what the admin-shell roles
 * holding `sales:read` already see on every other commercial surface.
 */
export async function buildRankingsPage(params: RankingsSearchParams): Promise<RankingsPageData> {
  const mode: RankingWindowMode = isRankingWindowMode(params.mode) ? params.mode : "published";
  const filters: RankingFilters = {
    lines: splitList(params.lines),
    titles: splitList(params.titles),
    regions: splitList(params.regions),
    query: String(params.q ?? "").trim(),
    manager: String(params.manager ?? "").trim(),
  };

  const { current } = salesVsTargetPeriods();
  const publishedKeys = await loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, current);
  const publishedMonths = publishedMonthsOf(publishedKeys);
  const window = rankingWindow(mode, params.period, publishedMonths);

  if (!window) {
    return {
      mode,
      window: {
        mode,
        anchor: current,
        periods: [],
        from: current,
        to: current,
        label: "",
        rangeLabel: "",
        prior: null,
      },
      filters: { ...EMPTY_RANKING_FILTERS, ...filters },
      boards: { overall: [], byLine: [], ranked: 0, districtManagers: [], seats: null, vacant: null },
      focus: null,
      publishedMonths: [],
      anchorOptions: [],
      lineOptions: [],
      titleOptions: [],
      regionOptions: [],
      managerOptions: [],
      nothingPublished: true,
    };
  }

  const loadFrom = window.prior ? window.prior.from : window.from;
  const [rawRows, directoryRows, establishment] = await Promise.all([
    loadAchievementRange(loadFrom, window.to),
    // Active employees only by default. Caught: a failed directory read ranks everybody rather
    // than nobody, and a board that silently empties is worse than one carrying a leaver.
    getEmployeeDirectoryRows().catch(() => []),
    loadRepEstablishment(),
  ]);
  // Merge Fayoum/Beni Suef BEFORE grouping, like every other consumer of these rows.
  const rows = applyAchievementAreaMerges(rawRows);

  const people = new Map<string, RankingPerson>();
  const activeKeys = new Set<string>();
  for (const row of directoryRows) {
    const key = rankingHrKey(row.hrId);
    if (!key) continue;
    activeKeys.add(key);
    people.set(key, {
      hrId: row.hrId,
      name: row.displayName || row.fullName,
      title: row.jobTitle ?? row.positionTitle ?? "",
      lineName: row.lineName ?? "",
      regionName: row.regionName ?? "",
      areaName: row.areaName ?? "",
      managerName: row.managerName ?? "",
      hasPhoto: row.hasPhoto,
    });
  }

  const boards = buildRankingBoards({
    rows,
    priorRows: rows,
    publishedKeys,
    periods: window.periods,
    priorPeriods: window.prior?.periods ?? [],
    people,
    activeKeys,
    establishment,
    filters,
  });

  // The filter choices are drawn from the people the WINDOW can score, not from the whole company:
  // a title nobody in this window holds would offer a filter that can only ever empty the board.
  const windowMonths = new Set(window.periods);
  const linesInWindow = new Set<string>();
  const titles = new Map<string, number>();
  const regions = new Map<string, number>();
  const scoredPeople = new Map<string, RankingPerson>();
  for (const row of rows) {
    if (!windowMonths.has(row.period)) continue;
    if (!row.lineCode || !publishedKeys.has(`${row.lineCode}|${row.period}`)) continue;
    const key = rankingHrKey(row.repHrId);
    if (!key || !activeKeys.has(key)) continue;
    linesInWindow.add(row.lineCode);
    const person = people.get(key);
    if (person?.title) titles.set(person.title, (titles.get(person.title) ?? 0) + 1);
    if (person?.regionName) regions.set(person.regionName, (regions.get(person.regionName) ?? 0) + 1);
    if (person) scoredPeople.set(key, person);
  }
  const managerChain = buildManagerChain([...people.values()].map((person) => ({ employeeName: person.name, managerName: person.managerName })));
  const managerNames = managerFilterOptions(
    [...scoredPeople.values()].map((person) => ({ employeeName: person.name, managerName: person.managerName })),
    managerChain,
  );

  const byName = (a: RankingOption, b: RankingOption) => a.label.localeCompare(b.label);
  return {
    mode,
    window,
    filters,
    boards,
    focus: focusOf(boards, filters),
    publishedMonths,
    anchorOptions: anchorOptionsFor(mode, publishedMonths),
    lineOptions: [...linesInWindow]
      .map((code) => ({ value: code, label: lineName(code) }))
      .sort(byName),
    titleOptions: [...titles.keys()].map((title) => ({ value: title, label: title })).sort(byName),
    regionOptions: [...regions.keys()].map((region) => ({ value: region, label: region })).sort(byName),
    managerOptions: managerNames.map((name) => ({ value: name, label: name })),
    nothingPublished: false,
  };
}
