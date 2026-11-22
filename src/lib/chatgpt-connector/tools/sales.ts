/**
 * Sales against target, and the rankings board.
 *
 * 🔒 THE MONTHLY CLOSING IS THE ONLY SALES TRUTH (AGENTS.md §4). Every figure here comes from the
 * closing engine through the loaders the screens use, and only a PUBLISHED (line, month) is a figure —
 * an unpublished month is withheld and named, never shown as a zero. Units of different products are
 * never added (they are reported only when the rows carry one product). A quarter is the sum of its
 * months by value; achievement is graded sales value over target value, computed by `totalRows`.
 *
 * Mirrors app/(admin)/sales/vs-target/page.tsx (`sales:read`, `resolveVsTargetBound` +
 * `filterRowsForBound` before any roll-up) and app/(admin)/sales/rankings/page.tsx (`sales:read`,
 * `buildRankingsPage`). The rows are Employee 360's window (`loadEmployee360SalesWindow`): area merges
 * applied and each month credited to whoever held the seat on its last day (seat-tenure-credit.ts,
 * owner 2026-10-26), so one person's figure matches their Employee 360 and Sales vs Target node.
 */
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import {
  employee360TeamTreeMissing,
  loadEmployee360SalesWindow,
  maskRestrictedEmployee360Rows,
  selectEmployee360TeamRows,
} from "@/lib/employee-360/sales-canonical";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { SALES_LINES, lineName, loadAllCanonicalAreaNames, loadEmployeeNameMap } from "@/lib/sales/monthly-targets";
import { buildRankingsPage } from "@/lib/sales/rankings-page";
import type { RankingEntry } from "@/lib/sales/rankings";
import { regionalManagerAbove } from "@/lib/sales/seat-hierarchy";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  rollupByArea,
  rollupByDm,
  rollupByRegion,
  rollupByRegionalManager,
  rollupByRep,
  rollupByTeam,
  salesVsTargetPeriods,
  totalRows,
  unitsAreAddable,
  type VsTargetNode,
  type VsTargetTotals,
} from "@/lib/sales/vs-target";
import { buildVsTargetNames } from "@/lib/sales/vs-target-page";
import { filterRowsForBound, resolveVsTargetBound } from "@/lib/sales/vs-target-scope";
import {
  capRows,
  cappedNote,
  formatEgp,
  formatRatio,
  monthLabel,
  monthsBetween,
  monthsOfPublicationKeys,
  normalizeSearchText,
  parsePeriod,
  periodRangeLabel,
  personLabel,
  pickOnePerson,
  publicationGaps,
  resolveLineCode,
  resolveMonthRange,
  roundMoney,
  roundRatio,
} from "@/lib/chatgpt-connector/tools/helpers";
import { defineTool, ToolRefusal } from "@/lib/chatgpt-connector/types";

/** The widest range one call may read — the achievement loader's own cap (ACHIEVEMENT_MAX_MONTHS). */
const MAX_MONTHS = 24;

const SALES_GROUPINGS = [
  "company",
  "line",
  "region",
  "area",
  "rep",
  "district_manager",
  "regional_manager",
] as const;
type SalesGrouping = (typeof SALES_GROUPINGS)[number];

function totalsData(total: VsTargetTotals, unitsAddable: boolean) {
  return {
    salesValue: roundMoney(total.actualValue),
    targetValue: roundMoney(total.targetValue),
    achievement: roundRatio(total.achievementValue),
    achievementText: formatRatio(total.achievementValue),
    salesWithNoTargetValue: roundMoney(total.uncoveredActualValue),
    ...(unitsAddable ? { salesUnits: total.actualUnits, targetUnits: total.targetUnits } : {}),
  };
}

function nodeData(node: VsTargetNode) {
  return { name: node.name, ...totalsData(node.current, false) };
}

function totalsSentence(total: VsTargetTotals): string {
  return `sales ${formatEgp(total.actualValue)} against a target of ${formatEgp(total.targetValue)} — achievement ${formatRatio(total.achievementValue)}`;
}

export const salesAchievementTool = defineTool({
  name: "phoenix_sales_achievement",
  title: "Sales vs target",
  description:
    "Sales value, target value and achievement % from the PUBLISHED Monthly Closing — the only source of sales and target figures in Phoenix. " +
    "Give a month range (from/to as YYYY-MM, July 2026 onwards); leave both out for the latest quarter whose three months are all published. " +
    "groupBy splits the result by company, line, region, area, rep, district_manager or regional_manager. " +
    "Pass `person` (a name or HR id) for one person's figure — a rep's own areas, or a manager's whole team, each month credited to whoever held the seat on its last day. " +
    "Narrow with `line` (CNS, Pedia, Anti-infective) or `area`. Returns each month and the total; a quarter is the sum of its months by value and achievement = sales value / target value. " +
    "Months whose closing is not published are withheld and named, never shown as zero. Units are given only when every row is one product.",
  input: {
    from: z.string().optional().describe("First month, YYYY-MM."),
    to: z.string().optional().describe("Last month, YYYY-MM."),
    groupBy: z.enum(SALES_GROUPINGS).optional().describe("How to split the figures. Default company (one total)."),
    person: z.string().max(120).optional().describe("A person's name or HR id: their own (or their team's) figure."),
    line: z.string().max(40).optional().describe("CNS, Pedia or Anti-infective."),
    area: z.string().max(80).optional().describe("An area name."),
  },
  run: async (ctx, input) => {
    await assertPermission(ctx, "sales", "read");
    const bound = await resolveVsTargetBound(ctx);
    if (bound.kind === "none") throw new ToolRefusal("Your role has no sales territory to report on.");

    const window = await loadEmployee360SalesWindow();
    const publishedMonths = monthsOfPublicationKeys(window.publishedKeys);
    const { from, to } = resolveMonthRange(input.from, input.to, publishedMonths, {
      floor: SALES_VS_TARGET_FLOOR,
      maxMonths: MAX_MONTHS,
    });
    const months = monthsBetween(from, to);
    const monthSet = new Set(months);
    const { current } = salesVsTargetPeriods();
    if (from > current) throw new ToolRefusal(`${monthLabel(from)} has not happened yet.`);

    // Scope FIRST, before any roll-up (vs-target-page.ts), then the confidential-product strip.
    let rows = maskRestrictedEmployee360Rows(
      filterRowsForBound(
        window.rows.filter((row) => monthSet.has(row.period)),
        bound,
      ),
      ctx.role,
    );

    const filters: string[] = [];
    if (input.line) {
      const code = resolveLineCode(input.line, SALES_LINES);
      if (!code) throw new ToolRefusal(`"${input.line}" is not a sales line. The lines are CNS, Pedia and Anti-infective.`);
      rows = rows.filter((row) => row.lineCode === code);
      filters.push(lineName(code));
    }

    const [areaNames, employeeNames] = await Promise.all([loadAllCanonicalAreaNames(), loadEmployeeNameMap()]);
    const distinctLines = new Set(rows.map((row) => row.lineCode).filter(Boolean));
    const activeLine = distinctLines.size === 1 ? ([...distinctLines][0] as string) : null;
    const names = buildVsTargetNames(activeLine, to, areaNames, employeeNames);

    if (input.area) {
      const wanted = normalizeSearchText(input.area);
      if (!wanted) throw new ToolRefusal(`"${input.area}" is not an area name.`);
      const labelOf = (code: string) => normalizeSearchText(names.areaName(code));
      // The whole name or the code only: a part of a name is never taken as the area ("Cairo" is not Heliopolis's sales,
      // and "Beni Suef" is not the merged "Fayoum - Beni Suef").
      const matching = rows.filter((row) => Boolean(row.areaCode) && (labelOf(row.areaCode as string) === wanted || normalizeSearchText(row.areaCode) === wanted));
      if (matching.length === 0) {
        const close = [...new Set(rows.filter((row) => row.areaCode && labelOf(row.areaCode).includes(wanted)).map((row) => names.areaName(row.areaCode as string)))].sort();
        throw new ToolRefusal(
          close.length > 0
            ? `No area is called "${input.area}". Areas whose name contains it: ${close.join(", ")}. Ask for one of them by its full name.`
            : `No area you can see matches "${input.area}".`,
        );
      }
      rows = matching;
      filters.push(`area ${input.area}`);
    }

    let subjectLabel: string | null = null;
    if (input.person) {
      const directory = await getEmployeeDirectoryRows({ includeInactive: true });
      const subject = pickOnePerson(directory, input.person);
      if (employee360TeamTreeMissing(rows, subject.hrId, [], window)) {
        throw new ToolRefusal(`The sales seat tree could not be read just now, so ${personLabel(subject)}'s team total cannot be placed. Try again shortly.`);
      }
      rows = selectEmployee360TeamRows(rows, subject.hrId, [], window);
      subjectLabel = personLabel(subject);
    }

    const gaps = publicationGaps(
      rows,
      months,
      window.publishedKeys,
      SALES_LINES.map((line) => line.code),
    );
    const published = rows.filter((row) => isRowPublished(row, window.publishedKeys));
    const unitsAddable = unitsAreAddable(published);
    const total = totalRows(published);
    const perMonth = months
      .filter((period) => !gaps.withheld.includes(period))
      .map((period) => {
        const monthRows = published.filter((row) => row.period === period);
        return { period, label: monthLabel(period), ...totalsData(totalRows(monthRows), unitsAreAddable(monthRows)) };
      });

    const groupBy: SalesGrouping = input.groupBy ?? "company";
    let nodes: VsTargetNode[] = [];
    if (groupBy === "line") nodes = rollupByTeam(published, null, names);
    else if (groupBy === "region") nodes = rollupByRegion(published, null, names);
    else if (groupBy === "area") nodes = rollupByArea(published, null, names);
    else if (groupBy === "rep") nodes = rollupByRep(published, null, names);
    else if (groupBy === "district_manager") nodes = rollupByDm(published, null, names);
    else if (groupBy === "regional_manager") {
      nodes = rollupByRegionalManager(published, null, names, (row) => regionalManagerAbove(row.dmSeatId, window.seats)?.hrId ?? null);
    }
    const cappedNodes = capRows(nodes);
    const unattributedToRep =
      groupBy === "rep"
        ? roundMoney(published.filter((row) => !row.repHrId).reduce((sum, row) => sum + row.actualValue, 0))
        : null;

    const range = periodRangeLabel(from, to);
    const who = subjectLabel ?? (bound.kind === "company" ? "Company" : "Your scope");
    const scopeWords = [who, ...filters].join(", ");
    const parts: string[] = [];
    if (published.length === 0) {
      parts.push(`${scopeWords}, ${range}: no published sales figures.`);
    } else {
      parts.push(`${scopeWords}, ${range}: ${totalsSentence(total)}.`);
      if (perMonth.length > 1 && perMonth.length <= 6) {
        parts.push(
          perMonth
            .map((month) => `${month.label}: ${formatEgp(month.salesValue)} of ${formatEgp(month.targetValue)} (${month.achievementText})`)
            .join("; ") + ".",
        );
      }
    }
    if (gaps.withheld.length > 0) {
      parts.push(`Withheld — Monthly Closing not published yet: ${gaps.withheld.map(monthLabel).join(", ")}.`);
    }
    for (const gap of gaps.partial) {
      const lineWords = gap.unpublishedLineCodes.map((code) => lineName(code)).join(", ");
      parts.push(`${monthLabel(gap.period)} counts only published lines (${lineWords} not published yet).`);
    }
    if (cappedNodes.rows.length > 0) {
      parts.push(
        `By ${groupBy.replace("_", " ")}: ` +
          cappedNodes.rows
            .slice(0, 5)
            .map((node) => `${node.name} ${formatEgp(node.current.actualValue)} (${formatRatio(node.current.achievementValue)})`)
            .join("; ") +
          (cappedNodes.total > 5 ? "; …" : "") +
          "." +
          cappedNote(cappedNodes.total, cappedNodes.rows.length),
      );
    }
    if (subjectLabel) parts.push("Each month is credited to whoever held the seat on its last day.");

    return {
      summary: parts.join(" "),
      data: {
        source: "Published Monthly Closing",
        from,
        to,
        periodLabel: range,
        scope: scopeWords,
        currency: "EGP",
        total: totalsData(total, unitsAddable),
        months: perMonth,
        withheldMonths: gaps.withheld,
        partlyPublishedMonths: gaps.partial.map((gap) => ({
          period: gap.period,
          unpublishedLines: gap.unpublishedLineCodes.map((code) => lineName(code)),
        })),
        groupBy,
        groups: cappedNodes.rows.map(nodeData),
        groupsTotal: cappedNodes.total,
        groupsCapped: cappedNodes.capped,
        ...(unattributedToRep != null ? { salesNotAttributedToARep: unattributedToRep } : {}),
      },
    };
  },
});

function rankingEntryData(entry: RankingEntry) {
  return {
    rank: entry.rank,
    hrId: entry.hrId,
    name: entry.name,
    title: entry.title,
    line: entry.lineLabel,
    region: entry.regionName,
    achievementPercent: entry.achievementPercent,
    salesValue: roundMoney(entry.salesValue),
    targetValue: roundMoney(entry.targetValue),
    priorRank: entry.priorRank,
    movedUpBy: entry.trend,
  };
}

export const salesRankingsTool = defineTool({
  name: "phoenix_sales_rankings",
  title: "Sales rankings",
  description:
    "The Rankings board from the published Monthly Closing: medical reps ranked by achievement (full sales over target), " +
    "overall and per line, plus district managers ranked by their team. window = month, quarter, semester, year, or published (every published month). " +
    "period = a YYYY-MM month inside the window you want (default: the newest published month). Optional line filter and name search.",
  input: {
    window: z.enum(["month", "quarter", "semester", "year", "published"]).optional().describe("Default month."),
    period: z.string().optional().describe("A YYYY-MM month inside the wanted window."),
    line: z.string().max(40).optional().describe("CNS, Pedia or Anti-infective."),
    query: z.string().max(120).optional().describe("Narrow the board to people whose name matches."),
  },
  run: async (ctx, input) => {
    // app/(admin)/sales/rankings/page.tsx: sales:read, then the company-wide board.
    await assertPermission(ctx, "sales", "read");
    if (input.period && !parsePeriod(input.period)) throw new ToolRefusal("period must be written YYYY-MM, for example 2026-09.");
    let lines: string | undefined;
    if (input.line) {
      const code = resolveLineCode(input.line, SALES_LINES);
      if (!code) throw new ToolRefusal(`"${input.line}" is not a sales line. The lines are CNS, Pedia and Anti-infective.`);
      lines = code;
    }
    const page = await buildRankingsPage({ mode: input.window ?? "month", period: input.period, lines, q: input.query });
    if (page.nothingPublished) {
      return { summary: "No Monthly Closing has been published yet, so there is no ranking.", data: { boards: null } };
    }
    const overall = capRows(page.boards.overall);
    const top = overall.rows
      .slice(0, 5)
      .map((entry) => `#${entry.rank} ${entry.name} (${entry.lineLabel}) ${entry.achievementPercent.toFixed(1)}%`)
      .join("; ");
    const dms = page.boards.districtManagers.slice(0, 3).map((entry) => `${entry.name} ${entry.achievementPercent.toFixed(1)}%`);
    return {
      summary:
        `Rankings for ${page.window.rangeLabel || page.window.label}: ${page.boards.ranked} reps ranked` +
        `${page.boards.seats != null ? ` across ${page.boards.seats} rep seats` : ""}. Top: ${top || "none"}.` +
        (dms.length > 0 ? ` Leading district managers: ${dms.join("; ")}.` : "") +
        cappedNote(overall.total, overall.rows.length),
      data: {
        source: "Published Monthly Closing",
        window: page.window,
        overall: overall.rows.map(rankingEntryData),
        overallTotal: overall.total,
        overallCapped: overall.capped,
        byLine: page.boards.byLine.map((board) => ({
          line: board.lineLabel,
          repSeats: board.seats,
          entries: capRows(board.entries).rows.map(rankingEntryData),
        })),
        districtManagers: page.boards.districtManagers.map(rankingEntryData),
        repSeats: page.boards.seats,
        vacantSeats: page.boards.vacant,
      },
    };
  },
});
