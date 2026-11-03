import { FileSpreadsheet } from "lucide-react";
import Link from "next/link";

import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
import {
  financeAgeingDaysLabel,
  MARKETING_WAITING_OVERDUE_DAYS,
  type MarketingFinanceAgeing,
  type MarketingFinanceAgeingRow,
  type MarketingWaitingBand,
} from "@/lib/marketing-requests/finance-ageing";

const money = (value: number): string => `EGP ${Math.round(value).toLocaleString("en-US")}`;

/** Only the paint is decided here. The band itself is `marketingWaitingBand`, pinned by a test. */
const BAND_TONE: Record<MarketingWaitingBand, string> = {
  due_soon: "bg-amber-100 text-amber-800",
  on_time: "bg-slate-100 text-slate-600",
  overdue: "bg-rose-100 text-rose-800",
};

function DaysChip({ row }: { row: MarketingFinanceAgeingRow }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${BAND_TONE[row.band]}`}>
      {financeAgeingDaysLabel(row)}
    </span>
  );
}

function RequestLink({ row }: { row: MarketingFinanceAgeingRow }) {
  return (
    <Link className="break-words font-bold text-slate-900 hover:text-orange-700 hover:underline" dir="auto" href={row.href}>
      {row.customerName}
    </Link>
  );
}

/**
 * Read-only ON PURPOSE: executing belongs to the Approval Inbox and the Case File, so the one thing a
 * row does is link out to its request. Six columns because the fits-the-screen rule is merge, never
 * shrink or scroll: type rides with the customer, line with the requester.
 */
export function MarketingFinanceAgeingDesk({ report }: { report: MarketingFinanceAgeing }) {
  const { rows, totals } = report;

  if (rows.length === 0) {
    return (
      <div className={`${adminSoftPanelClassName} p-6`}>
        <p className="text-phx-md font-bold text-slate-900">Nothing is waiting at Finance Execution</p>
        <p className="mt-1 text-phx-sm text-slate-600">Every approved request has been executed. Read {cairoDateTime(report.generatedAtIso)} Cairo.</p>
      </div>
    );
  }

  const tiles = [
    { hint: "at Finance Execution", label: "Waiting", value: String(totals.count) },
    { hint: "approved, not yet executed", label: "Total cost", value: money(totals.totalCost) },
    {
      hint: "since it reached Finance",
      label: "Oldest",
      value: financeAgeingDaysLabel({ approximate: rows[0].approximate, daysWaiting: totals.oldestDays }),
    },
    {
      hint: `waiting ${MARKETING_WAITING_OVERDUE_DAYS} days or more`,
      label: `${MARKETING_WAITING_OVERDUE_DAYS}+ days`,
      value: String(totals.overdueCount),
    },
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <div className={`${adminSoftPanelClassName} p-4`} key={tile.label}>
            <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{tile.label}</dt>
            <dd className="mt-1 text-phx-lg font-bold text-slate-900">
              {tile.value}
              <span className="mt-0.5 block text-phx-xs font-normal text-slate-500">{tile.hint}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        {/* `download` is load-bearing: the target streams a binary, which a <Link> would hand to the
            client router. */}
        <a
          className="inline-flex min-h-10 items-center border border-slate-300 bg-white px-4 text-phx-sm font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
          download
          href="/api/marketing-requests/finance-ageing/export"
        >
          <FileSpreadsheet className="mr-2 h-3.5 w-3.5 shrink-0" />
          Download Excel
        </a>
        {totals.approximateCount > 0 ? (
          <p className="text-phx-xs text-slate-500">
            &ldquo;about&rdquo; means the step has no recorded opening, so its days are counted from the step&rsquo;s own dates.
          </p>
        ) : null}
      </div>

      <section className={adminPanelClassName}>
        <header className={`${adminPanelHeaderClassName} px-4 py-3`}>
          <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">Waiting at Finance Execution</p>
          <p className="mt-0.5 text-phx-xs text-slate-300">Read {cairoDateTime(report.generatedAtIso)} Cairo</p>
        </header>

        <div className="hidden md:block">
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[30%]" />
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[14%]" />
              <col className="w-[10%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2" scope="col">Customer</th>
                <th className="px-3 py-2" scope="col">Requester</th>
                <th className="px-3 py-2" scope="col">Cost</th>
                <th className="px-3 py-2" scope="col">Pay date</th>
                <th className="px-3 py-2" scope="col">Reached Finance</th>
                <th className="px-3 py-2" scope="col">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40" key={row.requestId}>
                  <td className="px-3 py-2">
                    <RequestLink row={row} />
                    <p className="break-words text-phx-xs text-slate-500" dir="auto">{row.requestType}</p>
                  </td>
                  <td className="px-3 py-2">
                    <p className="break-words font-semibold text-slate-800">{row.requesterName}</p>
                    <p className="break-words text-phx-xs text-slate-500">{row.lineName}</p>
                  </td>
                  <td className="px-3 py-2 font-bold text-slate-900">{money(row.estimatedCost)}</td>
                  <td className="px-3 py-2 text-slate-600">{utcDate(row.payDate)}</td>
                  <td className="px-3 py-2 text-slate-600">{cairoDateTime(row.reachedFinanceAt)}</td>
                  <td className="px-3 py-2"><DaysChip row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 p-3 md:hidden">
          {rows.map((row) => (
            <article className="border border-phx-line p-3" key={row.requestId}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><RequestLink row={row} /></div>
                <span className="shrink-0"><DaysChip row={row} /></span>
              </div>
              <p className="mt-1 break-words text-phx-sm text-slate-600" dir="auto">{row.requestType}</p>
              <p className="mt-2 break-words text-sm font-semibold text-slate-800">{row.requesterName}</p>
              <p className="break-words text-phx-xs text-slate-500">{row.lineName}</p>
              <p className="mt-2 text-sm font-bold text-slate-900">{money(row.estimatedCost)}</p>
              <p className="mt-1 text-phx-xs text-slate-500">Pay date {utcDate(row.payDate)}</p>
              <p className="text-phx-xs text-slate-500">Reached Finance {cairoDateTime(row.reachedFinanceAt)}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
