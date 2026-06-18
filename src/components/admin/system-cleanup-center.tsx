"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  SystemCleanupActionResult,
  SystemCleanupModuleKey,
  SystemCleanupPreviewResult,
  SystemCleanupRecord,
  SystemCleanupRecordsResponse,
  SystemCleanupSafetyState,
  SystemCleanupTarget,
} from "@/lib/admin/system-cleanup";
import { SearchableSelect } from "@/components/ui/searchable-select";


type FilterState = {
  dateFrom: string;
  dateTo: string;
  moduleKey: SystemCleanupModuleKey | "all";
  query: string;
  safetyState: SystemCleanupSafetyState | "all";
  status: string;
};

const defaultFilters: FilterState = {
  dateFrom: "",
  dateTo: "",
  moduleKey: "all",
  query: "",
  safetyState: "all",
  status: "all",
};
const emptyCleanupRecords: SystemCleanupRecord[] = [];

function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function safetyBadge(record: Pick<SystemCleanupRecord, "safetyState">) {
  if (record.safetyState === "safe") {
    return <Badge variant="success">Safe</Badge>;
  }
  if (record.safetyState === "payroll_locked") {
    return <Badge variant="danger">Payroll locked</Badge>;
  }
  return <Badge variant="warning">Blocked</Badge>;
}

function resultBadge(result: SystemCleanupActionResult) {
  if (result.status === "deleted") {
    return <Badge variant="success">Deleted</Badge>;
  }
  if (result.status === "blocked") {
    return <Badge variant="warning">Blocked</Badge>;
  }
  return <Badge variant="danger">Failed</Badge>;
}

function recordTarget(record: Pick<SystemCleanupRecord, "moduleKey" | "recordId">): SystemCleanupTarget {
  return {
    moduleKey: record.moduleKey,
    recordId: record.recordId,
  };
}

function targetKey(target: SystemCleanupTarget) {
  return `${target.moduleKey}:${target.recordId}`;
}

function buildQuery(filters: FilterState) {
  const params = new URLSearchParams();
  if (filters.moduleKey !== "all") params.set("module", filters.moduleKey);
  if (filters.query.trim()) params.set("query", filters.query.trim());
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.safetyState !== "all") params.set("safety", filters.safetyState);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  return params.toString();
}

function compactId(value: string) {
  const displayValue = value.startsWith("employee_plan_headers:") || value.startsWith("weekly_plans:")
    ? value.slice(value.indexOf(":") + 1)
    : value;
  return displayValue.length > 12 ? `${displayValue.slice(0, 8)}...${displayValue.slice(-4)}` : displayValue;
}

export function SystemCleanupCenter({
  initialData,
  initialError,
}: {
  initialData: SystemCleanupRecordsResponse | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<SystemCleanupRecordsResponse | null>(initialData);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SystemCleanupPreviewResult[]>([]);
  const [results, setResults] = useState<SystemCleanupActionResult[]>([]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const records = data?.records ?? emptyCleanupRecords;
  const safeSelectedTargets = useMemo(() => {
    const byKey = new Map(records.map((record) => [targetKey(recordTarget(record)), record]));
    return Array.from(selected)
      .map((key) => byKey.get(key))
      .filter((record): record is SystemCleanupRecord => Boolean(record?.canDelete))
      .map(recordTarget);
  }, [records, selected]);
  const previewSafeCount = preview.filter((record) => record.canDelete).length;

  function handleExecuteClick() {
    if (previewSafeCount === 0) {
      setExecuteError("There are no safe records in this preview.");
      return;
    }
    if (!confirmed) {
      setExecuteError("Check the confirmation box before deleting.");
      return;
    }
    setExecuteError(null);
    void postAction("execute", preview.filter((record) => record.canDelete).map(recordTarget));
  }

  async function refresh(nextFilters = filters) {
    setLoading(true);
    setError(null);
    try {
      const query = buildQuery(nextFilters);
      const response = await fetch(`/api/admin/system-cleanup/records${query ? `?${query}` : ""}`, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "System cleanup records failed to load.");
      setData(payload as SystemCleanupRecordsResponse);
      setSelected(new Set());
      setPreview([]);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "System cleanup records failed to load.");
    } finally {
      setLoading(false);
    }
  }

  async function postAction(mode: "execute" | "preview", targets: SystemCleanupTarget[]) {
    setActionLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/system-cleanup/actions", {
        body: JSON.stringify({
          mode,
          reason,
          targets,
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "System cleanup action failed.");
      if (mode === "preview") {
        setPreview(payload.previews as SystemCleanupPreviewResult[]);
        setResults([]);
        setConfirmed(false);
        setExecuteError(null);
      } else {
        setResults(payload.results as SystemCleanupActionResult[]);
        setPreview([]);
        setConfirmed(false);
        setExecuteError(null);
        setReason("");
        await refresh();
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "System cleanup action failed.");
    } finally {
      setActionLoading(false);
    }
  }

  function toggleSelected(record: SystemCleanupRecord) {
    if (!record.canDelete) return;
    const key = targetKey(recordTarget(record));
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllSafe() {
    const safeKeys = records
      .filter((record) => record.canDelete)
      .map((record) => targetKey(recordTarget(record)));
    const everySafeSelected = safeKeys.length > 0 && safeKeys.every((key) => selected.has(key));
    setSelected(everySafeSelected ? new Set() : new Set(safeKeys));
  }

  return (
    <main className="min-h-screen bg-slate-50 px-3 py-4 text-slate-950 sm:px-5 lg:px-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-rose-700">
                <ShieldAlert className="h-4 w-4" />
                Super Admin
              </div>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950">System Cleanup</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                Remove test or incorrect workflow records from supported modules with snapshots, blocking rules, and audit history.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Total" value={data?.summary.total ?? 0} />
              <Metric label="Safe" value={data?.summary.safe ?? 0} />
              <Metric label="Payroll locked" value={data?.summary.payrollLocked ?? 0} />
              <Metric label="Blocked" value={data?.summary.blocked ?? 0} />
            </div>
          </div>
        </section>

        {error ? (
          <div className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <form
            className="grid gap-3 border-b border-slate-200 p-3 md:grid-cols-[1.2fr_1fr_0.8fr_0.8fr_0.8fr_0.8fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              void refresh();
            }}
          >
            <label className="min-w-0 text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              Search
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400"
                  onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                  placeholder="Name, HR ID, record"
                  value={filters.query}
                />
              </div>
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              Module
              <SearchableSelect
                className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900"
                onChange={(event) => setFilters((current) => ({ ...current, moduleKey: event.target.value as FilterState["moduleKey"] }))}
                value={filters.moduleKey}
              >
                <option value="all">All modules</option>
                {(data?.modules ?? []).map((module) => (
                  <option key={module.key} value={module.key}>{module.label}</option>
                ))}
              </SearchableSelect>
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              Status
              <Input
                className="mt-1 h-10"
                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value || "all" }))}
                placeholder="all"
                value={filters.status === "all" ? "" : filters.status}
              />
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              Safety
              <SearchableSelect
                className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900"
                onChange={(event) => setFilters((current) => ({ ...current, safetyState: event.target.value as FilterState["safetyState"] }))}
                value={filters.safetyState}
              >
                <option value="all">All</option>
                <option value="safe">Safe</option>
                <option value="payroll_locked">Payroll locked</option>
                <option value="blocked">Blocked</option>
              </SearchableSelect>
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              From
              <Input
                className="mt-1 h-10"
                onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
                type="date"
                value={filters.dateFrom}
              />
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
              To
              <Input
                className="mt-1 h-10"
                onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
                type="date"
                value={filters.dateTo}
              />
            </label>
            <div className="flex items-end gap-2">
              <Button className="h-10 gap-2" disabled={loading} type="submit">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Apply
              </Button>
              <Button
                className="h-10 px-3"
                disabled={loading}
                onClick={() => {
                  setFilters(defaultFilters);
                  void refresh(defaultFilters);
                }}
                title="Reset filters"
                variant="secondary"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </form>

          <div className="flex flex-col gap-3 border-b border-slate-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-semibold text-slate-600">
              {safeSelectedTargets.length} selected safe record(s)
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2"
                disabled={safeSelectedTargets.length === 0 || actionLoading}
                onClick={() => void postAction("preview", safeSelectedTargets)}
                variant="secondary"
              >
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                Preview Selected
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full border-collapse text-left text-sm">
              <thead className="bg-slate-100 text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-3">
                    <input
                      checked={records.some((record) => record.canDelete) && records.filter((record) => record.canDelete).every((record) => selected.has(targetKey(recordTarget(record))))}
                      className="h-4 w-4 rounded border-slate-300"
                      onChange={toggleAllSafe}
                      type="checkbox"
                    />
                  </th>
                  <th className="px-3 py-3">Module</th>
                  <th className="px-3 py-3">Employee</th>
                  <th className="px-3 py-3">Record</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Date</th>
                  <th className="px-3 py-3">Safety</th>
                  <th className="px-3 py-3">Impact</th>
                  <th className="px-3 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map((record) => {
                  const key = targetKey(recordTarget(record));
                  return (
                    <tr key={key} className={cn("bg-white", !record.canDelete && "bg-slate-50")}>
                      <td className="px-3 py-3 align-top">
                        <input
                          checked={selected.has(key)}
                          className="h-4 w-4 rounded border-slate-300"
                          disabled={!record.canDelete}
                          onChange={() => toggleSelected(record)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="font-bold text-slate-900">{record.moduleLabel}</div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="font-bold text-slate-900">{record.employeeName ?? "Unknown"}</div>
                        <div className="mt-1 font-mono text-xs text-slate-500">{record.employeeHrId ?? "No HR ID"}</div>
                      </td>
                      <td className="max-w-[260px] px-3 py-3 align-top">
                        <div className="truncate font-bold text-slate-900" title={record.title}>{record.title}</div>
                        <div className="mt-1 font-mono text-xs text-slate-500" title={record.recordId}>{compactId(record.recordId)}</div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <Badge variant="neutral">{statusLabel(record.status)}</Badge>
                      </td>
                      <td className="px-3 py-3 align-top text-slate-600">{record.dateLabel}</td>
                      <td className="px-3 py-3 align-top">
                        <div className="space-y-1">
                          {safetyBadge(record)}
                          {record.blockReason ? <div className="max-w-[220px] text-xs leading-5 text-rose-700">{record.blockReason}</div> : null}
                        </div>
                      </td>
                      <td className="max-w-[300px] px-3 py-3 align-top">
                        <div className="line-clamp-2 text-xs leading-5 text-slate-600">{record.impact.join(" | ")}</div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <Button
                          className="h-9 gap-2 px-3"
                          disabled={actionLoading}
                          onClick={() => void postAction("preview", [recordTarget(record)])}
                          variant="secondary"
                        >
                          <ShieldAlert className="h-4 w-4" />
                          Preview
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {records.length === 0 ? (
                  <tr>
                    <td className="px-3 py-10 text-center text-sm font-semibold text-slate-500" colSpan={9}>
                      No records match the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {preview.length > 0 ? (
          <section className="rounded-lg border border-amber-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 font-black text-amber-950">
                <AlertTriangle className="h-5 w-5" />
                Cleanup Preview
              </div>
              <Badge variant={previewSafeCount === preview.length ? "success" : "warning"}>
                {previewSafeCount}/{preview.length} deletable
              </Badge>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-[1fr_420px]">
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-[760px] w-full text-left text-sm">
                  <thead className="bg-slate-100 text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Record</th>
                      <th className="px-3 py-3">Employee</th>
                      <th className="px-3 py-3">Safety</th>
                      <th className="px-3 py-3">Impact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.map((record) => (
                      <tr key={targetKey(recordTarget(record))}>
                        <td className="px-3 py-3 align-top">
                          <div className="font-bold text-slate-900">{record.moduleLabel}</div>
                          <div className="mt-1 text-slate-700">{record.title}</div>
                          <div className="mt-1 font-mono text-xs text-slate-500">{compactId(record.recordId)}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="font-bold text-slate-900">{record.employeeName ?? "Unknown"}</div>
                          <div className="mt-1 font-mono text-xs text-slate-500">{record.employeeHrId ?? "No HR ID"}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          {safetyBadge(record)}
                          {record.blockReason ? <div className="mt-2 max-w-[220px] text-xs leading-5 text-rose-700">{record.blockReason}</div> : null}
                        </td>
                        <td className="px-3 py-3 align-top text-xs leading-5 text-slate-600">
                          {record.impact.map((item) => (
                            <div key={item}>{item}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-slate-200 p-4">
                <label className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                  Cleanup note (optional)
                  <textarea
                    className="mt-2 min-h-28 w-full resize-y rounded-lg border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-900 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    onChange={(event) => {
                      setReason(event.target.value);
                      setExecuteError(null);
                    }}
                    placeholder="Optional note"
                    value={reason}
                  />
                </label>
                <label className="mt-3 flex items-start gap-2 text-sm font-semibold text-slate-700">
                  <input
                    checked={confirmed}
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                    onChange={(event) => {
                      setConfirmed(event.target.checked);
                      setExecuteError(null);
                    }}
                    type="checkbox"
                  />
                  I confirm deletion for the safe records in this preview.
                </label>
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                  Delete requires a safe preview and confirmation.
                </div>
                {executeError ? (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{executeError}</span>
                  </div>
                ) : null}
                <Button
                  className="mt-4 w-full gap-2"
                  disabled={actionLoading}
                  onClick={handleExecuteClick}
                  variant="destructive"
                >
                  {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Delete Safe Records
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        {results.length > 0 ? (
          <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 font-black text-slate-950">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Cleanup Results
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Module</th>
                    <th className="px-3 py-3">Employee</th>
                    <th className="px-3 py-3">Record</th>
                    <th className="px-3 py-3">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((result) => (
                    <tr key={`${result.moduleKey}:${result.recordId}`}>
                      <td className="px-3 py-3">{resultBadge(result)}</td>
                      <td className="px-3 py-3 font-bold text-slate-900">{statusLabel(result.moduleKey)}</td>
                      <td className="px-3 py-3">
                        <div className="font-bold text-slate-900">{result.employeeName ?? "Unknown"}</div>
                        <div className="mt-1 font-mono text-xs text-slate-500">{result.employeeHrId ?? "No HR ID"}</div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-500">{compactId(result.recordId)}</td>
                      <td className="px-3 py-3 text-slate-700">{result.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-black text-slate-950">{value}</div>
    </div>
  );
}
