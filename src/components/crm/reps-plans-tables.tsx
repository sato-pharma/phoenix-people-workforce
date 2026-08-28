"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type { RepsPlansRepRow } from "@/lib/crm/reps-plans";

// Client half of Reps Plans. Styling copies the Rep Doctor Lists tables verbatim
// (rep-doctor-lists-tables.tsx), its neighbour in the same shell — flat borders, slate-900 header
// rows, orange focus — because the two boards answer the same question about the same reps and one
// must not read as a one-off (owner's standing rule).
//
// Month and rep ride in the URL, so every change re-runs the server-side access gate rather than
// filtering a payload already in the browser.
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4. Nothing here wraps or
// ellipsises: rows are `whitespace-nowrap` and the table scrolls inside its own container.

const THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400";

/** Attainment against the rep's own target. 100% is the standard, not a stretch. */
function attainmentText(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 70) return "text-amber-700";
  return "text-rose-700";
}

function attainmentAccent(pct: number | null): "emerald" | "amber" | "rose" | "slate" {
  if (pct == null) return "slate";
  if (pct >= 100) return "emerald";
  if (pct >= 70) return "amber";
  return "rose";
}

/** Unproven runs the other way — a high share is the problem, not the achievement. */
function unprovenText(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 50) return "text-rose-700";
  if (pct >= 25) return "text-amber-700";
  return "text-emerald-700";
}

/** Rates print to 2 decimals so 1.96 never rounds up into a target it did not reach. */
function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

/** Grouped digits, same as every sibling CRM table. A rep's own counts stay small, but the card
 *  meta line carries the period's reported total, which does not. */
function count(value: number): string {
  return value.toLocaleString();
}

export function RepsPlansControls({
  appliedRepKey,
  basePath,
  month,
  repOptions,
}: {
  appliedRepKey: string | null;
  basePath: string;
  month: string;
  repOptions: Array<{ repKey: string; repName: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({ month, rep: appliedRepKey ?? "" });

  // Month and rep move TOGETHER. Pushing `?month=` on its own silently dropped the active rep on
  // the sibling board, which read as the filter having been ignored.
  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.rep) params.set("rep", next.rep);
    router.push(`${basePath}?${params.toString()}`);
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <label className="space-y-1">
        <span className={LABEL_CLASS}>Month</span>
        <input
          className={SELECT_CLASS}
          onChange={(event) => {
            const next = { ...draft, month: event.target.value };
            setDraft(next);
            if (event.target.value) push(next);
          }}
          type="month"
          value={draft.month}
        />
      </label>

      <label className="space-y-1">
        <span className={LABEL_CLASS}>Rep</span>
        <select
          className={SELECT_CLASS}
          onChange={(event) => {
            const next = { ...draft, rep: event.target.value };
            setDraft(next);
            push(next);
          }}
          value={draft.rep}
        >
          <option value="">All reps</option>
          {repOptions.map((option) => (
            <option key={option.repKey} value={option.repKey}>
              {option.repName}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1">
        <span className={LABEL_CLASS}>&nbsp;</span>
        <button
          className="h-9 w-full border border-slate-200 bg-white px-3 text-xs font-black uppercase tracking-[0.1em] text-slate-500 hover:border-orange-400 hover:text-orange-600 disabled:opacity-40"
          disabled={!draft.rep}
          onClick={() => {
            const cleared = { month: draft.month, rep: "" };
            setDraft(cleared);
            push(cleared);
          }}
          type="button"
        >
          All reps
        </button>
      </div>
    </div>
  );
}

const REP_COLS = [
  { accessor: (r: RepsPlansRepRow) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: RepsPlansRepRow) => r.am.verifiedRate, key: "amVerifiedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.am.reportedRate, key: "amReportedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.am.attainmentPct, key: "amAttainmentPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.verifiedRate, key: "pmVerifiedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.reportedRate, key: "pmReportedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.attainmentPct, key: "pmAttainmentPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.unprovenPct, key: "unprovenPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignSharePct, key: "campaignSharePct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.flaggedDays, key: "flaggedDays", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignOnlyDays, key: "campaignOnlyDays", type: "number" as const },
];

export function RepsPlansRepTable({
  campaignLimit,
  monthLabel,
  rows,
  scoredThrough,
}: {
  campaignLimit: number;
  monthLabel: string;
  rows: RepsPlansRepRow[];
  scoredThrough: string;
}) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    // Opens on the worst PM attainment, because PM is ten of the twelve calls a perfect day is made
    // of — a rep short there is short on the month whatever the AM column says.
    initialSort: { dir: "asc", key: "pmAttainmentPct" },
    searchAccessors: [(r) => r.repName, (r) => r.agentHrId ?? ""],
  });

  const exportRows = table.rows.map((row) => ({
    am_proved: row.am.verifiedRate,
    am_reported: row.am.reportedRate,
    am_pct: row.am.attainmentPct,
    campaign_calls: row.campaignCalls,
    campaign_only_days: row.campaignOnlyDays,
    campaign_share: row.campaignSharePct,
    flagged_days: row.flaggedDays,
    hr_id: row.agentHrId ?? "",
    pm_proved: row.pm.verifiedRate,
    pm_reported: row.pm.reportedRate,
    pm_pct: row.pm.attainmentPct,
    rep: row.repName,
    unproven: row.unprovenPct,
    unspecified: row.unspecified,
    working_days: row.workingDays,
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search rep…" value={table.query} />
        {/* The export carries BOTH rates. Shipping only the proved one would leave the reader of the
            file unable to see the gap this page exists to show, and shipping only the reported one
            would export the very number that cannot be trusted. */}
        <ExportXlsxButton
          columns={[
            { key: "rep", label: "Rep" },
            { key: "hr_id", label: "HR ID" },
            { key: "working_days", label: "Working Days", numeric: true },
            { key: "am_proved", label: "AM Proved Rate", numeric: true },
            { key: "am_reported", label: "AM Reported Rate", numeric: true },
            { key: "am_pct", label: "AM % Of Target", numeric: true },
            { key: "pm_proved", label: "PM Proved Rate", numeric: true },
            { key: "pm_reported", label: "PM Reported Rate", numeric: true },
            { key: "pm_pct", label: "PM % Of Target", numeric: true },
            { key: "unproven", label: "Unproven %", numeric: true },
            { key: "campaign_calls", label: "Campaign Calls", numeric: true },
            { key: "campaign_share", label: "Campaign Share %", numeric: true },
            { key: "flagged_days", label: `Days Over ${campaignLimit}`, numeric: true },
            { key: "campaign_only_days", label: "Days With No Proof", numeric: true },
            { key: "unspecified", label: "No AM/PM Flag", numeric: true },
          ]}
          rows={exportRows}
          sheetName="Reps Plans"
          subtitle={`${monthLabel} · scored through ${scoredThrough}`}
          title="Reps Plans — split call rate by rep"
        />
      </div>

      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            No rep recorded field work in this period.
          </p>
        }
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={attainmentAccent(row.pm.attainmentPct)}
            meta={`${count(row.workingDays)} working days · ${count(row.reportedCalls)} calls reported, ${count(row.verifiedCalls)} proved`}
            // Both rates sit in the badge, labelled. Neither answers the owner's question alone: AM
            // is the two accounts, PM is the ten clinics, and a rep can clear one and miss the other.
            status={
              <span className="flex items-start gap-3">
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${attainmentText(row.am.attainmentPct)}`}>
                    {rate(row.am.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                    AM of {row.am.target}
                  </span>
                </span>
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${attainmentText(row.pm.attainmentPct)}`}>
                    {rate(row.pm.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                    PM of {row.pm.target}
                  </span>
                </span>
              </span>
            }
            title={row.repName}
          >
            <PortalRecordFields
              fields={[
                {
                  label: "AM reported",
                  value: <span className="whitespace-nowrap text-slate-500">{rate(row.am.reportedRate)}</span>,
                },
                {
                  label: "PM reported",
                  value: <span className="whitespace-nowrap text-slate-500">{rate(row.pm.reportedRate)}</span>,
                },
                {
                  label: "Unproven",
                  value: <span className={unprovenText(row.unprovenPct)}>{pct(row.unprovenPct)}</span>,
                },
                {
                  label: "Campaign",
                  value: (
                    <span className="whitespace-nowrap">
                      <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>{count(row.campaignCalls)}</span>
                      <span className="text-slate-300"> · </span>
                      <span className="text-slate-500">{row.campaignSharePct}%</span>
                    </span>
                  ),
                },
                {
                  label: `Days over ${campaignLimit}`,
                  value: <span className={row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}>{count(row.flaggedDays)}</span>,
                },
                {
                  label: "Days with no proof",
                  value: (
                    <span className={row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}>
                      {count(row.campaignOnlyDays)}
                    </span>
                  ),
                },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1460px">
            <thead>
              {/* Two header rows: the session groups above, the measures below. AM and PM are
                  different KPIs against different targets, and a single flat row of twelve headings
                  invites reading a PM figure against the AM target. */}
              <tr className="bg-slate-900 text-left">
                <th className={THEAD} rowSpan={2} scope="col">
                  Rep
                </th>
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={3} scope="colgroup">
                  AM — target 2 / day
                </th>
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={3} scope="colgroup">
                  PM — target 10 / day
                </th>
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={5} scope="colgroup">
                  Proof
                </th>
              </tr>
              <tr className="bg-slate-900 text-left">
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-emerald-300`}
                  label="Proved"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amVerifiedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-slate-400`}
                  label="Reported"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amReportedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right`}
                  label="% Target"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amAttainmentPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-emerald-300`}
                  label="Proved"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmVerifiedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-slate-400`}
                  label="Reported"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmReportedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right`}
                  label="% Target"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmAttainmentPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-rose-300`}
                  label="Unproven"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="unprovenPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-sky-300`}
                  label="Campaign"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignCalls"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-sky-300`}
                  label="Campaign %"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignSharePct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-rose-300`}
                  label={`Days Over ${campaignLimit}`}
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="flaggedDays"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-amber-300`}
                  label="Days No Proof"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignOnlyDays"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-black ${attainmentText(row.am.attainmentPct)}`}>
                    {rate(row.am.verifiedRate)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">{rate(row.am.reportedRate)}</td>
                  <td className={`px-3 py-2 text-right font-bold ${attainmentText(row.am.attainmentPct)}`}>
                    {pct(row.am.attainmentPct)}
                  </td>
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-black ${attainmentText(row.pm.attainmentPct)}`}>
                    {rate(row.pm.verifiedRate)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">{rate(row.pm.reportedRate)}</td>
                  <td className={`px-3 py-2 text-right font-bold ${attainmentText(row.pm.attainmentPct)}`}>
                    {pct(row.pm.attainmentPct)}
                  </td>
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-bold ${unprovenText(row.unprovenPct)}`}>
                    {pct(row.unprovenPct)}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}>
                    {count(row.campaignCalls)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${row.campaignSharePct >= 50 ? "text-sky-700" : "text-slate-400"}`}>
                    {row.campaignSharePct}%
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {count(row.flaggedDays)}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {count(row.campaignOnlyDays)}
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
