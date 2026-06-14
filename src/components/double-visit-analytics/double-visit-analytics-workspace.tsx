"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Flame,
  MapPinned,
  RefreshCcw,
  Upload,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DoubleVisitDashboardData, DoubleVisitImportListItem } from "@/lib/double-visit-analytics/types";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function statusClass(status: "critical" | "healthy" | "warning") {
  if (status === "healthy") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "warning") return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-rose-50 text-rose-700 ring-rose-200";
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  hint: string;
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
        </div>
        <span className="grid h-10 w-10 place-items-center rounded bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-xs font-semibold text-slate-500">{hint}</p>
    </div>
  );
}

function ImportRow({
  item,
  onPublish,
  publishingId,
}: {
  item: DoubleVisitImportListItem;
  onPublish: (id: string) => void;
  publishingId: string | null;
}) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-3 text-sm font-semibold text-slate-800">{item.sourceFilename}</td>
      <td className="px-3 py-3 text-sm text-slate-600">{item.sourceType}</td>
      <td className="px-3 py-3 text-sm text-slate-600">{formatDate(item.dateFrom)} - {formatDate(item.dateTo)}</td>
      <td className="px-3 py-3 text-sm font-semibold text-slate-800">{formatNumber(item.totalVisits)}</td>
      <td className="px-3 py-3">
        <span className={[
          "rounded px-2 py-1 text-xs font-black uppercase",
          item.status === "published" ? "bg-emerald-50 text-emerald-700" : item.status === "superseded" ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-700",
        ].join(" ")}>
          {item.status}
        </span>
      </td>
      <td className="px-3 py-3 text-right">
        <Button
          className="min-h-9 rounded border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-50"
          disabled={item.status === "published" || publishingId === item.id}
          onClick={() => onPublish(item.id)}
          type="button"
        >
          {publishingId === item.id ? "Publishing" : "Publish"}
        </Button>
      </td>
    </tr>
  );
}

export function DoubleVisitAnalyticsWorkspace({
  canImport,
  canPublish,
  dashboard,
  ireports360Configured,
}: {
  canImport: boolean;
  canPublish: boolean;
  dashboard: DoubleVisitDashboardData;
  ireports360Configured: boolean;
}) {
  const [dateFrom, setDateFrom] = useState(dashboard.dateFrom);
  const [dateTo, setDateTo] = useState(dashboard.dateTo);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const criticalMrs = useMemo(() => dashboard.mrScores.filter((score) => score.band === "critical"), [dashboard.mrScores]);
  const weakMrs = useMemo(() => dashboard.mrScores.filter((score) => score.band !== "healthy"), [dashboard.mrScores]);

  async function uploadExcel() {
    if (!file) {
      setMessage("Select a Double Visit Excel file first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/admin/double-visit-analytics/imports/excel", { body: formData, method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Excel import failed.");
        return;
      }
      setMessage(`Preview saved: ${formatNumber(payload.data.preview.summary.totalVisits)} visits, ${formatNumber(payload.data.preview.summary.vacantOrUnmappedVisitCount)} vacant/unmapped visits preserved.`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Excel import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function importLive() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/double-visit-analytics/imports/ireports360", {
        body: JSON.stringify({ dateFrom, dateTo }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "iReports360 import failed.");
        return;
      }
      setMessage(`Live preview saved: ${formatNumber(payload.data.preview.summary.totalVisits)} double visits.`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "iReports360 import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function publish(id: string) {
    setPublishingId(id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/double-visit-analytics/imports/${id}/publish`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Publish failed.");
        return;
      }
      setMessage("Published as official Double Visit snapshot.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setPublishingId(null);
    }
  }

  const exportHref = `/api/admin/double-visit-analytics/export?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-700">Field performance evidence</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Double Visit Analytics</h1>
          <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
            Role-neutral double visit evidence for coaching coverage, neglected MRs, area/line heat, and expense AM/PM workload automation.
          </p>
        </div>
        <a href={exportHref}>
          <Button className="min-h-11 gap-2 rounded bg-slate-950 px-4 text-white hover:bg-slate-800" type="button">
            <Download className="h-4 w-4" />
            Executive Excel
          </Button>
        </a>
      </div>

      {message ? (
        <div className="rounded border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm">
          {message}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-950">Official snapshot</h2>
              <p className="text-sm font-medium text-slate-500">
                Dashboards and expense automation use the published snapshot only.
              </p>
            </div>
            <Badge variant={dashboard.publishedImport ? "success" : "warning"}>
              {dashboard.publishedImport ? "Published" : "No published snapshot"}
            </Badge>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">From</span>
              <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">To</span>
              <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>
            <div className="flex items-end">
              <Button className="min-h-10 w-full gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50" onClick={() => window.location.assign(`/admin/double-visit-analytics?dateFrom=${dateFrom}&dateTo=${dateTo}`)} type="button">
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
          {!dashboard.schemaReady ? (
            <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
              Double Visit Analytics tables are not provisioned in this environment. Apply migration 20260612172427_double_visit_analytics.sql and reopen this page.
            </p>
          ) : (
            <p className="mt-4 text-sm font-semibold text-slate-600">
              {dashboard.publishedImport
                ? `${dashboard.publishedImport.sourceFilename} published for ${formatDate(dashboard.publishedImport.dateFrom)} - ${formatDate(dashboard.publishedImport.dateTo)}`
                : "Import and publish a snapshot before KPI and expense evidence can be populated."}
            </p>
          )}
        </Card>

        <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">Import evidence</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">Excel and live iReports360 imports are saved as previews first.</p>
          <div className="mt-4 grid gap-3">
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-sky-300 bg-sky-50 px-4 text-sm font-bold text-sky-700">
              <Upload className="h-4 w-4" />
              {file ? file.name : "Select Excel DV file"}
              <input className="hidden" type="file" accept=".xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            </label>
            <Button className="min-h-11 gap-2 rounded bg-sky-600 px-4 text-white hover:bg-sky-700" disabled={!canImport || busy || !dashboard.schemaReady} onClick={() => void uploadExcel()} type="button">
              <FileSpreadsheet className="h-4 w-4" />
              Save Excel Preview
            </Button>
            <Button className="min-h-11 gap-2 rounded border border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-50" disabled={!canImport || !ireports360Configured || busy || !dashboard.schemaReady} onClick={() => void importLive()} type="button">
              <Activity className="h-4 w-4" />
              Import Live iReports360
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={Activity} label="Double Visits" value={formatNumber(dashboard.kpis.totalVisits)} hint="Official visit count from Count/source event." />
        <KpiCard icon={CalendarDays} label="Active DV Days" value={formatNumber(dashboard.kpis.activeDoubleVisitDays)} hint="Distinct double visitor and date combinations." />
        <KpiCard icon={UsersRound} label="MR Coverage" value={formatNumber(dashboard.kpis.mrCoverageCount)} hint="Mapped MRs with at least one DV in range." />
        <KpiCard icon={AlertTriangle} label="Vacant/Unmapped Share" value={`${dashboard.kpis.vacantOrUnmappedShare}%`} hint="Preserved records; still counted as field effort." />
        <KpiCard icon={Activity} label="AM Activity" value={formatNumber(dashboard.kpis.amVisitCount)} hint="Morning double visit workload." />
        <KpiCard icon={Activity} label="PM Activity" value={formatNumber(dashboard.kpis.pmVisitCount)} hint="Afternoon double visit workload." />
        <KpiCard icon={CheckCircle2} label="Avg per DV Day" value={formatNumber(dashboard.kpis.averageVisitsPerDoubleVisitDay)} hint="Visits divided by active double visit days." />
        <KpiCard icon={Flame} label="Neglected MRs" value={formatNumber(weakMrs.length)} hint={`${criticalMrs.length} critical by 30/60/90 rule.`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
          <div className="border-b border-slate-100 p-5">
            <h2 className="text-lg font-black text-slate-950">Executive coverage gaps</h2>
            <p className="text-sm font-medium text-slate-500">Expected MRs vs actually touched MRs by reporting hierarchy.</p>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[780px] text-left">
              <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-3">Manager</th><th className="px-3 py-3">Expected</th><th className="px-3 py-3">Touched</th><th className="px-3 py-3">Neglected</th><th className="px-3 py-3">Over-focused</th><th className="px-3 py-3">Concentration</th></tr>
              </thead>
              <tbody>
                {dashboard.executiveReports.slice(0, 40).map((row) => (
                  <tr key={row.managerHrId} className="border-t border-slate-100">
                    <td className="px-3 py-3 text-sm font-semibold text-slate-800">{row.managerName}<div className="text-xs text-slate-500">{row.areaName ?? "No area"} - {row.lineName ?? "No line"}</div></td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.expectedMrCount}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.touchedMrCount} ({row.touchedPercent}%)</td>
                    <td className="px-3 py-3 text-sm font-bold text-rose-700">{row.neglectedMrCount}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.overFocusedMrCount}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{formatNumber(row.concentrationRatio * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
          <div className="border-b border-slate-100 p-5">
            <h2 className="text-lg font-black text-slate-950">MR support score</h2>
            <p className="text-sm font-medium text-slate-500">Last DV, days since coaching support, 90-day frequency, and visitor diversity.</p>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-3">MR</th><th className="px-3 py-3">Last DV</th><th className="px-3 py-3">Days</th><th className="px-3 py-3">90 Days</th><th className="px-3 py-3">Visitors</th><th className="px-3 py-3">Band</th></tr>
              </thead>
              <tbody>
                {dashboard.mrScores.slice(0, 80).map((row) => (
                  <tr key={row.hrId} className="border-t border-slate-100">
                    <td className="px-3 py-3 text-sm font-semibold text-slate-800">{row.mrName}<div className="text-xs text-slate-500">{row.hrId} - {row.areaName ?? "No area"} - {row.managerName ?? "No manager"}</div></td>
                    <td className="px-3 py-3 text-sm text-slate-700">{formatDate(row.lastDvDate)}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.daysSinceLastDv ?? "Never"}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.dvsLast90Days}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{row.distinctDoubleVisitors}</td>
                    <td className="px-3 py-3"><span className={`rounded px-2 py-1 text-xs font-black uppercase ring-1 ${statusClass(row.band)}`}>{row.band}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><MapPinned className="h-5 w-5" /> Area heatmap</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">Coverage is calculated from active MRs in scope and includes scope areas with no visits as 0%.</p>
          <div className="mt-4 grid gap-2">
            {dashboard.heatmap.byArea.slice(0, 16).map((row) => (
              <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_110px_90px] items-center gap-3 rounded border border-slate-100 px-3 py-2">
                <span className="truncate text-sm font-semibold text-slate-800">{row.label}</span>
                <span className={`rounded px-2 py-1 text-center text-xs font-black uppercase ring-1 ${statusClass(row.status ?? "critical")}`}>{row.coveragePercent ?? 0}%</span>
                <span className="text-right text-sm font-semibold text-slate-700">{row.totalVisits} DVs</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><MapPinned className="h-5 w-5" /> Line heatmap</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">Coverage is calculated from active MRs in scope and shows every scoped line, even when no DV activity exists.</p>
          <div className="mt-4 grid gap-2">
            {dashboard.heatmap.byLine.slice(0, 16).map((row) => (
              <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_110px_90px] items-center gap-3 rounded border border-slate-100 px-3 py-2">
                <span className="truncate text-sm font-semibold text-slate-800">{row.label}</span>
                <span className={`rounded px-2 py-1 text-center text-xs font-black uppercase ring-1 ${statusClass(row.status ?? "critical")}`}>{row.coveragePercent ?? 0}%</span>
                <span className="text-right text-sm font-semibold text-slate-700">{row.totalVisits} DVs</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
        <div className="border-b border-slate-100 p-5">
          <h2 className="text-lg font-black text-slate-950">Import history</h2>
          <p className="text-sm font-medium text-slate-500">Publish exactly one official snapshot for dashboards and expense automation.</p>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-3">File</th><th className="px-3 py-3">Source</th><th className="px-3 py-3">Range</th><th className="px-3 py-3">Visits</th><th className="px-3 py-3">Status</th><th className="px-3 py-3 text-right">Action</th></tr>
            </thead>
              <tbody>
                {dashboard.imports.map((item) => (
                  <ImportRow
                    key={item.id}
                    item={item}
                    publishingId={publishingId}
                    onPublish={canPublish && dashboard.schemaReady ? (id) => void publish(id) : () => undefined}
                  />
                ))}
              </tbody>
            </table>
        </div>
      </Card>
    </div>
  );
}
