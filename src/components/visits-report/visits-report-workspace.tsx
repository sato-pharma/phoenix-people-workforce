"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type { VisitsReportData } from "@/lib/visits-report/types";

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function SyncStatusPanel({ data }: { data: VisitsReportData }) {
  const [backfillFrom, setBackfillFrom] = useState(data.dateFrom);
  const [backfillTo, setBackfillTo] = useState(data.dateTo);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function runBackfill() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/visits-report/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom: backfillFrom, dateTo: backfillTo }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Backfill failed.");
      } else {
        setMessage(`Pulled ${payload.rowsFetched} visits, upserted ${payload.rowsUpserted}.`);
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backfill failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Sync Status</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>

      {!data.configured && (
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          iReports360 is not configured (missing IREPORTS360_BASE_URL/USERNAME/PASSWORD) — the scheduled sync cannot run.
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {data.latestSyncRuns.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No sync runs recorded yet.</p>
        ) : (
          data.latestSyncRuns.map((run) => (
            <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <div className="flex items-center gap-2">
                {run.status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : run.status === "failed" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                ) : (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
                )}
                <div>
                  <p className="font-semibold text-slate-900">
                    {run.trigger === "cron" ? "Scheduled sync" : run.trigger === "manual_backfill" ? "Manual backfill" : "Manual sync"}
                    {" · "}
                    {formatDate(run.dateFrom)} – {formatDate(run.dateTo)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Started {formatDateTime(run.startedAt)}
                    {run.status !== "running" && ` · finished ${formatDateTime(run.completedAt)}`}
                  </p>
                  {run.status === "failed" && run.errorMessage && (
                    <p className="mt-1 text-[11px] font-medium text-rose-600">{run.errorMessage}</p>
                  )}
                </div>
              </div>
              {run.status === "success" && (
                <span className="shrink-0 text-xs font-bold text-slate-700">
                  {run.rowsFetched} fetched · {run.rowsUpserted} upserted
                </span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 bg-slate-50 px-5 py-3">
        <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Backfill from
          <input type="date" value={backfillFrom} onChange={(event) => setBackfillFrom(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          to
          <input type="date" value={backfillTo} onChange={(event) => setBackfillTo(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm" />
        </label>
        <button
          type="button"
          onClick={runBackfill}
          disabled={busy || !data.configured}
          className="inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          Run backfill (max 45 days/request)
        </button>
        {message && <p className="text-xs font-medium text-slate-600">{message}</p>}
      </div>
    </div>
  );
}

export function VisitsReportWorkspace({ data }: { data: VisitsReportData }) {
  const router = useRouter();
  const pathname = usePathname();
  const [dateFrom, setDateFrom] = useState(data.dateFrom);
  const [dateTo, setDateTo] = useState(data.dateTo);
  const [agent, setAgent] = useState("");

  function applyFilters(overrides?: { page?: number }) {
    const params = new URLSearchParams({
      dateFrom,
      dateTo,
      page: String(overrides?.page ?? 1),
      pageSize: String(data.pageSize),
    });
    if (agent) params.set("agent", agent);
    router.push(`${pathname}?${params.toString()}`);
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));

  const exportColumns: ExportColumn[] = [
    { key: "date", label: "Date" },
    { key: "agent", label: "Agent" },
    { key: "double", label: "Double Visitor" },
    { key: "contact", label: "Contact" },
    { key: "type", label: "Visit Type" },
    { key: "ampm", label: "AM/PM" },
    { key: "comment", label: "Comment" },
  ];
  const exportRows: ExportRow[] = data.rows.map((row) => ({
    date: row.visitDate,
    agent: `${row.agentName ?? "—"} (${row.agentHrId ?? "unmapped"})`,
    double: row.doubleName ? `${row.doubleName} (${row.doubleHrId ?? "unmapped"})` : "—",
    contact: row.contactName ?? row.customerName ?? "—",
    type: row.visitTypeDescription ?? String(row.visitType ?? "—"),
    ampm: row.ampm ?? "—",
    comment: row.comment ?? "",
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Data governance</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Visits Report</h1>
          <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
            A full mirror of every visit iReports360 has recorded — solo calls, campaign visits, double visits, and leave/vacation
            entries — synced automatically 3x daily. {data.totalCount} visits in the selected range.
          </p>
        </div>
        <ExportXlsxButton title="Visits Report" subtitle={`${data.dateFrom} to ${data.dateTo} · page ${data.page}`} sheetName="Visits" columns={exportColumns} rows={exportRows} />
      </div>

      <SyncStatusPanel data={data} />

      {!data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          ireports360_visits table is not provisioned yet.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-4 py-3">
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              From
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              To
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Agent
              <select value={agent} onChange={(event) => setAgent(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                <option value="">All agents</option>
                {data.filters.agents.map((agentOption) => (
                  <option key={agentOption.hrId} value={agentOption.hrId}>{agentOption.name}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => applyFilters()} className="h-9 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]">
              Apply
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Date</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Agent</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Double Visitor</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Contact</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Type</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">AM/PM</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Comment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {data.rows.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">No visits in this range.</td></tr>
                ) : (
                  data.rows.map((row, index) => (
                    <tr key={row.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="whitespace-nowrap px-3 py-2.5">{formatDate(row.visitDate)}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{row.agentName ?? "—"}</p>
                        <p className={cn("text-[11px]", row.agentHrId ? "text-slate-400" : "text-rose-500")}>{row.agentHrId ?? "unmapped"}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {row.doubleName ? (
                          <>
                            <p className="font-medium text-slate-900">{row.doubleName}</p>
                            <p className={cn("text-[11px]", row.doubleHrId ? "text-slate-400" : "text-rose-500")}>{row.doubleHrId ?? "unmapped"}</p>
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{row.contactName ?? row.customerName ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{row.visitTypeDescription ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.ampm ?? "—"}</td>
                      <td className="max-w-[360px] px-3 py-2.5 text-[13px] text-slate-600" style={{ whiteSpace: "pre-wrap" }}>{row.comment ?? ""}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border border-slate-200 bg-white px-4 py-3 text-sm">
            <span className="text-slate-500">
              Page {data.page} of {totalPages} · {data.totalCount} total visits
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => applyFilters({ page: data.page - 1 })}
                className="h-9 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={data.page >= totalPages}
                onClick={() => applyFilters({ page: data.page + 1 })}
                className="h-9 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
