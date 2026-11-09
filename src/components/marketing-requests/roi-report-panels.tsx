"use client";

import * as React from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, ExternalLink, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";

import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import type { MarketingRoiReport, MarketingRoiReportRow } from "@/lib/marketing-requests/roi-report-types";
import {
  ROI_DEFAULT_SORT,
  ROI_RESULT_TONE,
  nextRoiSort,
  roiActualCaption,
  roiLookAtEmptyLine,
  roiMoney,
  roiPage,
  roiPageLine,
  roiPercent,
  roiRequestsToLookAt,
  roiRequestsWord,
  roiRequiredCaption,
  roiResultBar,
  roiResultWords,
  roiRowCoverageWords,
  roiRowDataWords,
  roiShortfallWords,
  roiSortLine,
  roiStandingCaption,
  roiStatusWords,
  roiTrustNotes,
  roiUnmeasuredCaption,
  sortRoiRows,
  type RoiSortKey,
  type RoiSortState,
} from "@/lib/marketing-requests/roi-tracking-summary";
import { cn } from "@/lib/utils";

/**
 * The ROI report once the filters are applied — the premium pass (owner, 9 Nov 2026). Five tiles, where the
 * requests stand, the requests to look at, then every request: a table on desktop and cards on a phone. Every word
 * and grade is `roi-tracking-summary.ts`'s; the team's money is the band's, deduplicated on the server, never
 * re-added here. Mounted by the Filter Engine on both shells.
 */

const LABEL = "text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint";

function Tile({ caption, icon: Icon, label, tone, value }: { caption: string; icon: typeof Target; label: string; tone: string; value: string }) {
  return (
    <div className={cn(adminPanelClassName, "border-l-[3px] px-3.5 py-3", tone)}>
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-ink-soft" />
        <p className={LABEL}>{label}</p>
      </div>
      <p className="mt-1.5 break-words text-phx-xl font-black leading-tight text-phx-ink">{value}</p>
      <p className="mt-1 break-words text-phx-xs font-semibold text-phx-ink-soft">{caption}</p>
    </div>
  );
}

function Tiles({ report }: { report: MarketingRoiReport }) {
  const { kpi } = report;
  return (
    <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-5">
      <Tile caption={`${roiRequestsWord(kpi.requestCount)} in this report`} icon={Wallet} label="Cost" tone="border-l-phx-accent" value={roiMoney(kpi.totalEstimatedCost)} />
      <Tile caption={roiRequiredCaption(kpi)} icon={Target} label="Required return" tone="border-l-sky-500" value={roiMoney(kpi.totalRequiredRoi)} />
      <Tile caption={roiActualCaption(kpi)} icon={TrendingUp} label="Actual sales" tone="border-l-emerald-600" value={roiMoney(kpi.totalActualValue)} />
      <Tile caption={roiStandingCaption(kpi)} icon={TrendingDown} label="Behind" tone="border-l-amber-500" value={String(kpi.behindCount)} />
      <Tile caption={roiUnmeasuredCaption(kpi)} icon={Clock} label="Not measured yet" tone="border-l-slate-400" value={String(kpi.awaitingDataCount + kpi.noDataCount)} />
    </div>
  );
}

const NOTE_TONE = {
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  plain: "border-phx-line bg-phx-paper text-phx-ink-2",
  sky: "border-sky-200 bg-sky-50 text-sky-800",
} as const;

function TrustNotes({ report }: { report: MarketingRoiReport }) {
  return (
    <ul className="flex flex-wrap items-center gap-2 text-phx-xs font-bold">
      {roiTrustNotes(report.kpi).map((note) => (
        <li className={cn("inline-flex items-center gap-1 border px-2 py-1", NOTE_TONE[note.tone])} key={note.key}>
          {note.tone === "amber" ? <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" /> : null}
          {note.words}
        </li>
      ))}
    </ul>
  );
}

function StandingPanel({ report }: { report: MarketingRoiReport }) {
  const parts = roiResultBar(report.kpi);
  return (
    <section className={cn(adminPanelClassName, "p-4 sm:p-5")}>
      <p className={LABEL}>Where the requests stand</p>
      <p className="mt-1 text-phx-md font-bold text-phx-ink-2">{roiStandingCaption(report.kpi)}</p>
      {parts.length === 0 ? (
        <p className="mt-3 text-phx-sm font-medium text-phx-ink-soft">No request in this report.</p>
      ) : (
        <>
          <div aria-hidden className="mt-3 flex h-3 w-full overflow-hidden bg-phx-paper-2">
            {parts.map((part) => (
              <span className={part.swatch} key={part.key} style={{ width: `${part.percent}%` }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold text-phx-ink-2">
            {parts.map((part) => (
              <li className="inline-flex items-center gap-1.5" key={part.key}>
                <span aria-hidden className={cn("h-2.5 w-2.5 shrink-0", part.swatch)} />
                {part.label} · {part.count} · {part.percent}%
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ViewSales({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-phx-xs font-black text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition hover:border-phx-accent-line hover:bg-phx-accent-soft"
      href={`${viewSalesBasePath}/marketing-requests/${row.requestId}/view-sales`}
      rel="noopener noreferrer"
      target="_blank"
    >
      <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
      View Sales
    </a>
  );
}

function LookAtPanel({ report, viewSalesBasePath }: { report: MarketingRoiReport; viewSalesBasePath: string }) {
  const items = roiRequestsToLookAt(report.rows);
  return (
    <section className={cn(adminPanelClassName, "p-4 sm:p-5")}>
      <p className={LABEL}>Requests to look at</p>
      {items.length === 0 ? (
        <p className="mt-2 text-phx-sm font-medium text-phx-ink-soft">{roiLookAtEmptyLine(report.kpi)}</p>
      ) : (
        <ul className="mt-2 divide-y divide-phx-paper-2">
          {items.map((item) => (
            <li className="flex flex-wrap items-start justify-between gap-2 py-2" key={item.row.requestId}>
              <div className="min-w-0 flex-1">
                <p className="break-words text-phx-md font-black text-phx-ink">{item.row.customerName}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
                  {[item.row.requestCode, item.row.requesterName, item.row.line].filter(Boolean).join(" · ")}
                </p>
                <p className={cn("mt-0.5 break-words text-phx-sm font-bold", item.reason === "behind" ? "text-amber-800" : "text-phx-ink-2")}>{item.words}</p>
              </div>
              <ViewSales row={item.row} viewSalesBasePath={viewSalesBasePath} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResultBadge({ row }: { row: MarketingRoiReportRow }) {
  return (
    <span className={cn("inline-flex items-center border px-2 py-0.5 text-phx-xs font-bold", ROI_RESULT_TONE[row.resultStatus])}>
      {roiResultWords(row.resultStatus)}
    </span>
  );
}

function Figure({ label, strong = false, value }: { label: string; strong?: boolean; value: string }) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <p className={cn("break-words", strong ? "font-black text-phx-ink" : "font-semibold text-phx-ink-2")}>{value}</p>
    </div>
  );
}

const ReportRow = React.memo(function ReportRow({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  const short = roiShortfallWords(row);
  const data = roiRowDataWords(row);
  return (
    <tr className="border-t border-phx-paper-2 align-top">
      <td className="px-3 py-3">
        <p className="break-words font-black leading-5 text-phx-ink">{row.customerName}</p>
        <p className="mt-1 break-words font-mono text-phx-xs font-bold text-phx-ink-soft">{row.requestCode}</p>
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{[row.requesterName, row.line].filter(Boolean).join(" · ")}</p>
      </td>
      <td className="px-3 py-3">
        <p className="break-words font-semibold text-phx-ink-2">{roiStatusWords(row.status)}</p>
        <p className="mt-1 break-words text-phx-xs font-medium text-phx-ink-soft">{row.roiWindow ?? "No window set"}</p>
        {data ? <p className="mt-1 break-words text-phx-xs font-bold text-amber-700">{data}</p> : null}
      </td>
      <td className="px-3 py-3 text-right">
        <div className="space-y-1">
          <Figure label="Required" value={roiMoney(row.requiredRoiValue)} />
          <Figure label="Forecast" value={roiMoney(row.expectedRoiValue)} />
          <Figure label="Actual" strong value={roiMoney(row.actualSalesValue)} />
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <Figure label="Actual coverage" strong value={roiRowCoverageWords(row)} />
        <p className="mt-1 text-phx-xs font-semibold text-phx-ink-soft">Forecast {roiPercent(row.forecastCoverageRatio)}</p>
      </td>
      <td className="px-3 py-3">
        <ResultBadge row={row} />
        {short ? <p className="mt-1 break-words text-phx-xs font-bold text-amber-800">{short}</p> : null}
        {row.attributionGapReason ? <p className="mt-1 break-words text-phx-xs font-medium text-phx-ink-soft">{row.attributionGapReason}</p> : null}
      </td>
      <td className="px-2 py-3 text-right">
        <ViewSales row={row} viewSalesBasePath={viewSalesBasePath} />
      </td>
    </tr>
  );
});

const ReportCard = React.memo(function ReportCard({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  const short = roiShortfallWords(row);
  const data = roiRowDataWords(row);
  return (
    <article className={cn(adminPanelClassName, "p-3")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="break-words text-phx-md font-black leading-5 text-phx-ink">{row.customerName}</h4>
          <p className="mt-1 break-words font-mono text-phx-xs font-bold text-phx-ink-soft">{row.requestCode}</p>
          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{[row.requesterName, row.line, roiStatusWords(row.status)].filter(Boolean).join(" · ")}</p>
        </div>
        <ResultBadge row={row} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-phx-sm">
        <div className={cn(adminSoftPanelClassName, "px-2.5 py-2")}>
          <Figure label="Required" value={roiMoney(row.requiredRoiValue)} />
        </div>
        <div className={cn(adminSoftPanelClassName, "px-2.5 py-2")}>
          <Figure label="Actual" strong value={roiMoney(row.actualSalesValue)} />
        </div>
        <div className={cn(adminSoftPanelClassName, "px-2.5 py-2")}>
          <Figure label="Actual coverage" strong value={roiRowCoverageWords(row)} />
          <p className="mt-0.5 text-phx-xs font-semibold text-phx-ink-soft">Forecast {roiPercent(row.forecastCoverageRatio)}</p>
        </div>
        <div className={cn(adminSoftPanelClassName, "px-2.5 py-2")}>
          <Figure label="Window" value={row.roiWindow ?? "No window set"} />
          {data ? <p className="mt-0.5 break-words text-phx-xs font-bold text-amber-700">{data}</p> : null}
        </div>
      </div>
      {short ? <p className="mt-2 break-words text-phx-sm font-bold text-amber-800">{short}</p> : null}
      {row.attributionGapReason ? <p className="mt-2 break-words text-phx-xs font-medium text-phx-ink-soft">{row.attributionGapReason}</p> : null}
      <div className="mt-3 flex justify-end">
        <ViewSales row={row} viewSalesBasePath={viewSalesBasePath} />
      </div>
    </article>
  );
});

function SortButton({ align = "left", label, onSort, sort, sortKey }: { align?: "left" | "right"; label: string; onSort: (key: RoiSortKey) => void; sort: RoiSortState; sortKey: RoiSortKey }) {
  const active = sort.key === sortKey;
  return (
    <button
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
      className={cn("inline-flex items-center gap-1 text-left font-black", align === "right" && "justify-end text-right", active ? "text-white" : "text-white/75 hover:text-white")}
      onClick={() => onSort(sortKey)}
      type="button"
    >
      {label}
      <span aria-hidden>{active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  );
}

function RequestsPanel({ report, viewSalesBasePath }: { report: MarketingRoiReport; viewSalesBasePath: string }) {
  const [sort, setSort] = React.useState<RoiSortState>(ROI_DEFAULT_SORT);
  const [pageAsked, setPageAsked] = React.useState(1);
  const sorted = React.useMemo(() => sortRoiRows(report.rows, sort), [report.rows, sort]);
  const page = roiPage(sorted.length, pageAsked);
  const visible = sorted.slice(page.start, page.end);

  function onSort(key: RoiSortKey) {
    setPageAsked(1);
    setSort((current) => nextRoiSort(current, key));
  }

  return (
    <section className={cn(adminPanelClassName, "overflow-hidden")}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
        <div>
          <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">ROI report</p>
          <h3 className="text-phx-lg font-black tracking-tight text-phx-ink">Actual against required return</h3>
        </div>
        <p className="break-words text-phx-xs font-bold text-phx-ink-soft">
          {roiPageLine(sorted.length, page)} · {roiSortLine(sort)}
        </p>
      </div>

      <div className="md:hidden">
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-center text-phx-md font-medium text-phx-ink-soft">No requests match these filters.</p>
        ) : (
          <div className="space-y-2 p-3">
            {visible.map((row) => (
              <ReportCard key={row.requestId} row={row} viewSalesBasePath={viewSalesBasePath} />
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-left text-phx-sm lg:text-phx-md">
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[17%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[16%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="bg-phx-ink text-phx-xs font-black uppercase tracking-[0.1em] text-white">
            <tr>
              <th className="px-3 py-2.5" scope="col">
                <div className="flex flex-col items-start gap-1">
                  <SortButton label="Customer" onSort={onSort} sort={sort} sortKey="customerName" />
                  <SortButton label="Request" onSort={onSort} sort={sort} sortKey="requestCode" />
                  <SortButton label="Requester" onSort={onSort} sort={sort} sortKey="requesterName" />
                </div>
              </th>
              <th className="px-3 py-2.5" scope="col">
                <div className="flex flex-col items-start gap-1">
                  <SortButton label="Status" onSort={onSort} sort={sort} sortKey="status" />
                  <SortButton label="ROI window" onSort={onSort} sort={sort} sortKey="roiWindow" />
                </div>
              </th>
              <th className="px-3 py-2.5 text-right" scope="col">
                <div className="flex flex-col items-end gap-1">
                  <SortButton align="right" label="Required" onSort={onSort} sort={sort} sortKey="requiredRoiValue" />
                  <span className="text-white/75">Forecast</span>
                  <SortButton align="right" label="Actual" onSort={onSort} sort={sort} sortKey="actualSalesValue" />
                </div>
              </th>
              <th className="px-3 py-2.5 text-right" scope="col">
                <SortButton align="right" label="Actual coverage" onSort={onSort} sort={sort} sortKey="actualCoverageRatio" />
              </th>
              <th className="px-3 py-2.5" scope="col">
                <div className="flex flex-col items-start gap-1">
                  <SortButton label="Result" onSort={onSort} sort={sort} sortKey="resultStatus" />
                  <SortButton label="Shortfall" onSort={onSort} sort={sort} sortKey="shortfall" />
                </div>
              </th>
              <th className="px-2 py-2.5 text-right" scope="col">
                Sales
              </th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {sorted.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-phx-md font-medium text-phx-ink-soft" colSpan={6}>
                  No requests match these filters.
                </td>
              </tr>
            ) : (
              visible.map((row) => <ReportRow key={row.requestId} row={row} viewSalesBasePath={viewSalesBasePath} />)
            )}
          </tbody>
        </table>
      </div>

      {page.pages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-phx-line bg-phx-paper px-4 py-3 text-phx-sm font-bold text-phx-ink-soft sm:px-5">
          <span>{roiPageLine(sorted.length, page)}</span>
          <div className="flex items-center gap-2">
            <button
              aria-label="Previous page"
              className="inline-flex h-9 w-9 items-center justify-center border border-phx-line bg-white text-phx-ink-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              disabled={page.page === 1}
              onClick={() => setPageAsked(page.page - 1)}
              type="button"
            >
              <ChevronLeft aria-hidden className="h-4 w-4" />
            </button>
            <button
              aria-label="Next page"
              className="inline-flex h-9 w-9 items-center justify-center border border-phx-line bg-white text-phx-ink-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              disabled={page.page === page.pages}
              onClick={() => setPageAsked(page.page + 1)}
              type="button"
            >
              <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The whole report: tiles, trust notes, where the requests stand, the requests to look at, and every request. */
export function RoiReportView({ report, viewSalesBasePath }: { report: MarketingRoiReport; viewSalesBasePath: string }) {
  return (
    <div className="space-y-4">
      <Tiles report={report} />
      <TrustNotes report={report} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StandingPanel report={report} />
        <LookAtPanel report={report} viewSalesBasePath={viewSalesBasePath} />
      </div>
      <RequestsPanel report={report} viewSalesBasePath={viewSalesBasePath} />
    </div>
  );
}
