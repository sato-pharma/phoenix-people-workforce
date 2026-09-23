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
} from "@/components/phoenix-crm/ui";
import { fieldWeekStart, isIsoDay, monthStartOf, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { daysInPeriod, REPORT_MAX_DAYS, type CoverageCell, type PlanCounts, type VisitCounts } from "@/lib/phoenix-crm/report-rules";
import type {
  CoverageReportView,
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
  VisitsReportView,
} from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type ReportSection = "visits" | "plan" | "coverage" | "managers";
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

/** "2 double · 1 chain · 1 far from the place"; null when none of those happened. */
function visitKindsText(counts: VisitCounts): string | null {
  const parts = [
    counts.doubleVisits > 0 ? `${countText(counts.doubleVisits)} double` : null,
    counts.chainVisits > 0 ? `${countText(counts.chainVisits)} chain` : null,
    counts.farVisits > 0 ? `${countText(counts.farVisits)} far from the place` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The kinds, and the Super Admin's test visits among the figures when they are counted. */
function visitDetailText(counts: VisitCounts, includeTest: boolean): string | null {
  const parts = [visitKindsText(counts), includeTest && counts.testVisits > 0 ? `${countText(counts.testVisits)} test` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "12 visits · 2 double · 1 far from the place", or "No visits". */
function visitCountsText(counts: VisitCounts | null, includeTest: boolean): string {
  if (!counts || counts.visits === 0) return "No visits";
  const detail = visitDetailText(counts, includeTest);
  return detail ? `${plural(counts.visits, "visit", "visits")} · ${detail}` : plural(counts.visits, "visit", "visits");
}

function visitDayLine(listType: "AM" | "PM", counts: VisitCounts, includeTest: boolean): string {
  return `${listType}: ${counts.visits === 0 ? "no visits" : visitCountsText(counts, includeTest)}`;
}

/** Every day of the period (a Friday only when someone visited), doctors and accounts on their own lines. */
function visitDayLines(row: RepVisitRow, period: Period, includeTest: boolean): DayLine[] {
  const byDate = new Map(row.days.map((day) => [day.date, day]));
  return daysOf(period).flatMap((date): DayLine[] => {
    const day = byDate.get(date);
    if (!day || (day.am.visits === 0 && day.pm.visits === 0)) {
      return weekdayOfIsoDay(date) === FRIDAY ? [] : [{ date, lines: ["No visits"], muted: true }];
    }
    return [{ date, lines: [visitDayLine("PM", day.pm, includeTest), visitDayLine("AM", day.am, includeTest)] }];
  });
}

function visitCell(counts: VisitCounts | null, includeTest: boolean) {
  if (!counts || counts.visits === 0) {
    return (
      <td className={crmTdClassName}>
        <p className="text-slate-400">No visits</p>
      </td>
    );
  }
  const detail = visitDetailText(counts, includeTest);
  return (
    <td className={crmTdClassName}>
      <p className="font-black text-slate-950">{plural(counts.visits, "visit", "visits")}</p>
      {detail ? <p className="mt-0.5 text-xs text-slate-500">{detail}</p> : null}
    </td>
  );
}

function VisitsSection({
  idPrefix,
  resource,
  territories,
  today,
}: {
  idPrefix: string;
  resource: CrmResource<VisitsReportView>;
  territories: ReadonlyArray<ReportTerritory>;
  today: string;
}) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Counting the visits" onRetry={resource.reload} />;

  const { AM: am, PM: pm } = report.totals;
  const repRows = report.rows.filter((row) => row.repHrId !== null);
  const reps = new Set(repRows.map((row) => row.repHrId)).size;
  const repDays = repRows.reduce((sum, row) => sum + row.visitDays, 0);
  const oneDay = report.period.from === report.period.to;
  const kindsNote = (counts: VisitCounts, noneVisited: string) =>
    visitKindsText(counts) ?? (counts.visits === 0 ? noneVisited : "No double, chain or far visit");

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
          <CrmStat label="PM visits" note={kindsNote(pm, "No PM visited")} value={countText(pm.visits)} />
          <CrmStat label="AM visits" note={kindsNote(am, "No AM visited")} value={countText(am.visits)} />
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
                { label: "PM", value: visitCountsText(line.row?.pm ?? null, report.includeTest) },
                { label: "AM", value: visitCountsText(line.row?.am ?? null, report.includeTest) },
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
                <DayList days={visitDayLines(line.row, report.period, report.includeTest)} today={today} />
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
            {visitCell(line.row?.pm ?? null, report.includeTest)}
            {visitCell(line.row?.am ?? null, report.includeTest)}
            {oneDay ? null : <td className={crmTdClassName}>{line.row ? <DaysToggle onToggle={onToggle} open={open} /> : null}</td>}
          </>
        )}
        renderOpen={
          oneDay ? undefined : (line) => (line.row ? <DayList days={visitDayLines(line.row, report.period, report.includeTest)} today={today} /> : null)
        }
        searchWords={(line) => [line.territoryName, line.repName]}
        words={{ ...LIST_WORDS, title: "By territory and rep", with: "With visits", without: "No visits" }}
      />
    </>
  );
}

// ── Plan against actual ─────────────────────────────────────────────────────────────────────────

const NO_PLAN: PlanCell = { planned: 0, visitedPlanned: 0, missed: 0, unplanned: 0, keptPct: null };

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

/** "1 missed · 2 off the plan"; null when neither happened. */
function planMissText(counts: PlanCounts): string | null {
  const parts = [
    counts.missed > 0 ? `${countText(counts.missed)} missed` : null,
    counts.unplanned > 0 ? `${countText(counts.unplanned)} off the plan` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "80% · 1 missed · 2 off the plan". */
function planDetailText(cell: PlanCell): string | null {
  const parts = [cell.keptPct === null ? null : percentText(cell.keptPct), planMissText(cell)].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function planCell(cell: PlanCell) {
  const detail = planDetailText(cell);
  return (
    <td className={crmTdClassName}>
      <p className={cell.planned > 0 ? "font-black text-slate-950" : "text-slate-400"}>{planMainText(cell)}</p>
      {detail ? <p className="mt-0.5 text-xs text-slate-500">{detail}</p> : null}
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
  const oneDay = report.period.from === report.period.to;
  const keptStat = (cell: PlanCell, listType: "AM" | "PM", noneLabel: string) => (
    <CrmStat
      label={`Planned ${listType} visited`}
      note={cell.planned > 0 ? `${percentText(cell.keptPct)} of the planned ${listType}, on their day` : noneLabel}
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
          {keptStat(pm, "PM", "No PM planned")}
          {keptStat(am, "AM", "No AM planned")}
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
            {planCell(line.row?.pm ?? NO_PLAN)}
            {planCell(line.row?.am ?? NO_PLAN)}
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

function coverageCellMarkup(percent: number | null, note: string, hasList: boolean) {
  return (
    <td className={crmTdClassName}>
      <p className={hasList ? "font-black text-slate-950" : "text-slate-400"}>{percentText(percent)}</p>
      <p className="mt-0.5 text-xs text-slate-500">{note}</p>
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
          <CrmStat label="PM coverage" note={coverageNote(pm, "PM")} value={percentText(pm.coveragePct)} />
          <CrmStat label="AM coverage" note={coverageNote(am, "AM")} value={percentText(am.coveragePct)} />
          <CrmStat label="PM frequency" note={frequencyNote(pm, "PM")} value={percentText(pm.frequencyPct)} />
          <CrmStat label="AM frequency" note={frequencyNote(am, "AM")} value={percentText(am.frequencyPct)} />
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
            {coverageCellMarkup(row.pm.coveragePct, coverageNote(row.pm, "PM"), row.pm.customers > 0)}
            {coverageCellMarkup(row.am.coveragePct, coverageNote(row.am, "AM"), row.am.customers > 0)}
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

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

const SECTION_TITLES: Record<ReportSection, string> = {
  visits: "Visits per day",
  plan: "Plan against actual",
  coverage: "Coverage and frequency",
  managers: "Double and chain visits",
};

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

  const view = scope.data;
  const today = view?.cairoToday ?? cairoToday;
  const territories = view?.territories ?? [];
  const lineTerritories = lineCode ? territories.filter((territory) => territory.lineCode === lineCode) : territories;
  const chosen = seatId ? lineTerritories.filter((territory) => territory.seatId === seatId) : lineTerritories;
  const activeSection: ReportSection = section === "managers" && view && !view.hasManagers ? "visits" : section;
  const withTest = Boolean(view?.canIncludeTest) && includeTest;
  const problem = activeSection === "coverage" ? null : periodProblem(period, today, view?.maxDays ?? REPORT_MAX_DAYS);

  function sectionUrl(name: ReportSection): string | null {
    if (!view || name !== activeSection) return null;
    const filters = { section: name, lineCode: lineCode || null, seatId: seatId || null, includeTest: withTest };
    if (name === "coverage") return crmUrl(REPORTS_PATH, { ...filters, month });
    return problem ? null : crmUrl(REPORTS_PATH, { ...filters, from: period.from, to: period.to });
  }

  const visits = useCrmGet<VisitsReportView>(sectionUrl("visits"), "report");
  const plan = useCrmGet<PlanReportView>(sectionUrl("plan"), "report");
  const coverage = useCrmGet<CoverageReportView>(sectionUrl("coverage"), "report");
  const managers = useCrmGet<ManagerReportView>(sectionUrl("managers"), "report");
  const active = { coverage, managers, plan, visits }[activeSection];

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

  const sectionOptions: Array<CrmChoiceOption<ReportSection>> = [
    { value: "visits", label: SECTION_TITLES.visits, note: "AM and PM apart" },
    { value: "plan", label: SECTION_TITLES.plan, note: "Visited or missed, day by day" },
    { value: "coverage", label: SECTION_TITLES.coverage, note: "The list, month by month" },
    ...(view.hasManagers ? [{ value: "managers" as const, label: SECTION_TITLES.managers, note: "Per manager" }] : []),
  ];
  const presetOptions: Array<CrmChoiceOption<PeriodPreset>> = PRESETS.map(({ label, value }) => {
    const range = presetPeriod(value, today);
    const beforeOpening = range.to < FIRST_REPORT_DAY;
    return { value, label, note: beforeOpening ? "Before Phoenix CRM opened" : shortPeriodText(range), disabled: beforeOpening };
  });
  const currentMonth = today.slice(0, 7);

  return (
    <CrmPanel
      actions={
        <CrmButton busy={scope.loading || active.loading} disabled={Boolean(problem)} onClick={refresh} size="sm">
          Refresh
        </CrmButton>
      }
      description={REPORTS_DESCRIPTION}
      eyebrow={withTest ? "Reports · your test entries included" : "Reports"}
      title={SECTION_TITLES[activeSection]}
    >
      <CrmBlock title="Report">
        <CrmChoice columns={view.hasManagers ? 4 : 3} label="Report" onChange={setSection} options={sectionOptions} value={activeSection} />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Filters">
        <div className="grid min-w-0 gap-3">
          {activeSection === "coverage" ? (
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
                    <option value="">{`Every territory · ${countText(lineTerritories.length)}`}</option>
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

      {problem ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Pick a quick choice above, or change the first or last day." title="Choose the days to read" />
        </div>
      ) : activeSection === "visits" ? (
        <VisitsSection idPrefix={idPrefix} resource={visits} territories={chosen} today={today} />
      ) : activeSection === "plan" ? (
        <PlanSection idPrefix={idPrefix} resource={plan} territories={chosen} today={today} />
      ) : activeSection === "coverage" ? (
        <CoverageSection idPrefix={idPrefix} resource={coverage} />
      ) : (
        <ManagersSection idPrefix={idPrefix} resource={managers} today={today} />
      )}
    </CrmPanel>
  );
}
