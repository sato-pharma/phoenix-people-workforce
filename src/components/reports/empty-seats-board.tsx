import { AlertCircle, ArrowLeft, Armchair, CalendarClock, Coins, Target } from "lucide-react";
import Link from "next/link";

import { AdminCallout, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { formatVacancyDate } from "@/lib/employees/vacancy-display";
import {
  EMPTY_SEAT_LONG_DAYS,
  type EmptySeatClosing,
  type EmptySeatRow,
  type EmptySeatsBoard as EmptySeatsBoardData,
} from "@/lib/reports/empty-seats";
import { formatCurrency } from "@/lib/sales/format";

const NOT_READ = "Could not be read";

function closingWords(closing: EmptySeatClosing): string | null {
  if (closing.state === "no_row") return `Not in the ${closing.periodLabel} closing`;
  if (closing.state === "no_published_month") return "No published month";
  if (closing.state === "unavailable") return NOT_READ;
  return null;
}

function ClosingFigures({ closing }: { closing: EmptySeatClosing }) {
  const words = closingWords(closing);
  if (closing.state !== "figures") return <span className="text-sm text-slate-500">{words}</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-bold tabular-nums text-slate-900">{formatCurrency(closing.salesValue)}</p>
      <p className="text-xs tabular-nums text-slate-600">
        {closing.targetValue === null ? "No target" : `Target ${formatCurrency(closing.targetValue)}`}
        {closing.achievement === null ? "" : ` · ${Math.round(closing.achievement * 100)}%`}
      </p>
      <p className="text-xs text-slate-500">{closing.periodLabel}</p>
    </div>
  );
}

function EmptySince({ row }: { row: EmptySeatRow }) {
  if (!row.emptySince) return <span className="text-sm text-slate-500">Date not recorded</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-bold tabular-nums text-slate-900">{row.emptySince.days} days</p>
      <p className="text-xs text-slate-500">
        {row.emptySince.source === "last_rep" ? "Last rep left" : "Vacancy opened"} {formatVacancyDate(row.emptySince.date)}
      </p>
    </div>
  );
}

function ListHeld({ row }: { row: EmptySeatRow }) {
  if (row.contactCount === null) return <span className="text-sm text-slate-500">{NOT_READ}</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-bold tabular-nums text-slate-900">{row.contactCount}</p>
      <p className="text-xs text-slate-500">{row.pharmacyCount ?? 0} pharmacies besides</p>
    </div>
  );
}

function VisitsLogged({ row }: { row: EmptySeatRow }) {
  if (row.seatVisits === null || row.managerVisits === null) return <span className="text-sm text-slate-500">{NOT_READ}</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-bold tabular-nums text-slate-900">{row.seatVisits + row.managerVisits}</p>
      <p className="text-xs text-slate-500">{row.managerVisits} by managers on their own</p>
    </div>
  );
}

function SeatName({ row }: { row: EmptySeatRow }) {
  return (
    <div className="space-y-0.5">
      <p className="break-words font-bold text-slate-900">{row.areaName}</p>
      <p className="break-words text-xs text-slate-500">
        {row.lineName} · {row.regionName}
      </p>
    </div>
  );
}

/**
 * Seven columns that fit, on the table's OWN width: `table-fixed` with a `<colgroup>`, the closing's
 * three figures merged into one cell rather than three narrow ones. Below that width, cards.
 */
function SeatsTable({ ranked, rows }: { ranked: boolean; rows: EmptySeatRow[] }) {
  const head = "px-3 py-2.5 text-left align-bottom text-xs font-bold uppercase tracking-wide text-slate-500";
  const cell = "px-3 py-3 align-top text-sm";
  return (
    <div className="@container">
      <table className="hidden w-full table-fixed border-collapse @3xl:table">
        <colgroup>
          <col style={{ width: "5%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "21%" }} />
          <col style={{ width: "15%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "14%" }} />
        </colgroup>
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className={head} scope="col">{ranked ? "Rank" : ""}</th>
            <th className={head} scope="col">Seat</th>
            <th className={head} scope="col">Published closing</th>
            <th className={head} scope="col">Empty for</th>
            <th className={head} scope="col">Customers</th>
            <th className={head} scope="col">Visits logged</th>
            <th className={head} scope="col">Last rep</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className="border-b border-slate-100 last:border-b-0" key={row.key}>
              <td className={`${cell} font-bold tabular-nums text-slate-500`}>{ranked ? index + 1 : ""}</td>
              <td className={cell}><SeatName row={row} /></td>
              <td className={cell}><ClosingFigures closing={row.closing} /></td>
              <td className={cell}><EmptySince row={row} /></td>
              <td className={cell}><ListHeld row={row} /></td>
              <td className={cell}><VisitsLogged row={row} /></td>
              <td className={`${cell} break-words text-slate-700`}>{row.lastRepName ?? "Nobody on record"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-slate-100 @3xl:hidden">
        {rows.map((row, index) => (
          <li className="space-y-3 px-4 py-4" key={row.key}>
            <div className="flex items-start gap-3">
              {ranked ? <span className="text-sm font-bold tabular-nums text-slate-500">{index + 1}</span> : null}
              <SeatName row={row} />
            </div>
            <ClosingFigures closing={row.closing} />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Empty for</dt>
                <dd className="mt-1"><EmptySince row={row} /></dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Customers</dt>
                <dd className="mt-1"><ListHeld row={row} /></dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Visits logged</dt>
                <dd className="mt-1"><VisitsLogged row={row} /></dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Last rep</dt>
                <dd className="mt-1 break-words text-slate-700">{row.lastRepName ?? "Nobody on record"}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The body both shells draw. Each page brings its own chrome and its own way back to the report. */
export function EmptySeatsBoard({ backHref, board }: { backHref: string; board: EmptySeatsBoardData }) {
  const all = [...board.ranked, ...board.parked];
  const seats = (rows: EmptySeatRow[]) => new Set(rows.map((row) => row.seatId)).size;
  const longEmpty = seats(all.filter((row) => (row.emptySince?.days ?? 0) > EMPTY_SEAT_LONG_DAYS));
  const closingFailed = all.some((row) => row.closing.state === "unavailable");
  const months = board.linePeriods
    .map((line) => `${line.lineName} ${line.periodLabel ?? "no published month"}`)
    .join(" · ");
  const missing = board.areasWithoutFigures > 0 ? ` · leaves out ${board.areasWithoutFigures} with no figure` : "";

  return (
    <div className="space-y-5">
      <Link className="inline-flex items-center gap-1.5 text-sm font-semibold text-phx-accent-press" href={backHref}>
        <ArrowLeft className="h-4 w-4" />
        Vacancies Report
      </Link>

      {board.failedReads.length > 0 ? (
        <AdminCallout tone="warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Could not read {board.failedReads.join(", ")}. Those columns say so below, and none of them is a zero.
            {closingFailed ? " The ranking cannot be trusted until the published closing reads again." : ""}
          </p>
        </AdminCallout>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description={`${seats(board.ranked)} to fill · ${seats(board.parked)} left empty on purpose`}
          icon={<Armchair className="h-5 w-5" />}
          label="Empty seats"
          size="compact"
          value={board.seatCount}
        />
        <AdminStatCard
          description="With a recorded date"
          icon={<CalendarClock className="h-5 w-5" />}
          label={`Empty over ${EMPTY_SEAT_LONG_DAYS} days`}
          size="compact"
          tone="rose"
          value={longEmpty}
        />
        <AdminStatCard
          description={closingFailed ? NOT_READ : `${months || "No seats in your reach"}${missing}`}
          icon={<Coins className="h-5 w-5" />}
          label="Sold in these areas"
          size="compact"
          tone="emerald"
          value={closingFailed ? "—" : formatCurrency(board.salesTotal)}
        />
        <AdminStatCard
          description={closingFailed ? NOT_READ : `Target of the same areas and months${missing}`}
          icon={<Target className="h-5 w-5" />}
          label="Their target"
          size="compact"
          tone="blue"
          value={closingFailed ? "—" : formatCurrency(board.targetTotal)}
        />
      </section>

      <AdminTableShell
        description={`${board.scopeNote}. Highest published sales first, then the larger target, then empty longest. Visits are the last ${board.visitWindowDays} days since the seat emptied, whether or not they score yet.`}
        title="Seats to fill"
      >
        {board.ranked.length > 0 ? (
          <SeatsTable ranked rows={board.ranked} />
        ) : (
          <p className="px-5 py-6 text-sm text-slate-500">No empty seats to fill in your reach.</p>
        )}
      </AdminTableShell>

      {board.parked.length > 0 ? (
        <AdminTableShell
          description="On the list of seats kept empty until a hire is made into them. They carry the same figures and are not ranked."
          title="Left empty on purpose"
        >
          <SeatsTable ranked={false} rows={board.parked} />
        </AdminTableShell>
      ) : null}
    </div>
  );
}
