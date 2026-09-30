"use client";

/**
 * Phoenix CRM — the Reports tab.
 *
 * Owner, 2026-09-16: the first report shows
 *   - visits per rep per day, accounts (AM) and doctors (PM) apart;
 *   - plan against actual: planned customers visited or missed, per day;
 *   - coverage and frequency: the share of the list visited in the month, and visits against each
 *     grade's monthly number;
 *   - double visits per manager: which reps each manager went out with, and when (chain visits too).
 *
 * Every figure is counted from what the field force enters in Phoenix CRM, never from iReports360.
 * AM and PM are never added together or averaged. A day or a month still running says so.
 * Percentages carry no colour: nobody has set a coverage or frequency level that counts as good.
 * Territories and managers with nothing yet are still listed, so a gap shows instead of vanishing.
 * The Super Admin's test entries count only when the Super Admin ticks them in.
 */

import { Fragment, useId, useState, type ReactNode } from "react";

import { crmUrl, useCrmGet, type CrmResource } from "@/components/phoenix-crm/api";
import { DailyPlanDaysFilter, DailyPlanSection, dailyPlanDaysSummary, useDailyPlanDays } from "@/components/phoenix-crm/daily-plan-report";
import { countText, dayLabel, dayLabelWithYear, monthLabel, percentText, plural, shiftIsoDay } from "@/components/phoenix-crm/format";
import { matchesWords } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmCheck,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSearchField,
  CrmSelect,
  CrmShowMore,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { fieldWeekStart, isIsoDay, monthStartOf, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { dailyPlanPeriodProblem, type DailyPlanReportView } from "@/lib/phoenix-crm/daily-plan-report";
import type { AdoptionStage } from "@/lib/phoenix-crm/adoption-rules";
import type { BrickCoverageStatus } from "@/lib/phoenix-crm/brick-report";
import {
  daysInPeriod,
  REPORT_MAX_DAYS,
  type ComparisonMode,
  type CoverageCell,
  type Delta,
  type PlanCounts,
  type VisitCounts,
} from "@/lib/phoenix-crm/report-rules";
import type {
  AdoptionView,
  BrickCoverageView,
  CoverageReportView,
  ReportComparison,
  ExceptionsView,
  ManagerReportEntry,
  ManagerReportRow,
  ManagerReportView,
  PlanCell,
  PlanReportView,
  ReportScopeView,
  ReportTerritory,
  RepVisitRow,
  TerritoryCoverageRow,
  TerritoryPlanRow,
  VisitLocationReportView,
  VisitsReportView,
} from "@/lib/phoenix-crm/view-types";
import { downloadXlsxFrom } from "@/lib/export/download-xlsx-client";
import { cn } from "@/lib/utils";

type ReportSection = "exceptions" | "visits" | "plan" | "daily" | "coverage" | "bricks" | "managers" | "locations" | "adoption";
type PeriodPreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month";
type Period = { from: string; to: string };
type Presence = "all" | "with" | "without";

const REPORTS_PATH = "/api/phoenix-crm/reports";
const PAGE = 25;
const SEARCH_FROM = 8;
const MONTHS_OFFERED = 12;
/** Phoenix CRM opened in September 2026: no day before it holds an entry, so the pickers stop there. */
const FIRST_REPORT_DAY = "2026-09-01";
const FRIDAY = 5;

const PRESETS: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
];

// ── Periods ─────────────────────────────────────────────────────────────────────────────────────

/** The days a quick pick stands for. A week is the field week from its Saturday; nothing runs past today. */
function presetPeriod(preset: PeriodPreset, today: string): Period {
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const yesterday = shiftIsoDay(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (preset === "this_week") return { from: fieldWeekStart(today), to: today };
  if (preset === "last_week") {
    const start = shiftIsoDay(fieldWeekStart(today), -7);
    return { from: start, to: shiftIsoDay(start, 5) };
  }
  if (preset === "this_month") return { from: monthStartOf(today), to: today };
  const lastMonthEnd = shiftIsoDay(monthStartOf(today), -1);
  return { from: monthStartOf(lastMonthEnd), to: lastMonthEnd };
}

/** Why the chosen days cannot be read, in the server's own words; null when they can. */
function periodProblem(period: Period, today: string, maxDays: number): string | null {
  if (!isIsoDay(period.from)) return "Choose a valid first day.";
  if (!isIsoDay(period.to)) return "Choose a valid last day.";
  if (period.to > today) return "The last day cannot be after today.";
  if (period.from > period.to) return "The first day is after the last day.";
  if (daysInPeriod(period.from, period.to) > maxDays) return `Choose at most ${maxDays} days.`;
  return null;
}

/** "Tue 1 Sept – Thu 17 Sept 2026", or a single day. */
function periodText(period: Period): string {
  if (period.from === period.to) return dayLabelWithYear(period.from);
  const sameYear = period.from.slice(0, 4) === period.to.slice(0, 4);
  return `${sameYear ? dayLabel(period.from) : dayLabelWithYear(period.from)} – ${dayLabelWithYear(period.to)}`;
}

/** Every day of a period, in order (a period is at most a month). */
function daysOf(period: Period): string[] {
  const days: string[] = [];
  for (let day = period.from; day <= period.to; day = shiftIsoDay(day, 1)) days.push(day);
  return days;
}

/** The months a coverage report can read, newest first: this month back to the month Phoenix CRM opened. */
function offeredMonths(today: string): string[] {
  const months: string[] = [];
  let start = monthStartOf(today);
  while (months.length < MONTHS_OFFERED && start >= FIRST_REPORT_DAY) {
    months.push(start.slice(0, 7));
    start = monthStartOf(shiftIsoDay(start, -1));
  }
  return months.length > 0 ? months : [today.slice(0, 7)];
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function amPmText(am: number, pm: number): string {
  return `${countText(am)} AM · ${countText(pm)} PM`;
}

function repText(repName: string | null): string {
  return repName ?? "No rep in this territory";
}

// ── Shared pieces ───────────────────────────────────────────────────────────────────────────────

/** A section's figures while they load, or the sentence saying why they did not. */
function SectionWaiting({ error, label, onRetry }: { error: string | null; label: string; onRetry: () => void }) {
  return <div className="border-t border-slate-100">{error ? <CrmLoadError message={error} onRetry={onRetry} /> : <CrmLoading label={label} />}</div>;
}

/** Figures still on screen after a refresh that failed: they stay, with the reason above them. */
function RefreshFailed({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="px-4 pt-4 sm:px-5">
      <CrmNote title="These figures could not be refreshed" tone="warn">
        {error}
      </CrmNote>
    </div>
  );
}

function DaysToggle({ onToggle, open }: { onToggle: () => void; open: boolean }) {
  return (
    <CrmButton aria-expanded={open} onClick={onToggle} size="sm" variant="ghost">
      {open ? "Hide the days" : "Show the days"}
    </CrmButton>
  );
}

type DayLine = { date: string; lines: string[]; muted?: boolean };

/** One row per day: the day, then what happened on it; today is marked as still running. */
function DayList({ days, today }: { days: ReadonlyArray<DayLine>; today: string }) {
  if (days.length === 0) return <p className="text-sm font-semibold text-slate-500">No day to show.</p>;
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
      {days.map((day) => (
        <li className="grid min-w-0 gap-1 px-3 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-3" key={day.date}>
          <p className="break-words text-xs font-black leading-6 text-slate-600">
            {dayLabel(day.date)}
            {day.date === today ? " · today, still running" : ""}
          </p>
          <div className={cn("min-w-0 text-sm font-semibold leading-6", day.muted ? "text-slate-400" : "text-slate-700")}>
            {day.lines.map((line, index) => (
              <p className="break-words" key={index}>
                {line}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── The list every section shares: show filter, search, pages, open days ────────────────────────

type ReportListWords = {
  title: string;
  all: string;
  with: string;
  without: string;
  searchLabel: string;
  searchPlaceholder: string;
  noneMatch: string;
};

type ReportListProps<T> = {
  columns: ReadonlyArray<string | null>;
  explain?: ReactNode;
  /** Whether the row has anything to report (the "with" side of the show filter). */
  hasData: (item: T) => boolean;
  headers: ReadonlyArray<ReactNode>;
  idPrefix: string;
  items: ReadonlyArray<T>;
  keyOf: (item: T) => string;
  /** The row as a phone card; `open` says whether its days show. */
  renderCard: (item: T, open: boolean, onToggle: () => void) => ReactNode;
  /** The row's table cells. */
  renderCells: (item: T, open: boolean, onToggle: () => void) => ReactNode;
  /** The row's days, drawn under the row while open. */
  renderOpen?: (item: T) => ReactNode;
  searchWords: (item: T) => ReadonlyArray<string | null | undefined>;
  words: ReportListWords;
};

function ReportList<T>({
  columns,
  explain,
  hasData,
  headers,
  idPrefix,
  items,
  keyOf,
  renderCard,
  renderCells,
  renderOpen,
  searchWords,
  words,
}: ReportListProps<T>) {
  const [presence, setPresence] = useState<Presence>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

  const withCount = items.filter(hasData).length;
  const hasBoth = withCount > 0 && withCount < items.length;
  const currentPresence: Presence = hasBoth ? presence : "all";
  const searchable = items.length > SEARCH_FROM;
  const rows = items.filter(
    (item) =>
      (currentPresence === "all" || hasData(item) === (currentPresence === "with")) &&
      (!searchable || matchesWords(query, searchWords(item))),
  );
  const shown = rows.slice(0, limit);
  const presenceOptions: Array<CrmChoiceOption<Presence>> = [
    { value: "all", label: words.all, note: countText(items.length) },
    { value: "with", label: words.with, note: countText(withCount) },
    { value: "without", label: words.without, note: countText(items.length - withCount) },
  ];

  function toggle(key: string) {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title={words.title}>
        {explain ? <div className="break-words text-sm font-medium leading-6 text-slate-600">{explain}</div> : null}
        {hasBoth || searchable ? (
          <div
            className={cn(
              "grid min-w-0 gap-3",
              explain ? "mt-3" : undefined,
              hasBoth && searchable ? "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end" : undefined,
            )}
          >
            {hasBoth ? (
              <CrmField label="Show">
                <CrmChoice
                  columns={3}
                  label="Show"
                  onChange={(next) => {
                    setPresence(next);
                    setLimit(PAGE);
                  }}
                  options={presenceOptions}
                  value={currentPresence}
                />
              </CrmField>
            ) : null}
            {searchable ? (
              <CrmSearchField
                id={`${idPrefix}-search`}
                label={words.searchLabel}
                onChange={(next) => {
                  setQuery(next);
                  setLimit(PAGE);
                }}
                placeholder={words.searchPlaceholder}
                value={query}
              />
            ) : null}
          </div>
        ) : null}
      </CrmBlock>

      {rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search or choose another filter." title={words.noneMatch} />
        </div>
      ) : (
        <div className="border-t border-slate-100">
          <CrmCardsOnPhone>
            {shown.map((item) => {
              const key = keyOf(item);
              return <Fragment key={key}>{renderCard(item, openKeys.has(key), () => toggle(key))}</Fragment>;
            })}
          </CrmCardsOnPhone>
          <CrmTable columns={columns}>
            <thead>
              <tr>
                {headers.map((header, index) => (
                  <th className={crmThClassName} key={index} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const key = keyOf(item);
                const open = openKeys.has(key);
                return (
                  <Fragment key={key}>
                    <tr>{renderCells(item, open, () => toggle(key))}</tr>
                    {open && renderOpen ? (
                      <tr>
                        <td className="border-b border-slate-100 bg-slate-50 px-3 py-3" colSpan={columns.length}>
                          {renderOpen(item)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </CrmTable>
          <CrmShowMore left={rows.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </div>
      )}
    </>
  );
}

const LIST_WORDS = {
  all: "All",
  searchLabel: "Find a territory or rep",
  searchPlaceholder: "Territory, line or rep",
  noneMatch: "Nothing matches",
} as const;

// ── Visits per rep per day ──────────────────────────────────────────────────────────────────────

type VisitLine = { key: string; territoryName: string; repName: string; row: RepVisitRow | null };

/**
 * The report's rows (only reps and managers who visited), then a line for every chosen territory whose
 * rep entered no visit, so a territory with nothing still shows.
 */
function visitLines(report: VisitsReportView, territories: ReadonlyArray<ReportTerritory>): VisitLine[] {
  const repVisited = new Set(report.rows.filter((row) => row.repHrId !== null).map((row) => row.seatId));
  const lines: VisitLine[] = report.rows.map((row) => ({ key: row.key, territoryName: row.territoryName, repName: row.repName, row }));
  for (const territory of territories) {
    if (repVisited.has(territory.seatId)) continue;
    lines.push({ key: `${territory.seatId}|none`, territoryName: territory.name, repName: repText(territory.repName), row: null });
  }
  return lines;
}

/**
 * "2 double · 1 chain · 1 far from the place"; null when none of those happened.
 *
 * 🔴 `canSeeLocations` gates the LAST of the three, and the Reports tab is open to a rep on his own
 * territory. A tally of his own distances is a count of flags — exactly what Golden Rule #1 keeps off
 * his screen (owner, 2026-09-26) — while the same figure is the manager's whole point. The same
 * predicate already decides who may open the place-vs-actual section, so the two can never disagree.
 */
function visitKindsText(counts: VisitCounts, canSeeLocations: boolean): string | null {
  const parts = [
    counts.doubleVisits > 0 ? `${countText(counts.doubleVisits)} double` : null,
    counts.chainVisits > 0 ? `${countText(counts.chainVisits)} chain` : null,
    canSeeLocations && counts.farVisits > 0 ? `${countText(counts.farVisits)} far from the place` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The kinds, and the Super Admin's test visits among the figures when they are counted. */
function visitDetailText(counts: VisitCounts, includeTest: boolean, canSeeLocations: boolean): string | null {
  const parts = [visitKindsText(counts, canSeeLocations), includeTest && counts.testVisits > 0 ? `${countText(counts.testVisits)} test` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "12 visits · 2 double · 1 far from the place", or "No visits". */
function visitCountsText(counts: VisitCounts | null, includeTest: boolean, canSeeLocations: boolean): string {
  if (!counts || counts.visits === 0) return "No visits";
  const detail = visitDetailText(counts, includeTest, canSeeLocations);
  return detail ? `${plural(counts.visits, "visit", "visits")} · ${detail}` : plural(counts.visits, "visit", "visits");
}

function visitDayLine(listType: "AM" | "PM", counts: VisitCounts, includeTest: boolean, canSeeLocations: boolean): string {
  return `${listType}: ${counts.visits === 0 ? "no visits" : visitCountsText(counts, includeTest, canSeeLocations)}`;
}

/** Every day of the period (a Friday only when someone visited), doctors and accounts on their own lines. */
function visitDayLines(row: RepVisitRow, period: Period, includeTest: boolean, canSeeLocations: boolean): DayLine[] {
  const byDate = new Map(row.days.map((day) => [day.date, day]));
  return daysOf(period).flatMap((date): DayLine[] => {
    const day = byDate.get(date);
    if (!day || (day.am.visits === 0 && day.pm.visits === 0)) {
      return weekdayOfIsoDay(date) === FRIDAY ? [] : [{ date, lines: ["No visits"], muted: true }];
    }
    return [{ date, lines: [visitDayLine("PM", day.pm, includeTest, canSeeLocations), visitDayLine("AM", day.am, includeTest, canSeeLocations)] }];
  });
}

// ── Comparison (C3) ─────────────────────────────────────────────────────────────────────────────

/**
 * The second LINE on a cell — never a second column.
 *
 * The fits-the-screen rule: a comparison that added a column to every figure would double the width
 * of three tables that already fill a desktop, and on a phone it would push them into the horizontal
 * scroll the rule bans outright. So the cell keeps its one column and gains a line under it.
 *
 * 🔴 **A rise from a baseline of zero has no percentage.** `changePct` is null there and this prints
 * the change alone: "+3 vs 0" is true, "+100%" is invented, and a board that shouts a number it made
 * up is a board a manager stops believing.
 */
function DeltaLine({ value }: { value: Delta | undefined }) {
  if (!value || value.baseline === null || value.change === null) return null;
  const tone = value.direction === "up" ? "text-emerald-700" : value.direction === "down" ? "text-rose-700" : "text-slate-500";
  const sign = value.change > 0 ? "+" : "";
  const percent = value.changePct === null ? null : `${value.changePct > 0 ? "+" : ""}${value.changePct}%`;
  return (
    <p className={cn("mt-0.5 break-words text-xs font-semibold", tone)}>
      {`vs ${countText(value.baseline)} · ${sign}${countText(value.change)}${percent ? ` · ${percent}` : ""}`}
    </p>
  );
}

/** The same line inside a mobile card's fact list, where a <p> would break the layout. */
function deltaFact(value: Delta | undefined): ReactNode {
  if (!value || value.baseline === null || value.change === null) return null;
  const sign = value.change > 0 ? "+" : "";
  const percent = value.changePct === null ? null : `${value.changePct > 0 ? "+" : ""}${value.changePct}%`;
  return <span className="block font-semibold text-slate-500">{`vs ${countText(value.baseline)} · ${sign}${countText(value.change)}${percent ? ` · ${percent}` : ""}`}</span>;
}

/** A section's comparison, indexed by territory, so a row can find its own baseline in one lookup. */
function deltasBySeat(comparison: ReportComparison | null): Map<string, { am: Delta; pm: Delta }> {
  return new Map((comparison?.bySeat ?? []).map((entry) => [entry.seatId, { am: entry.am, pm: entry.pm }]));
}

function visitCell(counts: VisitCounts | null, includeTest: boolean, canSeeLocations: boolean, change?: Delta) {
  if (!counts || counts.visits === 0) {
    return (
      <td className={crmTdClassName}>
        <p className="text-slate-400">No visits</p>
        <DeltaLine value={change} />
      </td>
    );
  }
  const detail = visitDetailText(counts, includeTest, canSeeLocations);
  return (
    <td className={crmTdClassName}>
      <p className="font-black text-slate-950">{plural(counts.visits, "visit", "visits")}</p>
      {detail ? <p className="mt-0.5 text-xs text-slate-500">{detail}</p> : null}
      <DeltaLine value={change} />
    </td>
  );
}

function VisitsSection({
  canSeeLocations,
  idPrefix,
  resource,
  territories,
  today,
}: {
  /** Whether a count of distances is this viewer's to read — a rep's is not (Golden Rule #1). */
  canSeeLocations: boolean;
  idPrefix: string;
  resource: CrmResource<VisitsReportView>;
  territories: ReadonlyArray<ReportTerritory>;
  today: string;
}) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Counting the visits" onRetry={resource.reload} />;

  const { AM: am, PM: pm } = report.totals;
  const changes = deltasBySeat(report.comparison);
  const repRows = report.rows.filter((row) => row.repHrId !== null);
  const reps = new Set(repRows.map((row) => row.repHrId)).size;
  const repDays = repRows.reduce((sum, row) => sum + row.visitDays, 0);
  const oneDay = report.period.from === report.period.to;
  const kindsNote = (counts: VisitCounts, noneVisited: string) =>
    visitKindsText(counts, canSeeLocations) ??
    (counts.visits === 0 ? noneVisited : canSeeLocations ? "No double, chain or far visit" : "No double or chain visit");

  return (
    <>
      <RefreshFailed error={resource.error} />
      {report.includeTest ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Your test entries are counted" tone="info">
            Test visits among these figures: {amPmText(am.testVisits, pm.testVisits)}.
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="AM visits" note={<>{kindsNote(am, "No AM visited")}{deltaFact(report.comparison?.totals.AM)}</>} value={countText(am.visits)} />
          <CrmStat label="PM visits" note={<>{kindsNote(pm, "No PM visited")}{deltaFact(report.comparison?.totals.PM)}</>} value={countText(pm.visits)} />
          <CrmStat label="Reps who visited" note={periodText(report.period)} value={countText(reps)} />
          <CrmStat label="Rep days with visits" note="Each rep's days with a visit, added up" value={countText(repDays)} />
        </CrmStatGrid>
      </CrmBlock>
      <ReportList
        columns={oneDay ? ["34%", null, null] : ["30%", "13%", null, null, "15%"]}
        explain="Visits as the rep entered them, on the day they happened. A double or chain visit counts here once, as the rep's visit; the managers on it are counted in their own report."
        hasData={(line) => line.row !== null}
        headers={
          oneDay
            ? ["Territory and rep", "PM", "AM"]
            : [
                "Territory and rep",
                "Days with visits",
                "PM",
                "AM",
                <span className="sr-only" key="days">
                  Days
                </span>,
              ]
        }
        idPrefix={`${idPrefix}-visits`}
        items={visitLines(report, territories)}
        keyOf={(line) => line.key}
        renderCard={(line, open, onToggle) => (
          <CrmCard meta={line.repName} title={line.territoryName}>
            <CrmFacts
              facts={[
                { label: "PM", value: visitCountsText(line.row?.pm ?? null, report.includeTest, canSeeLocations) },
                { label: "AM", value: visitCountsText(line.row?.am ?? null, report.includeTest, canSeeLocations) },
              ]}
            />
            {oneDay ? null : (
              <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="break-words text-xs font-semibold text-slate-500">
                  {line.row ? `Visits on ${plural(line.row.visitDays, "day", "days")}` : "No visit on these days"}
                </p>
                {line.row ? <DaysToggle onToggle={onToggle} open={open} /> : null}
              </div>
            )}
            {!oneDay && open && line.row ? (
              <div className="mt-3">
                <DayList days={visitDayLines(line.row, report.period, report.includeTest, canSeeLocations)} today={today} />
              </div>
            ) : null}
          </CrmCard>
        )}
        renderCells={(line, open, onToggle) => (
          <>
            <td className={crmTdClassName}>
              <p className="font-black text-slate-950">{line.territoryName}</p>
              <p className="mt-0.5 text-xs text-slate-500">{line.repName}</p>
            </td>
            {oneDay ? null : <td className={crmTdClassName}>{line.row ? plural(line.row.visitDays, "day", "days") : "—"}</td>}
            {visitCell(line.row?.pm ?? null, report.includeTest, canSeeLocations, changes.get(line.row?.seatId ?? "")?.pm)}
            {visitCell(line.row?.am ?? null, report.includeTest, canSeeLocations, changes.get(line.row?.seatId ?? "")?.am)}
            {oneDay ? null : <td className={crmTdClassName}>{line.row ? <DaysToggle onToggle={onToggle} open={open} /> : null}</td>}
          </>
        )}
        renderOpen={
          oneDay ? undefined : (line) => (line.row ? <DayList days={visitDayLines(line.row, report.period, report.includeTest, canSeeLocations)} today={today} /> : null)
        }
        searchWords={(line) => [line.territoryName, line.repName]}
        words={{ ...LIST_WORDS, title: "By territory and rep", with: "With visits", without: "No visits" }}
      />
    </>
  );
}

// ── Plan against actual ─────────────────────────────────────────────────────────────────────────

const NO_PLAN: PlanCell = { planned: 0, visitedPlanned: 0, plannedWaiting: 0, missed: 0, unplanned: 0, unplannedWaiting: 0, unplannedRefused: 0, keptPct: null };

type PlanLine = { key: string; territoryName: string; repName: string | null; row: TerritoryPlanRow | null };

/** The report's territories, then every chosen territory with no plan and no visit, so it still shows. */
function planLines(report: PlanReportView, territories: ReadonlyArray<ReportTerritory>): PlanLine[] {
  const seen = new Set(report.rows.map((row) => row.seatId));
  const lines: PlanLine[] = report.rows.map((row) => ({ key: row.seatId, territoryName: row.territoryName, repName: row.repName, row }));
  for (const territory of territories) {
    if (!seen.has(territory.seatId)) lines.push({ key: territory.seatId, territoryName: territory.name, repName: territory.repName, row: null });
  }
  return lines;
}

function hasPlan(row: TerritoryPlanRow | null): boolean {
  return row !== null && (row.am.planned > 0 || row.pm.planned > 0);
}

/** "4 of 5 visited", or "Nothing planned". */
function planMainText(counts: PlanCounts): string {
  return counts.planned > 0 ? `${countText(counts.visitedPlanned)} of ${countText(counts.planned)} visited` : "Nothing planned";
}

/** "1 missed · 2 off the plan · 1 waiting"; null when none of them happened. */
function planMissText(counts: PlanCounts): string | null {
  const parts = [
    counts.missed > 0 ? `${countText(counts.missed)} missed` : null,
    // Seen, but the visit was off-plan and is not decided — so it is neither kept nor missed yet.
    counts.plannedWaiting > 0 ? `${countText(counts.plannedWaiting)} seen off-plan` : null,
    counts.unplanned > 0 ? `${countText(counts.unplanned)} off the plan` : null,
    // Beside the figure, never inside it. A day that reads low because an off-plan visit is still
    // with the manager has to SAY so, or the dip reads as a rep who did not work.
    counts.unplannedWaiting > 0 ? `${countText(counts.unplannedWaiting)} waiting` : null,
    counts.unplannedRefused > 0 ? `${countText(counts.unplannedRefused)} refused` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "80% · 1 missed · 2 off the plan". */
function planDetailText(cell: PlanCell): string | null {
  const parts = [cell.keptPct === null ? null : percentText(cell.keptPct), planMissText(cell)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function planCell(cell: PlanCell, change?: Delta) {
  const detail = planDetailText(cell);
  return (
    <td className={crmTdClassName}>
      <p className={cell.planned > 0 ? "font-black text-slate-950" : "text-slate-400"}>{planMainText(cell)}</p>
      {detail ? <p className="mt-0.5 text-xs text-slate-500">{detail}</p> : null}
      <DeltaLine value={change} />
    </td>
  );
}

function planFact(cell: PlanCell): ReactNode {
  const detail = planDetailText(cell);
  return (
    <>
      <span className="block">{planMainText(cell)}</span>
      {detail ? <span className="block font-semibold text-slate-500">{detail}</span> : null}
    </>
  );
}

function planDayLine(listType: "AM" | "PM", counts: PlanCounts): string {
  const miss = planMissText(counts);
  const main = counts.planned > 0 ? `${countText(counts.visitedPlanned)} of ${countText(counts.planned)} visited` : "nothing planned";
  return `${listType}: ${main}${miss ? ` · ${miss}` : ""}`;
}

/** Every day of the period (a Friday only when something happened), doctors and accounts on their own lines. */
function planDayLines(row: TerritoryPlanRow, period: Period): DayLine[] {
  const byDate = new Map(row.days.map((day) => [day.date, day]));
  return daysOf(period).flatMap((date): DayLine[] => {
    const day = byDate.get(date);
    const happened = day && (day.am.planned > 0 || day.pm.planned > 0 || day.am.unplanned > 0 || day.pm.unplanned > 0);
    if (!day || !happened) {
      return weekdayOfIsoDay(date) === FRIDAY ? [] : [{ date, lines: ["No plan and no visit"], muted: true }];
    }
    return [{ date, lines: [planDayLine("PM", day.pm), planDayLine("AM", day.am)] }];
  });
}

function PlanSection({
  idPrefix,
  resource,
  territories,
  today,
}: {
  idPrefix: string;
  resource: CrmResource<PlanReportView>;
  territories: ReadonlyArray<ReportTerritory>;
  today: string;
}) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Matching the plans with the visits" onRetry={resource.reload} />;

  const { AM: am, PM: pm } = report.totals;
  const changes = deltasBySeat(report.comparison);
  const oneDay = report.period.from === report.period.to;
  const keptStat = (cell: PlanCell, listType: "AM" | "PM", noneLabel: string) => (
    <CrmStat
      label={`Planned ${listType} visited`}
      note={
        <>
          {cell.planned > 0 ? `${percentText(cell.keptPct)} of the planned ${listType}, on their day` : noneLabel}
          {deltaFact(report.comparison?.totals[listType])}
        </>
      }
      value={cell.planned > 0 ? `${countText(cell.visitedPlanned)} of ${countText(cell.planned)}` : "—"}
    />
  );

  return (
    <>
      <RefreshFailed error={resource.error} />
      {report.runningDay ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Today is still running" tone="info">
            A customer planned for today counts as missed until the visit is saved.
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock>
        <CrmStatGrid>
          {keptStat(am, "AM", "No AM planned")}
          {keptStat(pm, "PM", "No PM planned")}
          <CrmStat label="Missed" note="Planned, and not visited on the day" value={amPmText(am.missed, pm.missed)} />
          <CrmStat label="Off the plan" note="Visited, and not planned for that day" value={amPmText(am.unplanned, pm.unplanned)} />
        </CrmStatGrid>
      </CrmBlock>
      <ReportList
        columns={oneDay ? ["34%", null, null] : ["30%", null, null, "15%"]}
        explain="Only a plan sent for review counts. A planned customer visited on another day counts as missed on the planned day, and as off the plan on the day of the visit."
        hasData={(line) => hasPlan(line.row)}
        headers={
          oneDay
            ? ["Territory and rep", "PM", "AM"]
            : [
                "Territory and rep",
                "PM",
                "AM",
                <span className="sr-only" key="days">
                  Days
                </span>,
              ]
        }
        idPrefix={`${idPrefix}-plan`}
        items={planLines(report, territories)}
        keyOf={(line) => line.key}
        renderCard={(line, open, onToggle) => (
          <CrmCard meta={repText(line.repName)} title={line.territoryName}>
            <CrmFacts
              facts={[
                { label: "PM", value: planFact(line.row?.pm ?? NO_PLAN) },
                { label: "AM", value: planFact(line.row?.am ?? NO_PLAN) },
              ]}
            />
            {!oneDay && line.row ? (
              <div className="mt-3">
                <DaysToggle onToggle={onToggle} open={open} />
              </div>
            ) : null}
            {!oneDay && open && line.row ? (
              <div className="mt-3">
                <DayList days={planDayLines(line.row, report.period)} today={today} />
              </div>
            ) : null}
          </CrmCard>
        )}
        renderCells={(line, open, onToggle) => (
          <>
            <td className={crmTdClassName}>
              <p className="font-black text-slate-950">{line.territoryName}</p>
              <p className="mt-0.5 text-xs text-slate-500">{repText(line.repName)}</p>
            </td>
            {planCell(line.row?.pm ?? NO_PLAN, changes.get(line.row?.seatId ?? "")?.pm)}
            {planCell(line.row?.am ?? NO_PLAN, changes.get(line.row?.seatId ?? "")?.am)}
            {oneDay ? null : <td className={crmTdClassName}>{line.row ? <DaysToggle onToggle={onToggle} open={open} /> : null}</td>}
          </>
        )}
        renderOpen={oneDay ? undefined : (line) => (line.row ? <DayList days={planDayLines(line.row, report.period)} today={today} /> : null)}
        searchWords={(line) => [line.territoryName, line.repName]}
        words={{ ...LIST_WORDS, title: "By territory", with: "With a plan", without: "No plan" }}
      />
    </>
  );
}

// ── Coverage and frequency ──────────────────────────────────────────────────────────────────────

/** "34 of 50 visited", or the sentence for a list with no validated customer. */
function coverageNote(cell: CoverageCell, customers: string): string {
  return cell.customers > 0 ? `${countText(cell.covered)} of ${countText(cell.customers)} ${customers} visited` : `No validated ${customers}`;
}

/** "20 of 40 on their grade · 15 under · 5 over", or the sentence for a list with no graded customer. */
function frequencyNote(cell: CoverageCell, customers: string): string {
  if (cell.withTarget === 0) return `No ${customers} with a monthly visit number`;
  return `${countText(cell.onTarget)} of ${countText(cell.withTarget)} on their grade · ${countText(cell.under)} under · ${countText(cell.over)} over`;
}

function coverageCellMarkup(percent: number | null, note: string, hasList: boolean, change?: Delta) {
  return (
    <td className={crmTdClassName}>
      <p className={hasList ? "font-black text-slate-950" : "text-slate-400"}>{percentText(percent)}</p>
      <p className="mt-0.5 text-xs text-slate-500">{note}</p>
      <DeltaLine value={change} />
    </td>
  );
}

function coverageFact(percent: number | null, note: string): ReactNode {
  return (
    <>
      <span className="block">{percentText(percent)}</span>
      <span className="block font-semibold text-slate-500">{note}</span>
    </>
  );
}

function CoverageSection({
  idPrefix,
  resource,
}: {
  idPrefix: string;
  resource: CrmResource<CoverageReportView>;
}) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Measuring the lists" onRetry={resource.reload} />;

  const { AM: am, PM: pm } = report.totals;
  const changes = deltasBySeat(report.comparison);
  const hasCustomers = (row: TerritoryCoverageRow) => row.am.customers > 0 || row.pm.customers > 0;

  return (
    <>
      <RefreshFailed error={resource.error} />
      {report.month.inProgress ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title={`${monthLabel(report.month.month)} is still running`} tone="info">
            A customer not visited yet can still be visited before the month ends.
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="AM coverage" note={<>{coverageNote(am, "AM")}{deltaFact(report.comparison?.totals.AM)}</>} value={percentText(am.coveragePct)} />
          <CrmStat label="PM coverage" note={<>{coverageNote(pm, "PM")}{deltaFact(report.comparison?.totals.PM)}</>} value={percentText(pm.coveragePct)} />
          <CrmStat label="AM frequency" note={frequencyNote(am, "AM")} value={percentText(am.frequencyPct)} />
          <CrmStat label="PM frequency" note={frequencyNote(pm, "PM")} value={percentText(pm.frequencyPct)} />
        </CrmStatGrid>
      </CrmBlock>
      <ReportList
        columns={["28%", null, null, null, null]}
        explain="Coverage is the share of the validated list visited at least once in the month. Frequency is the share of graded customers visited exactly their grade's number of times; under and over show beside it."
        hasData={hasCustomers}
        headers={["Territory and rep", "PM coverage", "AM coverage", "PM frequency", "AM frequency"]}
        idPrefix={`${idPrefix}-coverage`}
        items={report.rows}
        keyOf={(row) => row.seatId}
        renderCard={(row) => (
          <CrmCard meta={repText(row.repName)} title={row.territoryName}>
            <CrmFacts
              facts={[
                { label: "PM coverage", value: coverageFact(row.pm.coveragePct, coverageNote(row.pm, "PM")) },
                { label: "AM coverage", value: coverageFact(row.am.coveragePct, coverageNote(row.am, "AM")) },
                { label: "PM frequency", value: coverageFact(row.pm.frequencyPct, frequencyNote(row.pm, "PM")) },
                { label: "AM frequency", value: coverageFact(row.am.frequencyPct, frequencyNote(row.am, "AM")) },
              ]}
            />
          </CrmCard>
        )}
        renderCells={(row) => (
          <>
            <td className={crmTdClassName}>
              <p className="font-black text-slate-950">{row.territoryName}</p>
              <p className="mt-0.5 text-xs text-slate-500">{repText(row.repName)}</p>
            </td>
            {coverageCellMarkup(row.pm.coveragePct, coverageNote(row.pm, "PM"), row.pm.customers > 0, changes.get(row.seatId)?.pm)}
            {coverageCellMarkup(row.am.coveragePct, coverageNote(row.am, "AM"), row.am.customers > 0, changes.get(row.seatId)?.am)}
            {coverageCellMarkup(row.pm.frequencyPct, frequencyNote(row.pm, "PM"), row.pm.withTarget > 0)}
            {coverageCellMarkup(row.am.frequencyPct, frequencyNote(row.am, "AM"), row.am.withTarget > 0)}
          </>
        )}
        searchWords={(row) => [row.territoryName, row.repName]}
        words={{ ...LIST_WORDS, title: "By territory", with: "With customers", without: "No customers yet" }}
      />
    </>
  );
}

// ── Double and chain visits per manager ─────────────────────────────────────────────────────────

/** "3 double · 1 chain · 2 chain as senior manager"; null when the manager was on none. */
function managerKindsText(row: ManagerReportRow): string | null {
  const parts = [
    row.doubleVisits > 0 ? `${countText(row.doubleVisits)} double` : null,
    row.chainVisits > 0 ? `${countText(row.chainVisits)} chain` : null,
    row.seniorChainVisits > 0 ? `${countText(row.seniorChainVisits)} chain as senior manager` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "4 days with 3 reps", or "Did not go out". */
function wentOutText(row: ManagerReportRow): string {
  if (row.daysOut === 0) return "Did not go out";
  const days = plural(row.daysOut, "day", "days");
  return row.reps > 0 ? `${days} with ${plural(row.reps, "rep", "reps")}` : days;
}

function managerTitleText(row: ManagerReportRow): string {
  return row.lineName ? `${row.title} · ${row.lineName}` : row.title;
}

/** "Faisal · Pedia, with Mona Adel: 1 AM · 3 PM · 3 double". */
function managerEntryLine(entry: ManagerReportEntry): string {
  const kinds =
    entry.roleOnVisit === "senior"
      ? `${countText(entry.chainVisits)} chain as senior manager`
      : [entry.doubleVisits > 0 ? `${countText(entry.doubleVisits)} double` : null, entry.chainVisits > 0 ? `${countText(entry.chainVisits)} chain` : null]
          .filter((part): part is string => part !== null)
          .join(" · ");
  const withWhom = entry.repName ? `with ${entry.repName}` : "with no rep on the visit";
  return `${entry.territoryName}, ${withWhom}: ${amPmText(entry.amVisits, entry.pmVisits)}${kinds ? ` · ${kinds}` : ""}`;
}

/** The manager's days out, each with the territories and reps of that day. */
function managerDayLines(row: ManagerReportRow): DayLine[] {
  const byDate = new Map<string, string[]>();
  for (const entry of row.entries) {
    const lines = byDate.get(entry.date) ?? [];
    lines.push(managerEntryLine(entry));
    byDate.set(entry.date, lines);
  }
  return [...byDate].map(([date, lines]) => ({ date, lines }));
}

function ManagersSection({ idPrefix, resource, today }: { idPrefix: string; resource: CrmResource<ManagerReportView>; today: string }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Counting the managers' visits" onRetry={resource.reload} />;
  if (report.rows.length === 0) {
    return (
      <>
        <RefreshFailed error={resource.error} />
        <div className="border-t border-slate-100">
          <CrmEmpty message="The managers above the territories you chose show here." title="No managers to show" />
        </div>
      </>
    );
  }

  let doubleVisits = 0;
  let chainVisits = 0;
  let daysOut = 0;
  let wentOut = 0;
  for (const row of report.rows) {
    doubleVisits += row.doubleVisits;
    chainVisits += row.chainVisits;
    daysOut += row.daysOut;
    if (row.daysOut > 0) wentOut += 1;
  }

  return (
    <>
      <RefreshFailed error={resource.error} />
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Double visits" note="A manager out with a rep" value={countText(doubleVisits)} />
          <CrmStat label="Chain visits" note="A rep, their manager and a senior manager" value={countText(chainVisits)} />
          <CrmStat label="Managers who went out" note={periodText(report.period)} value={`${countText(wentOut)} of ${countText(report.rows.length)}`} />
          <CrmStat label="Manager days out" note="Each manager's days with a double or chain visit, added up" value={countText(daysOut)} />
        </CrmStatGrid>
      </CrmBlock>
      <ReportList
        columns={["28%", "20%", null, "15%"]}
        explain="A double visit is a manager out with a rep; a chain visit adds a senior manager. Each counts for every manager on it as soon as the rep saves it."
        hasData={(row) => row.daysOut > 0}
        headers={[
          "Manager",
          "Went out",
          "Visits with a rep",
          <span className="sr-only" key="days">
            Days
          </span>,
        ]}
        idPrefix={`${idPrefix}-managers`}
        items={report.rows}
        keyOf={(row) => row.hrId}
        renderCard={(row, open, onToggle) => (
          <CrmCard meta={managerTitleText(row)} title={row.name}>
            <CrmFacts
              facts={[
                { label: "Went out", value: wentOutText(row) },
                {
                  label: "Visits with a rep",
                  value: row.daysOut > 0 ? [amPmText(row.amVisits, row.pmVisits), managerKindsText(row)].filter(Boolean).join(" · ") : "—",
                },
              ]}
            />
            {row.entries.length > 0 ? (
              <div className="mt-3">
                <DaysToggle onToggle={onToggle} open={open} />
              </div>
            ) : null}
            {open && row.entries.length > 0 ? (
              <div className="mt-3">
                <DayList days={managerDayLines(row)} today={today} />
              </div>
            ) : null}
          </CrmCard>
        )}
        renderCells={(row, open, onToggle) => {
          const kinds = managerKindsText(row);
          return (
            <>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{row.name}</p>
                <p className="mt-0.5 text-xs text-slate-500">{managerTitleText(row)}</p>
              </td>
              <td className={cn(crmTdClassName, row.daysOut > 0 ? undefined : "text-slate-400")}>{wentOutText(row)}</td>
              <td className={crmTdClassName}>
                {row.daysOut > 0 ? (
                  <>
                    <p className="font-black text-slate-950">{amPmText(row.amVisits, row.pmVisits)}</p>
                    {kinds ? <p className="mt-0.5 text-xs text-slate-500">{kinds}</p> : null}
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
              <td className={crmTdClassName}>{row.entries.length > 0 ? <DaysToggle onToggle={onToggle} open={open} /> : null}</td>
            </>
          );
        }}
        renderOpen={(row) => <DayList days={managerDayLines(row)} today={today} />}
        searchWords={(row) => [row.name, row.title, row.lineName]}
        words={{
          all: "All",
          noneMatch: "Nothing matches",
          searchLabel: "Find a manager",
          searchPlaceholder: "Name, title or line",
          title: "By manager",
          with: "Went out",
          without: "Did not go out",
        }}
      />
    </>
  );
}

/**
 * WHERE THE VISIT WAS SAVED — the rep's own position against the place Phoenix holds for that customer.
 *
 * Owner, 2026-09-26: this one is for the district manager, SFE, the national sales manager and the
 * Super Admin, and NOT for the medical rep. The server refuses it to a rep (loadVisitLocationReport)
 * and `canSeeLocations` keeps the chip off his screen — two gates, because the chip alone is UX.
 *
 * It is not the mock-location board: that one is Super-Admin-only and stays silent by his rule. This
 * says how far apart two saved points are, which the rep already sees on his own visit.
 */
function LocationsSection({
  idPrefix,
  resource,
}: {
  idPrefix: string;
  resource: CrmResource<VisitLocationReportView>;
}) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Loading where the visits were saved" onRetry={resource.reload} />;
  const { summary } = report;

  return (
    <>
      <RefreshFailed error={resource.error} />
      <CrmBlock className="border-t border-slate-100" title="These days">
        <CrmStatGrid>
          <CrmStat label="Visits" note="Every visit saved in the days chosen" value={countText(summary.visits)} />
          <CrmStat
            label="Far from the place"
            note="Saved beyond the distance set in Settings"
            tone={summary.far > 0 ? "warn" : "good"}
            value={countText(summary.far)}
          />
          <CrmStat
            label="Weak signal"
            note="The phone was not sure where it was"
            tone={summary.weakGps > 0 ? "warn" : "neutral"}
            value={countText(summary.weakGps)}
          />
          <CrmStat
            label="Nothing to compare"
            note="The customer has no validated place yet"
            tone={summary.noPlace > 0 ? "neutral" : "good"}
            value={countText(summary.noPlace)}
          />
        </CrmStatGrid>
      </CrmBlock>
      {report.total > report.rows.length ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote tone="info">
            The {countText(report.rows.length)} farthest of {countText(report.total)} visits. Narrow the days or the territory to read the rest.
          </CrmNote>
        </CrmBlock>
      ) : null}
      {report.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="No visit was saved in the days chosen." title="No visits to compare" />
        </div>
      ) : (
        <ReportList
          columns={["18%", "18%", "24%", "26%", "14%"]}
          explain="The farthest first. Distance is between where the rep stood when he saved the visit and the place saved for that customer, which is fixed at capture and never edited."
          hasData={(row) => row.locationFlag === "far" || row.locationFlag === "weak_gps"}
          headers={["Day", "Rep", "Customer", "Place saved", "Apart"]}
          idPrefix={`${idPrefix}-locations`}
          items={report.rows}
          keyOf={(row) => row.visitId}
          renderCard={(row) => (
            <CrmCard
              accent={row.locationFlag === "far" ? "border-l-amber-500" : "border-l-orange-500"}
              meta={[dayLabel(row.visitDate), row.territoryName, row.repName].join(" · ")}
              status={
                <>
                  <CrmPill tone={row.locationFlag === "far" ? "warn" : row.locationFlag === "ok" ? "good" : "neutral"}>{row.distanceText}</CrmPill>
                  {row.isUnplanned ? <CrmPill tone="orange">Off the plan</CrmPill> : null}
                </>
              }
              title={row.customerName}
            >
              <div className="grid min-w-0 gap-1 text-xs font-semibold leading-5 text-slate-600">
                <p className="break-words">
                  <span className="font-black text-slate-800">Place saved: </span>
                  {row.placeLabel ?? row.placeAddress ?? "No place saved yet"}
                </p>
                {row.placeWhere ? <p className="break-words">{row.placeWhere}</p> : null}
                <p className="break-words">
                  <span className="font-black text-slate-800">He stood at: </span>
                  {row.visitLat.toFixed(5)}, {row.visitLon.toFixed(5)}
                  {row.accuracyMeters === null ? "" : ` (accuracy ${countText(Math.round(row.accuracyMeters))} m)`}
                </p>
                {row.placeLat !== null && row.placeLon !== null ? (
                  <p className="break-words">
                    <span className="font-black text-slate-800">The place is at: </span>
                    {row.placeLat.toFixed(5)}, {row.placeLon.toFixed(5)}
                  </p>
                ) : null}
              </div>
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{dayLabel(row.visitDate)}</p>
                <p className="mt-0.5 break-words text-xs text-slate-500">{row.territoryName}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.repName}</p>
                {row.isUnplanned ? <p className="mt-0.5 break-words text-xs font-semibold text-orange-700">Off the plan</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.customerName}</p>
                <p className="mt-0.5 break-words text-xs text-slate-500">
                  {row.visitLat.toFixed(5)}, {row.visitLon.toFixed(5)}
                </p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.placeLabel ?? row.placeAddress ?? "No place saved yet"}</p>
                {row.placeWhere ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.placeWhere}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <span className={cn("block break-words font-black", row.locationFlag === "far" ? "text-amber-800" : "text-slate-900")}>
                  {row.distanceText}
                </span>
              </td>
            </>
          )}
          searchWords={(row) => [row.customerName, row.repName, row.territoryName, row.placeLabel, row.placeAddress, row.placeWhere]}
          words={{
            all: "All",
            noneMatch: "Nothing matches",
            searchLabel: "Find a visit",
            searchPlaceholder: "Customer, rep, territory or place",
            title: "Farthest first",
            with: "Away from it",
            without: "At the place",
          }}
        />
      )}
    </>
  );
}

/**
 * The exceptions board.
 *
 * 🔴 A territory with nothing wrong is ABSENT. There is no green row anywhere in here, and the empty
 * state is the GOOD one — a manager whose whole district is fine sees a short sentence saying so, not
 * sixty-eight ticks. That absence is the entire feature; a board that listed every seat and coloured
 * eight of them would be the Team tab again, and he would still be reading sixty-eight rows.
 *
 * Nothing on it acts. Every row names what to do in words, and the doing happens on the Team tab or
 * in the rep's own plan, which is also why it carries no buttons: a board that can approve is a board
 * people click through without reading.
 */
function ExceptionsSection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<ExceptionsView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Looking for anything that needs you" onRetry={resource.reload} />;
  const { summary } = report;

  return (
    <>
      <RefreshFailed error={resource.error} />
      <CrmBlock className="border-t border-slate-100" title="Right now">
        <CrmStatGrid>
          <CrmStat label="Territories" note="Everything in your scope" value={countText(summary.territories)} />
          <CrmStat
            label="Need you"
            note="One line each, worst first"
            tone={summary.needingAttention > 0 ? "warn" : "good"}
            value={countText(summary.needingAttention)}
          />
        </CrmStatGrid>
        {summary.byKind.length > 0 ? (
          <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
            {summary.byKind.map((entry) => (
              <CrmPill key={entry.kind} tone="warn">{`${entry.label} · ${countText(entry.count)}`}</CrmPill>
            ))}
          </div>
        ) : null}
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          {`The last full field day is ${dayLabel(report.lastFieldDay)}, and the call rate reads the ${countText(report.windowFieldDays)} field days up to it. This week's plan means the week of ${dayLabel(report.weekStart)}.`}
        </p>
      </CrmBlock>
      {report.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty
            message="Every territory in your scope has a rep, a sent plan, a visit on the last field day and a call rate on target."
            title="Nothing needs you"
          />
        </div>
      ) : (
        <ReportList
          columns={["28%", "22%", "26%", "24%"]}
          explain="Worst first. One line per territory — the worst true thing about it — so a vacant seat is not also listed as having no plan, because there is nobody to have made one."
          hasData={() => true}
          headers={["Territory", "Rep", "What", "Where it stands"]}
          idPrefix={`${idPrefix}-exceptions`}
          items={report.rows}
          keyOf={(row) => row.seatId}
          renderCard={(row) => (
            <CrmCard
              accent="border-l-amber-500"
              meta={[row.lineName, row.repName ?? "No rep"].filter(Boolean).join(" · ")}
              status={<CrmPill tone="warn">{row.label}</CrmPill>}
              title={row.territoryName}
            >
              <div className="grid min-w-0 gap-1 text-xs font-semibold leading-5 text-slate-600">
                <p className="break-words">{row.why}</p>
                {row.detail ? <p className="break-words font-black text-slate-800">{row.detail}</p> : null}
              </div>
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.territoryName}</p>
                {row.lineName ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.lineName}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.repName ?? "No rep"}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-amber-800">{row.label}</p>
                <p className="mt-0.5 break-words text-xs text-slate-500">{row.why}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.detail ?? "—"}</p>
              </td>
            </>
          )}
          searchWords={(row) => [row.territoryName, row.repName, row.lineName, row.label]}
          words={{
            all: "All",
            noneMatch: "Nothing matches",
            searchLabel: "Find a territory",
            searchPlaceholder: "Territory, rep or line",
            title: "Worst first",
            with: "All",
            without: "None",
          }}
        />
      )}
    </>
  );
}

const BRICK_STATUS: Record<BrickCoverageStatus, { label: string; tone: PillTone; accent: string }> = {
  "sales-no-list": { label: "Sells here, nobody on the list", tone: "bad", accent: "border-l-rose-500" },
  "list-no-sales": { label: "On the list, no sales booked", tone: "warn", accent: "border-l-amber-500" },
  covered: { label: "Covered", tone: "good", accent: "border-l-emerald-500" },
  idle: { label: "Neither", tone: "neutral", accent: "border-l-slate-300" },
};

/**
 * Coverage against what the closing booked ON each brick (C2).
 *
 * 🔴 **The caveat is printed, always, and it comes from the server.** Brick sales never add up to the
 * area's closing figure — a wholesaler's sales spread over its city's areas, El Qema's warehouse stock
 * spread over the country, the Office allocation and direct orders are all credited to the area
 * without belonging to any one brick. The sentence is `report.caveat`, one fixed constant, precisely
 * so this screen cannot soften it and a second screen cannot word it differently.
 *
 * AM and PM are two columns and never one. Rows are ordered by what needs a manager first: a brick the
 * line sells into with nobody on the rep's list, then one on the list with nothing booked.
 */
function BricksSection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<BrickCoverageView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Reading coverage against sales" onRetry={resource.reload} />;
  const { summary } = report;

  return (
    <>
      <RefreshFailed error={resource.error} />
      <CrmBlock className="border-t border-slate-100" title="Across the bricks you reach">
        <CrmStatGrid>
          <CrmStat label="Bricks" note="On either side" value={countText(summary.bricks)} />
          <CrmStat
            label="Sells here, nobody on the list"
            note="The row to act on"
            tone={summary.salesNoList > 0 ? "warn" : "good"}
            value={countText(summary.salesNoList)}
          />
          <CrmStat label="On the list, no sales" note="New ground, or lost" value={countText(summary.listNoSales)} />
          <CrmStat label="Covered" note="Sells and is called on" value={countText(summary.covered)} />
        </CrmStatGrid>
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          {report.salesMonths.length === 0
            ? "No distributor file has landed for these months yet, so no brick shows sales. Files arrive across the first two weeks."
            : `Sales are the months whose distributor files have landed: ${report.salesMonths.join(", ")}.`}
        </p>
        <CrmNote className="mt-3" tone="warn">
          {report.caveat}
        </CrmNote>
      </CrmBlock>
      {report.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty
            message="A brick shows here once a place is captured in it, or the closing books sales to it."
            title="No bricks to compare yet"
          />
        </div>
      ) : (
        <ReportList
          columns={["26%", "20%", "18%", "18%", "18%"]}
          explain="Worst first: a brick the line sells into with nobody on the list, then a brick on the list with nothing booked. AM and PM are counted apart, and a brick's sales are never the area's figure."
          hasData={(row) => row.customers > 0 || row.sales > 0}
          headers={["Brick", "Territory", "AM", "PM", "Booked on it"]}
          idPrefix={`${idPrefix}-bricks`}
          items={report.rows}
          keyOf={(row) => `${row.seatId}|${row.brickId ?? "none"}`}
          renderCard={(row) => (
            <CrmCard
              accent={BRICK_STATUS[row.status].accent}
              meta={[row.territoryName, row.areaName].filter(Boolean).join(" · ")}
              status={<CrmPill tone={BRICK_STATUS[row.status].tone}>{BRICK_STATUS[row.status].label}</CrmPill>}
              title={row.brickName}
            >
              <div className="grid min-w-0 gap-1 text-xs font-semibold leading-5 text-slate-600">
                <p className="break-words">
                  {`${countText(row.amVisited)} of ${countText(row.am)} AM · ${countText(row.pmVisited)} of ${countText(row.pm)} PM called on`}
                </p>
                <p className="break-words font-black text-slate-800">
                  {`${countText(row.visits)} visits · ${countText(row.sales)} booked on this brick`}
                </p>
              </div>
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.brickName}</p>
                <p className="mt-0.5 break-words text-xs text-slate-500">{BRICK_STATUS[row.status].label}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.territoryName}</p>
                {row.areaName ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.areaName}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{`${countText(row.amVisited)} of ${countText(row.am)}`}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{`${countText(row.pmVisited)} of ${countText(row.pm)}`}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{countText(row.sales)}</p>
              </td>
            </>
          )}
          searchWords={(row) => [row.brickName, row.territoryName, row.areaName]}
          words={{
            all: "All",
            noneMatch: "No brick matches",
            searchLabel: "Find a brick",
            searchPlaceholder: "Brick, territory or area",
            title: "Worst first",
            with: "Has a list or sales",
            without: "Neither",
          }}
        />
      )}
    </>
  );
}

const ADOPTION_TONE: Record<AdoptionStage, { tone: PillTone; accent: string }> = {
  not_open: { tone: "neutral", accent: "border-l-slate-300" },
  never_touched: { tone: "bad", accent: "border-l-rose-500" },
  started: { tone: "warn", accent: "border-l-amber-500" },
  ready: { tone: "warn", accent: "border-l-amber-500" },
  working: { tone: "good", accent: "border-l-emerald-500" },
};

/**
 * How far the rollout has got (F3).
 *
 * 🔴 **Unlike the exceptions board, nothing is dropped here.** That one answers "what needs you
 * today" and a clean seat is noise; this answers "how far has the rollout got", and a question about
 * coverage cannot be answered by a list that leaves out the territories doing fine. A `working` row
 * is the good news and belongs on the page.
 *
 * It also lists territories whose line has NOT opened, which `scopeTerritories` alone would drop —
 * a rollout that looks complete because the unopened half is invisible is the failure this avoids.
 */
function AdoptionSection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<AdoptionView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Reading how far the rollout has got" onRetry={resource.reload} />;
  const { summary } = report;

  return (
    <>
      <RefreshFailed error={resource.error} />
      <CrmBlock className="border-t border-slate-100" title="How far the rollout has got">
        <CrmStatGrid>
          <CrmStat label="Territories" note="Everything in your scope" value={countText(summary.territories)} />
          <CrmStat label="On an open line" note="The only ones that can adopt" value={countText(summary.open)} />
          <CrmStat
            label="Never opened it"
            note={`Past ${countText(report.graceDays)} days: ${countText(summary.overdue)}`}
            tone={summary.overdue > 0 ? "warn" : summary.neverTouched > 0 ? "neutral" : "good"}
            value={countText(summary.neverTouched)}
          />
          <CrmStat label="Working" note="Visits are being entered" tone="good" value={countText(summary.working)} />
        </CrmStatGrid>
        {summary.byStage.length > 0 ? (
          <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
            {summary.byStage.map((entry) => (
              <CrmPill key={entry.stage} tone={ADOPTION_TONE[entry.stage].tone}>{`${entry.label} · ${countText(entry.count)}`}</CrmPill>
            ))}
          </div>
        ) : null}
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          {`A territory counts as never opened until something is entered — a validation, a drop, or a visit. A line gets ${countText(report.graceDays)} days before that is called overdue, because a rollout lands on a line and not on a person.`}
        </p>
      </CrmBlock>
      {report.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="A territory shows here once it exists in the seat model." title="No territories in your scope" />
        </div>
      ) : (
        <ReportList
          columns={["26%", "20%", "24%", "16%", "14%"]}
          explain="Worst first, then the longest-open. A territory on a line that has not opened is listed too — it is the other half of the same question, and leaving it out would make a rollout look finished."
          hasData={(row) => row.stage !== "not_open"}
          headers={["Territory", "Rep", "Where it has got to", "Days open", "First visit"]}
          idPrefix={`${idPrefix}-adoption`}
          items={report.rows}
          keyOf={(row) => row.seatId}
          renderCard={(row) => (
            <CrmCard
              accent={ADOPTION_TONE[row.stage].accent}
              meta={[row.lineName, row.repName ?? "No rep in this territory"].filter(Boolean).join(" · ")}
              status={<CrmPill tone={ADOPTION_TONE[row.stage].tone}>{row.label}</CrmPill>}
              title={row.territoryName}
            >
              <div className="grid min-w-0 gap-1 text-xs font-semibold leading-5 text-slate-600">
                <p className="break-words">{row.why}</p>
                {row.detail ? <p className="break-words font-black text-slate-800">{row.detail}</p> : null}
                {row.overdue ? <p className="break-words font-black text-rose-700">Past the grace</p> : null}
              </div>
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.territoryName}</p>
                {row.lineName ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.lineName}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.repName ?? "No rep"}</p>
              </td>
              <td className={crmTdClassName}>
                <p className={cn("break-words font-black", row.overdue ? "text-rose-700" : "text-slate-800")}>{row.label}</p>
                {row.detail ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.detail}</p> : null}
              </td>
              <td className={crmTdClassName}>
                {/* 🔴 Null is "we do not know when this opened", never 0 — the two must not read alike. */}
                <p className="break-words">{row.daysOpen === null ? "—" : plural(row.daysOpen, "day", "days")}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words">{row.firstVisitOn ? dayLabel(row.firstVisitOn) : "None yet"}</p>
              </td>
            </>
          )}
          searchWords={(row) => [row.territoryName, row.repName, row.lineName, row.label]}
          words={{
            all: "All",
            noneMatch: "No territory matches",
            searchLabel: "Find a territory",
            searchPlaceholder: "Territory, rep or line",
            title: "Worst first",
            with: "On an open line",
            without: "Line not open",
          }}
        />
      )}
    </>
  );
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

const SECTION_TITLES: Record<ReportSection, string> = {
  exceptions: "Needs you today",
  visits: "Visits per day",
  plan: "Plan against actual",
  daily: "Daily plan",
  coverage: "Coverage and frequency",
  bricks: "Coverage against sales",
  adoption: "Who has started",
  managers: "Double and chain visits",
  locations: "Where the visit was saved",
};

/** The three sections a comparison means anything for. The others are lists, not measures. */
const COMPARABLE_SECTIONS: ReadonlyArray<ReportSection> = ["visits", "plan", "coverage"];

/** Sections that read neither a period nor a month — they are about right now. */
const TIMELESS_SECTIONS: ReadonlyArray<ReportSection> = ["exceptions", "adoption"];

const COMPARE_OPTIONS: ReadonlyArray<CrmChoiceOption<ComparisonMode>> = [
  { value: "off", label: "Nothing", note: "The figures alone" },
  { value: "previous", label: "The period before", note: "Same number of days" },
  { value: "peers", label: "Your other territories", note: "An average, never a ranking" },
];

const REPORTS_DESCRIPTION = "Counted from what the field force enters in Phoenix CRM. AM and PM are always counted apart.";

/** "Tue 1 Sept – Thu 17 Sept", for a quick pick's note. */
function shortPeriodText(period: Period): string {
  return period.from === period.to ? dayLabel(period.from) : `${dayLabel(period.from)} – ${dayLabel(period.to)}`;
}

export function ReportsTab({ cairoToday, test }: { cairoToday: string; test: boolean }) {
  const idPrefix = useId();
  const scope = useCrmGet<ReportScopeView>(crmUrl(REPORTS_PATH, { section: "scope" }), "report");
  const [section, setSection] = useState<ReportSection>("visits");
  const [lineCode, setLineCode] = useState("");
  const [seatId, setSeatId] = useState("");
  const [preset, setPreset] = useState<PeriodPreset | null>("this_month");
  const [period, setPeriod] = useState<Period>(() => presetPeriod("this_month", cairoToday));
  const [month, setMonth] = useState(() => cairoToday.slice(0, 7));
  const [includeTest, setIncludeTest] = useState(test);
  // Phones only: the filters fold to a one-line summary, so the figures are not a screen further down.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [compare, setCompare] = useState<ComparisonMode>("off");
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const view = scope.data;
  const today = view?.cairoToday ?? cairoToday;
  // The daily plan keeps its own days: they reach FORWARD, which the shared period refuses.
  const dailyDays = useDailyPlanDays(today);
  const territories = view?.territories ?? [];
  const lineTerritories = lineCode ? territories.filter((territory) => territory.lineCode === lineCode) : territories;
  const chosen = seatId ? lineTerritories.filter((territory) => territory.seatId === seatId) : lineTerritories;
  const activeSection: ReportSection =
    (section === "managers" && view && !view.hasManagers) ||
    ((section === "locations" || section === "exceptions" || section === "bricks" || section === "adoption") && view && !view.canSeeLocations)
      ? "visits"
      : section;
  const withTest = Boolean(view?.canIncludeTest) && includeTest;
  // Checked whichever section is open: the export carries the daily plan's days too, and must never
  // send a range the server would refuse and so fail the whole workbook over one sheet.
  const dailyPeriodProblem = dailyPlanPeriodProblem(dailyDays.period, today);
  const dailyProblem = activeSection === "daily" ? dailyPeriodProblem : null;
  // A plan is ONE rep's: with several territories in reach and none chosen there is nothing to read.
  const dailyNeedsTerritory = !seatId && lineTerritories.length > 1;
  // Neither of these two reads a period: coverage asks for a month, and the exceptions board is about
  // today and resolves its own days on the server. A period error must not blank either of them.
  const readsPeriod = activeSection !== "coverage" && !TIMELESS_SECTIONS.includes(activeSection);
  const problem = readsPeriod ? periodProblem(period, today, view?.maxDays ?? REPORT_MAX_DAYS) : null;

  function sectionUrl(name: ReportSection): string | null {
    if (!view || name !== activeSection) return null;
    //  is left OUT of the URL rather than sent: the server reads a missing value as off, and a
    // URL that carries every default is a URL nobody can read.
    const comparing = COMPARABLE_SECTIONS.includes(name) && compare !== "off" ? compare : null;
    const filters = { section: name, lineCode: lineCode || null, seatId: seatId || null, includeTest: withTest, compare: comparing };
    if (name === "daily") {
      return dailyProblem || dailyNeedsTerritory ? null : crmUrl(REPORTS_PATH, { ...filters, from: dailyDays.period.from, to: dailyDays.period.to });
    }
    // The board is about the viewer's whole scope today; a line or territory filter would turn "what
    // needs you" into "what needs you here", which is the Team tab's question and not this one.
    // Neither is filtered by line or territory: both are about the viewer's WHOLE reach, and a
    // filter would turn "how far has the rollout got" into "how far has it got here".
    if (name === "exceptions" || name === "adoption") return crmUrl(REPORTS_PATH, { section: name, includeTest: withTest });
    if (name === "coverage") return crmUrl(REPORTS_PATH, { ...filters, month });
    return problem ? null : crmUrl(REPORTS_PATH, { ...filters, from: period.from, to: period.to });
  }

  // What the second line on each cell is measured against, said once above the figures rather than
  // repeated on every one of them.
  const comparisonHint =
    compare === "previous"
      ? "Each figure gains a line against the same number of days immediately before this period."
      : compare === "peers"
        ? "Each figure gains a line against the average territory in your whole scope over the same days. An average, never a ranking — no names and no order."
        : "The figures on their own.";

  const visits = useCrmGet<VisitsReportView>(sectionUrl("visits"), "report");
  const plan = useCrmGet<PlanReportView>(sectionUrl("plan"), "report");
  const daily = useCrmGet<DailyPlanReportView>(sectionUrl("daily"), "report");
  const coverage = useCrmGet<CoverageReportView>(sectionUrl("coverage"), "report");
  const managers = useCrmGet<ManagerReportView>(sectionUrl("managers"), "report");
  const locations = useCrmGet<VisitLocationReportView>(sectionUrl("locations"), "report");
  const exceptions = useCrmGet<ExceptionsView>(sectionUrl("exceptions"), "report");
  const bricks = useCrmGet<BrickCoverageView>(sectionUrl("bricks"), "report");
  const adoption = useCrmGet<AdoptionView>(sectionUrl("adoption"), "report");
  const active = { adoption, bricks, coverage, daily, exceptions, locations, managers, plan, visits }[activeSection];

  if (!view) {
    return (
      <CrmPanel description={REPORTS_DESCRIPTION} eyebrow="Reports" title="Reports">
        {scope.error ? <CrmLoadError message={scope.error} onRetry={scope.reload} /> : <CrmLoading label="Loading the reports" />}
      </CrmPanel>
    );
  }

  if (territories.length === 0) {
    return (
      <CrmPanel description={REPORTS_DESCRIPTION} eyebrow="Reports" title="Reports">
        <CrmEmpty message="A territory shows here once its line opens in Phoenix CRM." title="No territories to show" />
      </CrmPanel>
    );
  }

  function chooseLine(next: string) {
    setLineCode(next);
    if (seatId && next && !territories.some((territory) => territory.seatId === seatId && territory.lineCode === next)) setSeatId("");
  }

  function choosePreset(next: PeriodPreset) {
    setPreset(next);
    setPeriod(presetPeriod(next, today));
  }

  function chooseDays(next: Period) {
    setPreset(null);
    setPeriod(next);
  }

  function refresh() {
    scope.reload();
    active.reload();
  }

  /**
   * The whole pack, in one file. The URL carries the SAME filters the screen is showing, so what he
   * saves is what he was looking at — a workbook built from different filters than the ones on screen
   * is the kind of mismatch nobody notices until a number is quoted in a meeting.
   *
   * A failure is shown ON the button rather than swallowed: half a workbook delivered quietly is
   * worse than one the reader knows to take again.
   */
  async function exportPack() {
    if (exporting || problem) return;
    setExporting(true);
    setExportFailed(false);
    try {
      await downloadXlsxFrom(
        crmUrl(`${REPORTS_PATH}/export`, {
          // The daily plan's own days, so its sheet holds what that section shows — and no sheet at all
          // when those days cannot be read, rather than a whole workbook refused over one of them.
          dailyFrom: dailyPeriodProblem ? null : dailyDays.period.from,
          dailyTo: dailyPeriodProblem ? null : dailyDays.period.to,
          from: period.from,
          includeTest: withTest,
          lineCode: lineCode || null,
          month,
          seatId: seatId || null,
          to: period.to,
        }),
        `phoenix-crm-reports-${period.from}-to-${period.to}.xlsx`,
      );
    } catch (error) {
      console.error("Phoenix CRM reports export failed:", error);
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  }

  const sectionOptions: Array<CrmChoiceOption<ReportSection>> = [
    // First, because it is the one a manager opens the tab FOR. Same gate as the place-vs-actual
    // report — one predicate, `readsTeamReports`, so the two can never disagree about who is a
    // manager — and the server refuses it too, since a hidden chip is UX and never the boundary.
    ...(view.canSeeLocations ? [{ value: "exceptions" as const, label: SECTION_TITLES.exceptions, note: "Only what is wrong" }] : []),
    { value: "visits", label: SECTION_TITLES.visits, note: "AM and PM apart" },
    { value: "plan", label: SECTION_TITLES.plan, note: "Visited or missed, day by day" },
    // Every reader of the tab: a rep reads his own plan here, and a manager a rep's in his scope.
    { value: "daily", label: SECTION_TITLES.daily, note: "Each day's customers" },
    { value: "coverage", label: SECTION_TITLES.coverage, note: "The list, month by month" },
    // Same gate again: a board comparing bricks ACROSS a team is the manager's (owner, 2026-09-26).
    ...(view.canSeeLocations ? [{ value: "bricks" as const, label: SECTION_TITLES.bricks, note: "Per brick, with the caveat" }] : []),
    // A board naming who has never opened the module must not reach the field (F3) — same gate.
    ...(view.canSeeLocations ? [{ value: "adoption" as const, label: SECTION_TITLES.adoption, note: "How far the rollout got" }] : []),
    ...(view.hasManagers ? [{ value: "managers" as const, label: SECTION_TITLES.managers, note: "Per manager" }] : []),
    // Managers, SFE and the Super Admin only — and the server refuses it too, so the chip is not the
    // gate (system-navigation hiding a link is UX; the boundary is server side).
    ...(view.canSeeLocations ? [{ value: "locations" as const, label: SECTION_TITLES.locations, note: "Against the saved place" }] : []),
  ];
  const presetOptions: Array<CrmChoiceOption<PeriodPreset>> = PRESETS.map(({ label, value }) => {
    const range = presetPeriod(value, today);
    const beforeOpening = range.to < FIRST_REPORT_DAY;
    return { value, label, note: beforeOpening ? "Before Phoenix CRM opened" : shortPeriodText(range), disabled: beforeOpening };
  });
  const currentMonth = today.slice(0, 7);

  // The folded filters, in one line: "This month · Tue 1 Sept – Fri 25 Sept 2026 · Pedia · Faisal".
  // Days that cannot be read keep the filters open, since the fix is inside them.
  const filtersId = `${idPrefix}-filters`;
  const showFilters = filtersOpen || Boolean(problem) || Boolean(dailyProblem);
  const presetLabel = preset ? (PRESETS.find((option) => option.value === preset)?.label ?? null) : null;
  const chosenLine = lineCode ? (view.lines.find((line) => line.lineCode === lineCode)?.lineName ?? null) : null;
  const chosenTerritory = seatId ? (lineTerritories.find((territory) => territory.seatId === seatId)?.name ?? null) : null;
  const dailySummary = [dailyPlanDaysSummary(dailyDays), chosenLine, chosenTerritory].filter((part): part is string => Boolean(part)).join(" · ");
  const filterSummary = [
    activeSection === "coverage" ? monthLabel(month) : presetLabel,
    activeSection === "coverage" ? null : periodText(period),
    chosenLine,
    chosenTerritory,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <CrmPanel
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/*
            C1: one workbook holding every section this viewer may read. The sections he may not are
            never loaded and write no sheet, so the file has the same shape as his screen — it can
            never be a way round a refusal, and never an empty tab announcing a report exists.
          */}
          <CrmButton busy={exporting} disabled={Boolean(problem)} onClick={() => void exportPack()} size="sm">
            {exportFailed ? "Export failed — press to retry" : "Export all sections"}
          </CrmButton>
          <CrmButton busy={scope.loading || active.loading} disabled={Boolean(problem || dailyProblem)} onClick={refresh} size="sm">
            Refresh
          </CrmButton>
        </div>
      }
      description={REPORTS_DESCRIPTION}
      eyebrow={withTest ? "Reports · your test entries included" : "Reports"}
      title={SECTION_TITLES[activeSection]}
    >
      <CrmBlock title="Report">
        {/* Two a row on a phone whatever the count — six labels at three across would wrap "Coverage
            and frequency" onto three lines and push the filters below the fold. */}
        <CrmChoice columns={sectionOptions.length >= 5 ? 2 : sectionOptions.length === 4 ? 4 : 3} label="Report" onChange={setSection} options={sectionOptions} value={activeSection} />
      </CrmBlock>

      <CrmBlock
        actions={
          problem || dailyProblem ? null : (
            <CrmButton aria-controls={filtersId} aria-expanded={showFilters} className="md:hidden" onClick={() => setFiltersOpen((open) => !open)} size="sm">
              {showFilters ? "Done" : "Change"}
            </CrmButton>
          )
        }
        className="border-t border-slate-100"
        title="Filters"
      >
        {showFilters ? null : (
          <p className="break-words text-sm font-semibold leading-6 text-slate-700 md:hidden">{activeSection === "daily" ? dailySummary : filterSummary}</p>
        )}
        <div className={cn("min-w-0 gap-3", showFilters ? "grid" : "hidden md:grid")} id={filtersId}>
          {activeSection === "daily" ? (
            <DailyPlanDaysFilter days={dailyDays} firstDay={FIRST_REPORT_DAY} idPrefix={idPrefix} today={today} />
          ) : activeSection === "exceptions" ? (
            <p className="break-words text-sm font-semibold leading-6 text-slate-700">
              This board reads your whole scope, as it stands today. It takes no days and no territory.
            </p>
          ) : activeSection === "coverage" ? (
            <CrmField className="md:max-w-md" htmlFor={`${idPrefix}-month`} label="Month">
              <CrmSelect id={`${idPrefix}-month`} onChange={(event) => setMonth(event.target.value)} value={month}>
                {offeredMonths(today).map((key) => (
                  <option key={key} value={key}>
                    {key === currentMonth ? `${monthLabel(key)} · this month` : monthLabel(key)}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>
          ) : (
            <>
              <CrmField label="Days">
                <CrmChoice columns={3} label="Days" onChange={choosePreset} options={presetOptions} value={preset} />
              </CrmField>
              <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">
                <CrmField htmlFor={`${idPrefix}-from`} label="From">
                  <input
                    className={cn(crmInputClassName, "appearance-none")}
                    id={`${idPrefix}-from`}
                    max={today}
                    min={FIRST_REPORT_DAY}
                    onChange={(event) => chooseDays({ from: event.target.value, to: period.to })}
                    type="date"
                    value={period.from}
                  />
                </CrmField>
                <CrmField htmlFor={`${idPrefix}-to`} label="To">
                  <input
                    className={cn(crmInputClassName, "appearance-none")}
                    id={`${idPrefix}-to`}
                    max={today}
                    min={FIRST_REPORT_DAY}
                    onChange={(event) => chooseDays({ from: period.from, to: event.target.value })}
                    type="date"
                    value={period.to}
                  />
                </CrmField>
              </div>
              <p className={cn("break-words text-xs font-semibold leading-5", problem ? "text-rose-700" : "text-slate-500")}>
                {problem ?? `Up to ${countText(view.maxDays)} days at a time.`}
              </p>
            </>
          )}

          {/*
            C3. Manager-only — the service refuses it to a rep as well, so hiding the control is UX
            and never the boundary. It sits with the period filters because that is what it changes
            the meaning of: the same figures, read against something.
          */}
          {view.canSeeLocations && COMPARABLE_SECTIONS.includes(activeSection) ? (
            <CrmField hint={comparisonHint} label="Compare with">
              <CrmChoice columns={3} label="Compare with" onChange={setCompare} options={COMPARE_OPTIONS} value={compare} />
            </CrmField>
          ) : null}

          {view.lines.length > 1 || lineTerritories.length > 1 ? (
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              {view.lines.length > 1 ? (
                <CrmField htmlFor={`${idPrefix}-line`} label="Line">
                  <CrmSelect id={`${idPrefix}-line`} onChange={(event) => chooseLine(event.target.value)} value={lineCode}>
                    <option value="">Every line</option>
                    {view.lines.map((line) => (
                      <option key={line.lineCode} value={line.lineCode}>
                        {line.lineName}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
              {lineTerritories.length > 1 ? (
                <CrmField htmlFor={`${idPrefix}-territory`} label="Territory">
                  <CrmSelect id={`${idPrefix}-territory`} onChange={(event) => setSeatId(event.target.value)} value={seatId}>
                    <option value="">{activeSection === "daily" ? "Choose a territory" : `Every territory · ${countText(lineTerritories.length)}`}</option>
                    {lineTerritories.map((territory) => (
                      <option key={territory.seatId} value={territory.seatId}>
                        {`${territory.name} · ${repText(territory.repName)}`}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
            </div>
          ) : null}

          {view.canIncludeTest ? (
            <CrmCheck checked={includeTest} onChange={setIncludeTest}>
              Include my test entries
              <span className="block text-xs font-medium leading-5 text-slate-500">Nobody else can include them in a report.</span>
            </CrmCheck>
          ) : null}
        </div>
      </CrmBlock>

      {activeSection === "daily" ? (
        // Ahead of the shared period's check: this section reads its own days, never those.
        <DailyPlanSection idPrefix={idPrefix} needsTerritory={dailyNeedsTerritory} problem={dailyProblem} resource={daily} />
      ) : problem ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Pick a quick choice above, or change the first or last day." title="Choose the days to read" />
        </div>
      ) : activeSection === "visits" ? (
        <VisitsSection canSeeLocations={view.canSeeLocations} idPrefix={idPrefix} resource={visits} territories={chosen} today={today} />
      ) : activeSection === "plan" ? (
        <PlanSection idPrefix={idPrefix} resource={plan} territories={chosen} today={today} />
      ) : activeSection === "coverage" ? (
        <CoverageSection idPrefix={idPrefix} resource={coverage} />
      ) : activeSection === "exceptions" ? (
        <ExceptionsSection idPrefix={idPrefix} resource={exceptions} />
      ) : activeSection === "bricks" ? (
        <BricksSection idPrefix={idPrefix} resource={bricks} />
      ) : activeSection === "adoption" ? (
        <AdoptionSection idPrefix={idPrefix} resource={adoption} />
      ) : activeSection === "locations" ? (
        <LocationsSection idPrefix={idPrefix} resource={locations} />
      ) : (
        <ManagersSection idPrefix={idPrefix} resource={managers} today={today} />
      )}
    </CrmPanel>
  );
}
