/**
 * The Far-visit week, drawn (owner, 28 Nov 2026): a rep per row, a day per column — green "Clean", red "N rejected",
 * amber "N waiting", or a dash — and a day that is not clean opens below the totals with every line of it and the map
 * behind each. Nothing here writes: the week arrows, the cells and the Excel button are links, and the filters are a
 * plain GET form.
 *
 * One component for both shells: the Super Admin's page under /admin and a manager's copy in the portal pass their
 * own `basePath`, and the server has already narrowed the report to the reader's scope.
 *
 * Above the week: the WEEKS to read, several at once (owner, 28 Nov 2026: "multi select multi weeks"), and three
 * filters — district manager, line, rep. Every link on the page carries both (`farVisitWeekQuery`), so opening a
 * day, moving a week or downloading the Excel file keeps what the reader chose. Several weeks draw one grid each,
 * newest first, under one set of totals.
 *
 * Fits the screen at every width (the golden rule): from `lg` up each week is a fixed `CrmTable` with named column
 * widths, and below it one card per rep with his days as wrapping lines — never a sideways scroll.
 */
import Link from "next/link";

import { RejectedVisitMap } from "@/components/phoenix-crm/rejected-visit-map";
import { CrmTable } from "@/components/phoenix-crm/ui";
import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxCheckInputClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import {
  FAR_VISIT_WEEK_KIND_LABELS,
  FAR_VISIT_WEEK_MAX,
  farVisitWeekCellText,
  farVisitWeekChoices,
  farVisitWeekDayLabel,
  farVisitWeekFilterNarrows,
  farVisitWeekQuery,
  farVisitWeekRangeLabel,
  type FarVisitWeek,
  type FarVisitWeekFilter,
} from "@/lib/phoenix-crm/far-visit-week-rules";
import type { FarVisitWeekCell, FarVisitWeekDayItem, FarVisitWeekOption, FarVisitWeekReport, FarVisitWeeksReport } from "@/lib/phoenix-crm/far-visit-week-types";

export const FAR_VISIT_WEEK_EXPORT_PATH = "/api/phoenix-crm/far-visit-week-report/export";

const NO_FILTER: FarVisitWeekFilter = { dm: null, line: null, rep: null };

const STANDING_CLASSES: Record<FarVisitWeekCell["standing"], string> = {
  clean: "border-emerald-200 bg-emerald-50 text-emerald-800",
  rejected: "border-rose-300 bg-rose-50 text-rose-800",
  waiting: "border-amber-300 bg-amber-50 text-amber-800",
  none: "border-slate-100 bg-white text-slate-400",
};

const thClassName = "border-b border-slate-200 bg-slate-950 px-2 py-2.5 align-bottom text-xs font-black uppercase tracking-wide text-white break-words";
const tdClassName = "border-b border-slate-100 px-2 py-2 align-top break-words text-sm text-slate-700";

/** What every link on the page carries: the weeks chosen and the filters. */
type Reading = { basePath: string; chosen: string[]; filter: FarVisitWeekFilter };

function cellHref(reading: Reading, seatId: string, date: string): string {
  return `${reading.basePath}${farVisitWeekQuery(reading.chosen, reading.filter, { seat: seatId, date })}#far-visit-day`;
}

function Choice({ name, label, any, value, options }: { name: string; label: string; any: string; value: string | null; options: FarVisitWeekOption[] }) {
  return (
    <label className="min-w-0">
      <span className={phxLabelClassName}>{label}</span>
      <select className={phxSelectClassName} defaultValue={value ?? ""} name={name}>
        <option value="">{any}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The weeks and the three filters: a plain GET form, so the reading is an address that can be shared. The weeks are
 * the last few company weeks as tick boxes (and any older week already chosen, so it stays chosen).
 */
function WeekFilters({ reading, report, today }: { reading: Reading; report: FarVisitWeeksReport; today: string }) {
  const { filter, options } = report;
  const chosen = new Set(reading.chosen);
  const offered = new Map<string, FarVisitWeek>(farVisitWeekChoices(today).map((week) => [week.start, week]));
  for (const entry of report.weeks) offered.set(entry.week.start, entry.week);
  const weeks = [...offered.values()].sort((a, b) => b.start.localeCompare(a.start));
  return (
    <form action={reading.basePath} className="grid grid-cols-1 gap-3 border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-4" method="get">
      <fieldset className="min-w-0 sm:col-span-2 lg:col-span-4">
        <legend className={phxLabelClassName}>Weeks · tick one or several, up to {FAR_VISIT_WEEK_MAX}</legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-6">
          {weeks.map((week) => (
            <label className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-800" key={week.start}>
              <input className={phxCheckInputClassName} defaultChecked={chosen.has(week.start)} name="week" type="checkbox" value={week.start} />
              <span className="min-w-0 break-words">
                {farVisitWeekDayLabel(week.start)} to {farVisitWeekDayLabel(week.end)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Choice any="Every district manager" label="District manager" name="dm" options={options.districts} value={filter.dm} />
      <Choice any="Every line" label="Line" name="line" options={options.lines.map((line) => ({ value: line, label: line }))} value={filter.line} />
      <Choice any="Every rep" label="Rep" name="rep" options={options.reps} value={filter.rep} />
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <button className={phxButtonPrimaryClassName} type="submit">
          Show
        </button>
        {farVisitWeekFilterNarrows(filter) ? (
          <Link className={phxButtonGhostClassName} href={`${reading.basePath}${farVisitWeekQuery(reading.chosen, NO_FILTER)}`}>
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function DayCell({ reading, cell, seatId, selected }: { reading: Reading; cell: FarVisitWeekCell; seatId: string; selected: boolean }) {
  const text = farVisitWeekCellText(cell);
  const body = (
    <span className={`block border px-2 py-1.5 ${STANDING_CLASSES[cell.standing]} ${selected ? "outline outline-2 outline-slate-900" : ""}`}>
      <span className="block break-words text-xs font-black">{text.head}</span>
      {text.foot ? <span className="block break-words text-xs font-semibold opacity-80">{text.foot}</span> : null}
    </span>
  );
  // Only a day with something to read opens; a clean day and an empty day have nothing behind them.
  if (cell.standing === "rejected" || cell.standing === "waiting") {
    return (
      <Link aria-label={`Open ${farVisitWeekDayLabel(cell.date)}`} className="block hover:opacity-90" href={cellHref(reading, seatId, cell.date)} scroll={false}>
        {body}
      </Link>
    );
  }
  return body;
}

function DayDetail({ items, repName, date }: { items: FarVisitWeekDayItem[]; repName: string; date: string }) {
  return (
    <section className="border border-slate-200 bg-white p-4" id="far-visit-day">
      <h2 className="break-words text-base font-black text-slate-900">
        {repName} · {farVisitWeekDayLabel(date)}
      </h2>
      <p className="mt-1 break-words text-sm text-slate-600">Every try the system refused this day for being away from the customer&apos;s place. A refused try is never accepted; only a visit that meets the rule is.</p>
      {items.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nothing was refused or held on this day.</p> : null}
      <div className="mt-3 space-y-3">
        {items.map((item) => (
          <div className="border-t border-slate-100 pt-3" key={`${item.kind}-${item.visitId ?? item.customerId}-${item.at ?? ""}`}>
            <p className="break-words text-sm font-bold text-slate-900">
              {item.customerName}
              <span className="font-semibold text-slate-500">
                {" "}
                · {FAR_VISIT_WEEK_KIND_LABELS[item.kind]}
                {item.at ? ` · ${new Date(item.at).toLocaleTimeString("en-GB", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo" })}` : ""}
              </span>
            </p>
            <p className="break-words text-xs text-slate-600">
              {item.distanceMeters !== null ? `${item.distanceMeters.toLocaleString("en-US")} m from the customer's place` : "Distance not measured"}
              {item.farMeters !== null ? ` (the line is ${item.farMeters.toLocaleString("en-US")} m)` : ""}
              {item.kind === "door" ? ` · save pressed ${item.tries} ${item.tries === 1 ? "time" : "times"}` : ""}
              {item.kind === "door" && item.loggedLater ? " · accepted later the same day, from the place" : ""}
            </p>
            <RejectedVisitMap
              rejection={{
                label: FAR_VISIT_WEEK_KIND_LABELS[item.kind],
                map: item.map,
                note: item.map
                  ? `${item.points.map((point) => `${point.index} ${point.label.toLowerCase()}`).join(", ")}.`
                  : "No position was kept for this one, or the customer has no saved place, so there is no map.",
                points: item.points,
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** One week's grid: a fixed table from `lg` up, a card per rep below it. */
function WeekGrid({
  reading,
  report,
  selected,
  heading,
}: {
  reading: Reading;
  report: FarVisitWeekReport;
  selected: { seatId: string; date: string } | null;
  heading: boolean;
}) {
  const { week, rows } = report;
  const isSelected = (seatId: string, date: string) => selected?.seatId === seatId && selected.date === date;
  return (
    <section className="space-y-2">
      {heading ? (
        <h2 className="break-words border-l-4 border-slate-900 pl-2 text-sm font-black text-slate-900">
          {farVisitWeekRangeLabel(week)} · {report.totals.doorRejected + report.totals.sfeRejected} rejected
        </h2>
      ) : null}
      <div className="hidden min-w-0 border border-slate-200 bg-white lg:block">
        <CrmTable columns={["19%", ...week.days.map(() => null), "9%"]} desktopOnly={false}>
          <thead>
            <tr>
              {["Rep", ...week.days.map(farVisitWeekDayLabel), "Week"].map((label) => (
                <th className={thClassName} key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.seatId}>
                <td className={tdClassName}>
                  <span className="block break-words font-bold text-slate-900">{row.repName}</span>
                  <span className="block break-words text-xs text-slate-500">{row.territory}</span>
                </td>
                {row.cells.map((cell) => (
                  <td className={tdClassName} key={cell.date}>
                    <DayCell cell={cell} reading={reading} seatId={row.seatId} selected={isSelected(row.seatId, cell.date)} />
                  </td>
                ))}
                <td className={tdClassName}>
                  <span className="block text-xs font-black text-slate-900">{row.totals.doorRejected + row.totals.sfeRejected} rejected</span>
                  <span className="block text-xs text-slate-500">{row.totals.visits} visits</span>
                  <span className="block text-xs text-slate-500">{row.cleanDays} clean days</span>
                </td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      </div>

      <div className="space-y-3 lg:hidden">
        {rows.map((row) => (
          <div className="border border-slate-200 bg-white p-3" key={row.seatId}>
            <p className="break-words text-sm font-black text-slate-900">{row.repName}</p>
            <p className="break-words text-xs text-slate-500">
              {row.territory} · {row.totals.doorRejected + row.totals.sfeRejected} rejected · {row.totals.visits} visits
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {row.cells.map((cell) => (
                <div className="min-w-0" key={cell.date}>
                  <p className="text-xs font-bold text-slate-500">{farVisitWeekDayLabel(cell.date)}</p>
                  <DayCell cell={cell} reading={reading} seatId={row.seatId} selected={isSelected(row.seatId, cell.date)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function FarVisitWeekReportView({
  basePath,
  report,
  selected,
  today,
}: {
  basePath: string;
  report: FarVisitWeeksReport;
  selected: { seatId: string; date: string; repName: string; items: FarVisitWeekDayItem[] } | null;
  /** The reader's Cairo day, for the weeks the picker offers. */
  today: string;
}) {
  const { weeks, totals, filter } = report;
  const reading: Reading = { basePath, chosen: weeks.map((entry) => entry.week.start), filter };
  const single = weeks.length === 1 ? weeks[0].week : null;
  const newest = weeks[0].week;
  const oldest = weeks[weeks.length - 1].week;
  const rejected = totals.doorRejected + totals.sfeRejected;
  const rowsShown = weeks[0].rows.length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white p-3">
        {single ? (
          <Link className="border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-800 hover:bg-slate-50" href={`${basePath}${farVisitWeekQuery(single.previous, filter)}`}>
            ← Previous week
          </Link>
        ) : null}
        <p className="min-w-0 flex-1 break-words text-center text-sm font-black text-slate-900">
          {single ? farVisitWeekRangeLabel(single) : `${weeks.length} weeks · ${farVisitWeekRangeLabel({ start: oldest.start, end: newest.end })}`}
        </p>
        {single?.next ? (
          <Link className="border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-800 hover:bg-slate-50" href={`${basePath}${farVisitWeekQuery(single.next, filter)}`}>
            Next week →
          </Link>
        ) : null}
        <a className="border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-800" href={`${FAR_VISIT_WEEK_EXPORT_PATH}${farVisitWeekQuery(reading.chosen, filter)}`}>
          Download Excel
        </a>
      </div>

      <WeekFilters reading={reading} report={report} today={today} />

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Reps", value: totals.reps },
          { label: "Reps with a rejection", value: totals.repsWithRejections },
          { label: "Rejected visits", value: rejected },
          { label: "Waiting for the SFE", value: totals.waiting },
        ].map((fact) => (
          <div className="border border-slate-200 bg-white px-3 py-2" key={fact.label}>
            <dt className="break-words text-xs font-black uppercase tracking-wide text-slate-500">{fact.label}</dt>
            <dd className="text-xl font-black text-slate-900">{fact.value.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>

      {selected ? <DayDetail date={selected.date} items={selected.items} repName={selected.repName} /> : null}

      {rowsShown === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-sm text-slate-600">
          {farVisitWeekFilterNarrows(filter)
            ? "No rep in your report matches these filters. Clear one to see more."
            : "No territory in your scope has an open line yet, so there is no week to show."}
        </p>
      ) : (
        weeks.map((entry) => <WeekGrid heading={!single} key={entry.week.start} reading={reading} report={entry} selected={selected} />)
      )}
    </div>
  );
}
