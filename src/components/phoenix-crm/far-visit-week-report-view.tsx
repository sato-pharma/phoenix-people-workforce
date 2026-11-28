/**
 * The Far-visit week, drawn (owner, 28 Nov 2026): a rep per row, a day per column — green "Clean", red "N rejected",
 * amber "N waiting", or a dash — and a day that is not clean opens below the week with every line of it and the map
 * behind each. Nothing here writes: the week arrows, the cells and the Excel button are links.
 *
 * One component for both shells: the Super Admin's page under /admin and a manager's copy in the portal pass their
 * own `basePath`, and the server has already narrowed the report to the reader's scope.
 *
 * Fits the screen at every width (the golden rule): a fixed table with named column widths from `lg` up, and below
 * it one card per rep with his days as wrapping lines — never a sideways scroll.
 */
import Link from "next/link";

import { RejectedVisitMap } from "@/components/phoenix-crm/rejected-visit-map";
import { FAR_VISIT_WEEK_KIND_LABELS, farVisitWeekCellText, farVisitWeekDayLabel } from "@/lib/phoenix-crm/far-visit-week-rules";
import type { FarVisitWeekCell, FarVisitWeekDayItem, FarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

export const FAR_VISIT_WEEK_EXPORT_PATH = "/api/phoenix-crm/far-visit-week-report/export";

const STANDING_CLASSES: Record<FarVisitWeekCell["standing"], string> = {
  clean: "border-emerald-200 bg-emerald-50 text-emerald-800",
  rejected: "border-rose-300 bg-rose-50 text-rose-800",
  waiting: "border-amber-300 bg-amber-50 text-amber-800",
  none: "border-slate-100 bg-white text-slate-400",
};

const thClassName = "border-b border-slate-200 bg-slate-950 px-2 py-2.5 align-bottom text-xs font-black uppercase tracking-wide text-white break-words";
const tdClassName = "border-b border-slate-100 px-2 py-2 align-top break-words text-sm text-slate-700";

function cellHref(basePath: string, week: string, seatId: string, date: string): string {
  return `${basePath}?week=${week}&seat=${encodeURIComponent(seatId)}&date=${date}#far-visit-day`;
}

function DayCell({ basePath, cell, seatId, week, selected }: { basePath: string; cell: FarVisitWeekCell; seatId: string; week: string; selected: boolean }) {
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
      <Link aria-label={`Open ${farVisitWeekDayLabel(cell.date)}`} className="block hover:opacity-90" href={cellHref(basePath, week, seatId, cell.date)} scroll={false}>
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

export function FarVisitWeekReportView({
  basePath,
  report,
  selected,
}: {
  basePath: string;
  report: FarVisitWeekReport;
  selected: { seatId: string; date: string; repName: string; items: FarVisitWeekDayItem[] } | null;
}) {
  const { week, rows, totals } = report;
  const rejected = totals.doorRejected + totals.sfeRejected;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-white p-3">
        <Link className="border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-800 hover:bg-slate-50" href={`${basePath}?week=${week.previous}`}>
          ← Previous week
        </Link>
        <p className="min-w-0 flex-1 break-words text-center text-sm font-black text-slate-900">
          {farVisitWeekDayLabel(week.start)} to {farVisitWeekDayLabel(week.end)} {week.end.slice(0, 4)}
        </p>
        {week.next ? (
          <Link className="border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-800 hover:bg-slate-50" href={`${basePath}?week=${week.next}`}>
            Next week →
          </Link>
        ) : null}
        <a className="border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-800" href={`${FAR_VISIT_WEEK_EXPORT_PATH}?week=${week.start}`}>
          Download Excel
        </a>
      </div>

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

      {rows.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-sm text-slate-600">No territory in your scope has an open line yet, so there is no week to show.</p>
      ) : (
        <>
          <div className="hidden min-w-0 border border-slate-200 bg-white lg:block">
            <table className="w-full table-fixed border-collapse text-left">
              <colgroup>
                <col style={{ width: "19%" }} />
                {week.days.map((day) => (
                  <col key={day} />
                ))}
                <col style={{ width: "9%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th className={thClassName} scope="col">
                    Rep
                  </th>
                  {week.days.map((day) => (
                    <th className={thClassName} key={day} scope="col">
                      {farVisitWeekDayLabel(day)}
                    </th>
                  ))}
                  <th className={thClassName} scope="col">
                    Week
                  </th>
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
                        <DayCell
                          basePath={basePath}
                          cell={cell}
                          seatId={row.seatId}
                          selected={selected?.seatId === row.seatId && selected.date === cell.date}
                          week={week.start}
                        />
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
            </table>
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
                      <DayCell
                        basePath={basePath}
                        cell={cell}
                        seatId={row.seatId}
                        selected={selected?.seatId === row.seatId && selected.date === cell.date}
                        week={week.start}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
