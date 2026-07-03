"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCcw, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { downloadXlsxExport } from "@/lib/export/download-xlsx-client";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type {
  UnmappedCrmIdentityRow,
  UnmappedCrmResolutionAction,
  VisitsMappingStatus,
  VisitsReportData,
  VisitsReportRow,
} from "@/lib/visits-report/types";

const RESOLUTION_OPTIONS: Array<{ label: string; value: UnmappedCrmResolutionAction }> = [
  { label: "Keep Pending", value: "pending" },
  { label: "Mark Resigned", value: "resigned" },
  { label: "Map to HR ID…", value: "mapped" },
];

const ALL = "";

const MAPPING_STATUS_OPTIONS: Array<{ label: string; value: VisitsMappingStatus | "" }> = [
  { label: "All mapping statuses", value: ALL },
  { label: "Agent unmapped", value: "agent_unmapped" },
  { label: "Double visitor unmapped", value: "double_unmapped" },
  { label: "Either unmapped", value: "either_unmapped" },
  { label: "Fully mapped", value: "fully_mapped" },
];

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const exportColumns: ExportColumn[] = [
  { key: "date", label: "Date" },
  { key: "agent", label: "Agent" },
  { key: "agentHrId", label: "Agent HR ID" },
  { key: "double", label: "Double Visitor" },
  { key: "doubleHrId", label: "Double HR ID" },
  { key: "contact", label: "Contact" },
  { key: "type", label: "Visit Type" },
  { key: "ampm", label: "AM/PM" },
  { key: "checkinTime", label: "Nearest Check-in Time" },
  { key: "checkinAddress", label: "Nearest Check-in Location" },
  { key: "comment", label: "Comment" },
];

function toExportRow(row: VisitsReportRow): ExportRow {
  return {
    date: row.visitDate,
    agent: row.agentName ?? "—",
    agentHrId: row.agentHrId ?? "unmapped",
    double: row.doubleName ?? "—",
    doubleHrId: row.doubleName ? (row.doubleHrId ?? "unmapped") : "—",
    contact: row.contactName ?? row.customerName ?? "—",
    type: row.visitTypeDescription ?? String(row.visitType ?? "—"),
    ampm: row.ampm ?? "—",
    checkinTime: row.nearestCheckinTime ? formatDateTime(row.nearestCheckinTime) : "No check-in that day",
    checkinAddress: row.nearestCheckinAddress ?? "—",
    comment: row.comment ?? "",
  };
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
        setMessage(
          `Pulled ${payload.rowsFetched} visits (${payload.rowsUpserted} upserted) and ${payload.checkinsFetched ?? 0} check-ins (${payload.checkinsUpserted ?? 0} upserted).`,
        );
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

function ExportButton({ data, search, agent, visitType, ampm, mappingStatus }: {
  agent: string;
  ampm: string;
  data: VisitsReportData;
  mappingStatus: string;
  search: string;
  visitType: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleExport() {
    setBusy(true);
    setMessage(null);
    try {
      const params = new URLSearchParams({ dateFrom: data.dateFrom, dateTo: data.dateTo });
      if (agent) params.set("agent", agent);
      if (search) params.set("search", search);
      if (visitType) params.set("visitType", visitType);
      if (ampm) params.set("ampm", ampm);
      if (mappingStatus) params.set("mappingStatus", mappingStatus);

      const response = await fetch(`/api/admin/visits-report/export?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Export failed.");
        return;
      }
      const rows: VisitsReportRow[] = payload.rows;
      if (rows.length === 0) {
        setMessage("Nothing to export for this filter.");
        return;
      }
      await downloadXlsxExport({
        title: "Visits Report",
        subtitle: `${data.dateFrom} to ${data.dateTo} · ${payload.totalCount} matching visits`,
        sheetName: "Visits",
        columns: exportColumns,
        rows: rows.map(toExportRow),
      });
      if (payload.truncated) {
        setMessage(`Exported the first ${rows.length} of ${payload.totalCount} matching visits — narrow the date range to get the rest.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={busy}
        className="inline-flex h-9 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        Export XLSX (full filtered result)
      </button>
      {message && <p className="max-w-xs text-right text-[11px] font-medium text-amber-700">{message}</p>}
    </div>
  );
}

function ResolutionCell({
  identity,
  onResolved,
}: {
  identity: UnmappedCrmIdentityRow;
  onResolved: (crmId: number, message: string) => void;
}) {
  const [action, setAction] = useState<UnmappedCrmResolutionAction>("pending");
  const [hrIdInput, setHrIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmedHrId = hrIdInput.trim();
    if (action === "mapped" && !trimmedHrId) {
      setError("Enter an HR ID to map this identity.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/visits-report/resolve-identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          crmId: identity.crmId,
          crmName: identity.name,
          mappedHrId: action === "mapped" ? trimmedHrId : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        setError(payload.message ?? "Failed to save.");
        return;
      }
      const message =
        action === "mapped"
          ? `Mapped ${payload.updatedVisits} visit${payload.updatedVisits === 1 ? "" : "s"} to ${payload.resolvedEmployeeHrId} (${payload.resolvedEmployeeName}).`
          : action === "resigned"
            ? `Marked ${identity.name} as resigned — hidden from this list.`
            : `Kept ${identity.name} pending.`;
      onResolved(identity.crmId, message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value as UnmappedCrmResolutionAction);
            setError(null);
          }}
          className="h-8 border border-[#D8E0EA] bg-white px-2 text-xs text-slate-700"
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {action === "mapped" && (
          <input
            type="text"
            value={hrIdInput}
            onChange={(event) => setHrIdInput(event.target.value)}
            placeholder="e.g. B-82"
            className="h-8 w-24 border border-[#D8E0EA] bg-white px-2 text-xs text-slate-800"
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-8 items-center gap-1.5 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
      </div>
      {error && <p className="text-[11px] font-medium text-rose-600">{error}</p>}
    </div>
  );
}

function UnmappedAgentsPanel({ identities, pathname }: { identities: UnmappedCrmIdentityRow[]; pathname: string }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(identities);
  const [toast, setToast] = useState<string | null>(null);

  function handleResolved(crmId: number, message: string) {
    setRows((current) => current.filter((identity) => identity.crmId !== crmId));
    setToast(message);
  }

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((identity) => identity.name.toLowerCase().includes(term) || String(identity.crmId).includes(term))
    : rows;

  function viewInLog(identity: UnmappedCrmIdentityRow) {
    const params = new URLSearchParams({
      tab: "log",
      dateFrom: identity.firstSeen,
      dateTo: identity.lastSeen,
      agent: identity.name,
      mappingStatus: "either_unmapped",
    });
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
        <p className="text-sm font-medium text-slate-600">
          {rows.length} unmapped CRM {rows.length === 1 ? "identity" : "identities"} across the full visit history — resolve
          each one as <span className="font-semibold text-slate-900">Resigned</span> (hide it),{" "}
          <span className="font-semibold text-slate-900">Map to HR ID</span> (fix it now and going forward), or{" "}
          <span className="font-semibold text-slate-900">Keep Pending</span>.
        </p>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by CRM name or ID…"
            className="h-9 w-full border border-[#D8E0EA] bg-white pl-8 pr-2 text-sm text-slate-800"
          />
        </div>
      </div>

      {toast && (
        <div className="flex items-center justify-between border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
          {toast}
          <button type="button" onClick={() => setToast(null)} className="text-emerald-700 hover:text-emerald-900">Dismiss</button>
        </div>
      )}

      <div className="overflow-x-auto border border-slate-200 bg-white">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-slate-900">
            <tr>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM ID</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">CRM Name</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Seen As</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Unmapped Visits</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">First Seen</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Last Seen</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Resolution</th>
              <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-orange-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">
                  {rows.length === 0 ? "No unmapped CRM identities — everyone maps to an HR ID." : "No identities match this search."}
                </td>
              </tr>
            ) : (
              filtered.map((identity) => (
                <tr key={identity.crmId} className="odd:bg-white even:bg-orange-50/30">
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">{identity.crmId}</td>
                  <td className="px-3 py-2.5 font-medium text-slate-900">{identity.name}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{identity.roles.join(" + ")}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-rose-500">{identity.visitCount}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{formatDate(identity.firstSeen)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">{formatDate(identity.lastSeen)}</td>
                  <td className="px-3 py-2.5">
                    <ResolutionCell identity={identity} onResolved={handleResolved} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => viewInLog(identity)}
                      className="h-8 border border-[#D8E0EA] bg-white px-2.5 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
                    >
                      View in Visit Log
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VisitsReportWorkspace({
  data,
  tab,
  unmappedIdentities,
  initialFilters,
}: {
  data: VisitsReportData;
  initialFilters: { agent: string; ampm: string; mappingStatus: string; search: string; visitType: string };
  tab: "log" | "unmapped";
  unmappedIdentities: UnmappedCrmIdentityRow[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [dateFrom, setDateFrom] = useState(data.dateFrom);
  const [dateTo, setDateTo] = useState(data.dateTo);
  const [agent, setAgent] = useState(initialFilters.agent);
  const [search, setSearch] = useState(initialFilters.search);
  const [visitType, setVisitType] = useState(initialFilters.visitType);
  const [ampm, setAmpm] = useState(initialFilters.ampm);
  const [mappingStatus, setMappingStatus] = useState(initialFilters.mappingStatus);

  function switchTab(nextTab: "log" | "unmapped") {
    router.push(`${pathname}?tab=${nextTab}`);
  }

  function applyFilters(overrides?: { page?: number }) {
    const params = new URLSearchParams({
      dateFrom,
      dateTo,
      page: String(overrides?.page ?? 1),
      pageSize: String(data.pageSize),
    });
    if (agent) params.set("agent", agent);
    if (search) params.set("search", search);
    if (visitType) params.set("visitType", visitType);
    if (ampm) params.set("ampm", ampm);
    if (mappingStatus) params.set("mappingStatus", mappingStatus);
    router.push(`${pathname}?${params.toString()}`);
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Data governance</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Visits Report</h1>
          <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
            A full mirror of every visit iReports360 has recorded — solo calls, campaign visits, double visits, and leave/vacation
            entries — synced automatically 3x daily, with a best-effort GPS check-in match per visit. {data.totalCount} visits in the
            selected range.
          </p>
        </div>
        {tab === "log" && (
          <ExportButton data={data} search={search} agent={agent} visitType={visitType} ampm={ampm} mappingStatus={mappingStatus} />
        )}
      </div>

      <div className="flex gap-2 border-b border-slate-200">
        <button
          type="button"
          onClick={() => switchTab("log")}
          className={cn(
            "border-b-2 px-1 pb-2 text-sm font-bold uppercase tracking-wide transition",
            tab === "log" ? "border-orange-500 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-800",
          )}
        >
          Visit Log
        </button>
        <button
          type="button"
          onClick={() => switchTab("unmapped")}
          className={cn(
            "border-b-2 px-1 pb-2 text-sm font-bold uppercase tracking-wide transition",
            tab === "unmapped" ? "border-orange-500 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-800",
          )}
        >
          Unmapped Agents
        </button>
      </div>

      <SyncStatusPanel data={data} />

      {tab === "unmapped" ? (
        <UnmappedAgentsPanel identities={unmappedIdentities} pathname={pathname} />
      ) : !data.schemaReady ? (
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
            <label className="flex w-56 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Agent
              <SearchableSelect value={agent} onValueChange={setAgent} placeholder="All agents">
                <option value="">All agents</option>
                {data.filters.agents.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </SearchableSelect>
            </label>
            <label className="flex w-48 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Visit type
              <SearchableSelect value={visitType} onValueChange={setVisitType} placeholder="All visit types">
                <option value="">All visit types</option>
                {data.filters.visitTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              AM/PM
              <select value={ampm} onChange={(event) => setAmpm(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                <option value="">All</option>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Mapping status
              <select value={mappingStatus} onChange={(event) => setMappingStatus(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                {MAPPING_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Search
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Agent, contact, comment…"
                  className="h-9 w-full border border-[#D8E0EA] bg-white pl-8 pr-2 text-sm text-slate-800"
                />
              </div>
            </label>
            <button type="button" onClick={() => applyFilters()} className="h-9 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]">
              Apply
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full min-w-[1500px] text-left text-sm">
              <thead className="bg-slate-900">
                <tr>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Date</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Agent</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Agent HR ID</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Double Visitor</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Double HR ID</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Contact</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Type</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">AM/PM</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Check-in</th>
                  <th className="px-3 py-3 text-[10px] font-black uppercase tracking-wider text-slate-300">Comment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {data.rows.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-slate-500">No visits match these filters.</td></tr>
                ) : (
                  data.rows.map((row, index) => (
                    <tr key={row.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="whitespace-nowrap px-3 py-2.5">{formatDate(row.visitDate)}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{row.agentName ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={cn("font-semibold", row.agentHrId ? "text-slate-700" : "text-rose-500")}>{row.agentHrId ?? "unmapped"}</span>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{row.doubleName ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {row.doubleName ? (
                          <span className={cn("font-semibold", row.doubleHrId ? "text-slate-700" : "text-rose-500")}>{row.doubleHrId ?? "unmapped"}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">{row.contactName ?? row.customerName ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{row.visitTypeDescription ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.ampm ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {row.nearestCheckinTime ? (
                          <>
                            <p className="font-medium text-slate-900">{formatTime(row.nearestCheckinTime)}</p>
                            <p className="max-w-[180px] truncate text-[11px] text-slate-500" title={row.nearestCheckinAddress ?? undefined}>{row.nearestCheckinAddress ?? "—"}</p>
                          </>
                        ) : (
                          <span className="text-slate-400">No check-in</span>
                        )}
                      </td>
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
