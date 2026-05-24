"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Fingerprint, RefreshCw, Save, Upload } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AttendanceDeviceUserMappingDashboard,
  AttendanceDeviceUserMappingRow,
} from "@/lib/attendance/device-user-mapping";

type Props = {
  canUpdate: boolean;
  initialData: AttendanceDeviceUserMappingDashboard | null;
  initialError: string | null;
};

type UploadResult = {
  failed: number;
  failures: Array<{ message: string; row: number }>;
  imported: number;
  received: number;
};

type SyncResult = {
  duplicate?: number;
  elapsedMs?: number;
  errors?: string[];
  failed?: number;
  filteredBeforeStart?: number;
  inserted?: number;
  message?: string;
  runId?: string;
  sent?: number;
  skipped?: number;
  syncInProgress?: boolean;
  totalRead?: number;
};

type AgentHealth = {
  ok: boolean;
  reachable: boolean;
  payload?: {
    checks?: {
      deviceTcpReachable?: boolean;
      phoenixReachable?: boolean;
      sdkRegistered?: boolean;
      tokenConfigured?: boolean;
    };
    status?: string;
  };
};

const localAgentBaseUrl = "http://127.0.0.1:8787";

async function fetchAgentHealth(): Promise<AgentHealth> {
  try {
    const response = await fetch(`${localAgentBaseUrl}/health`, { cache: "no-store" });
    const payload = await response.json();
    return {
      ok: response.ok,
      reachable: true,
      payload,
    };
  } catch {
    // Fall back to the server-side check for local Phoenix development.
  }

  try {
    const response = await fetch("/api/attendance/agent/health", { cache: "no-store" });
    return await response.json();
  } catch {
    return { ok: false, reachable: false };
  }
}

function formatDate(value: string | null) {
  if (!value) return "No punches seen";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusBadge(row: AttendanceDeviceUserMappingRow) {
  if (row.status === "active") {
    return <Badge variant="success">Mapped</Badge>;
  }
  if (row.status === "inactive") {
    return <Badge variant="neutral">Inactive</Badge>;
  }
  return <Badge variant="warning">Unmapped</Badge>;
}

function employeeLabel(hrId: string, fullName: string) {
  return `${hrId} - ${fullName}`;
}

function MappingRow({
  canUpdate,
  employees,
  onSave,
  row,
}: {
  canUpdate: boolean;
  employees: AttendanceDeviceUserMappingDashboard["employees"];
  onSave: (input: { deviceId: string; deviceUserId: string; employeeHrId: string | null; isActive: boolean }) => Promise<void>;
  row: AttendanceDeviceUserMappingRow;
}) {
  const [employeeHrId, setEmployeeHrId] = useState(row.employeeHrId ?? "");
  const [isActive, setIsActive] = useState(row.isActive && Boolean(row.employeeHrId));
  const [saving, setSaving] = useState(false);
  const savedEmployeeHrId = row.employeeHrId ?? "";
  const savedIsActive = row.isActive && Boolean(row.employeeHrId);
  const hasChanges = employeeHrId !== savedEmployeeHrId || isActive !== savedIsActive;
  const cannotSave = !canUpdate || saving || !hasChanges || (isActive && !employeeHrId);

  async function save() {
    setSaving(true);
    try {
      await onSave({
        deviceId: row.deviceId,
        deviceUserId: row.deviceUserId,
        employeeHrId: employeeHrId || null,
        isActive,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-slate-700">{row.deviceId}</td>
      <td className="whitespace-nowrap px-4 py-3 text-sm font-black text-slate-900">{row.deviceUserId}</td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">{formatDate(row.latestPunchAt)}</td>
      <td className="whitespace-nowrap px-4 py-3">{statusBadge(row)}</td>
      <td className="min-w-[260px] px-4 py-3">
        <select
          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-slate-50 disabled:text-slate-400"
          disabled={!canUpdate || saving}
          value={employeeHrId}
          onChange={(event) => {
            const nextHrId = event.target.value;
            setEmployeeHrId(nextHrId);
            if (!nextHrId) setIsActive(false);
          }}
        >
          <option value="">Select employee HR_ID</option>
          {employees.map((employee) => (
            <option key={employee.hrId} value={employee.hrId}>
              {employeeLabel(employee.hrId, employee.fullName)}
            </option>
          ))}
        </select>
      </td>
      <td className="min-w-[180px] px-4 py-3 text-sm text-slate-600">
        {row.employeeName ?? "Not assigned"}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            checked={isActive}
            className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500 disabled:opacity-50"
            disabled={!canUpdate || saving || !employeeHrId}
            type="checkbox"
            onChange={(event) => setIsActive(event.target.checked)}
          />
          Active
        </label>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <Button
          className={hasChanges ? "px-3 py-1.5 text-xs" : "border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"}
          disabled={cannotSave}
          type="button"
          variant={hasChanges ? "default" : "secondary"}
          onClick={save}
        >
          {hasChanges ? <Save className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          {saving ? "Saving" : hasChanges ? "Save" : "Saved"}
        </Button>
      </td>
    </tr>
  );
}

export function DeviceUserMappingManager({ canUpdate, initialData, initialError }: Props) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [startingAgent, setStartingAgent] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive" | "unmapped">("all");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filteredMappings = useMemo(() => {
    const rows = data?.mappings ?? [];
    if (statusFilter === "all") return rows;
    return rows.filter((row) => row.status === statusFilter);
  }, [data?.mappings, statusFilter]);

  async function loadAgentHealth() {
    setAgentHealth(await fetchAgentHealth());
  }

  useEffect(() => {
    let cancelled = false;
    void fetchAgentHealth().then((health) => {
      if (!cancelled) setAgentHealth(health);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function load() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/attendance/device-user-mappings", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? "Device user mappings failed to load.");
      }
      setData(payload);
      await loadAgentHealth();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Device user mappings failed to load.");
    } finally {
      setRefreshing(false);
    }
  }

  async function save(input: { deviceId: string; deviceUserId: string; employeeHrId: string | null; isActive: boolean }) {
    setError(null);
    setNotice(null);
    const response = await fetch("/api/attendance/device-user-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? "Device user mapping failed to save.");
    }

    setData(payload);
    setNotice(`Saved mapping for ${input.deviceId} / ${input.deviceUserId}.`);
  }

  async function syncNow() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    setSyncResult(null);

    try {
      const response = await fetch(`${localAgentBaseUrl}/sync-now`, {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          "X-Phoenix-Local-Agent": "1",
        },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? "Attendance sync failed.");
      }

      setSyncResult(payload);
      if (payload.syncInProgress) {
        setNotice(payload.message ?? "Attendance sync is already running.");
      } else {
        setNotice(`Sync complete: ${payload.inserted ?? 0} inserted, ${payload.duplicate ?? 0} duplicates, ${payload.skipped ?? 0} skipped.`);
      }
      await load();
      await loadAgentHealth();
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "Attendance sync failed.";
      setError(
        message === "Failed to fetch"
          ? `Browser could not reach the local attendance agent at ${localAgentBaseUrl}. Start local-attendance-agent\\start-agent.ps1 on this PC, close ZKTime, then try Sync Now again.`
          : message,
      );
    } finally {
      setSyncing(false);
    }
  }

  async function startAgent() {
    setStartingAgent(true);
    setError(null);
    setNotice(null);

    try {
      const host = window.location.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") {
        const health = await fetchAgentHealth();
        setAgentHealth(health);
        if (health.reachable) {
          setNotice("Local attendance agent is already running on this PC.");
          return;
        }
        throw new Error(
          "Hosted Phoenix cannot start a Windows program on this PC. Start local-attendance-agent\\start-agent.ps1 once, then click Sync Now.",
        );
      }

      const response = await fetch("/api/attendance/agent/start", {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? "Attendance agent failed to start.");
      }

      setAgentHealth(payload.health ?? null);
      setNotice(payload.alreadyRunning ? "Local attendance agent is already running." : "Local attendance agent start requested.");
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Attendance agent failed to start.");
    } finally {
      setStartingAgent(false);
    }
  }

  async function uploadTemplate(file: File | null) {
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/attendance/device-user-mappings/upload", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? "Attendance device mapping upload failed.");
      }

      setData(payload.dashboard);
      setUploadResult({
        failed: payload.failed ?? 0,
        failures: payload.failures ?? [],
        imported: payload.imported ?? 0,
        received: payload.received ?? 0,
      });
      setNotice(`Template upload complete: ${payload.imported ?? 0} imported, ${payload.failed ?? 0} failed.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Attendance device mapping upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{data?.summary.total ?? 0} device users</AdminInsightChip>
            <AdminInsightChip tone="orange">{data?.summary.unmapped ?? 0} unmapped</AdminInsightChip>
            <AdminInsightChip tone="slate">{data?.summary.active ?? 0} active mappings</AdminInsightChip>
          </>
        )}
        description="Map numeric fingerprint device users to Phoenix employee HR_IDs. Only active mappings are used during raw punch ingestion."
        eyebrow="Attendance"
        icon={<Fingerprint className="h-3.5 w-3.5" />}
        title="Device User Mapping"
        actions={(
          <>
            <Button disabled={!canUpdate || startingAgent} variant="secondary" type="button" onClick={() => void startAgent()}>
              <RefreshCw className={`h-4 w-4 ${startingAgent ? "animate-spin" : ""}`} />
              {startingAgent ? "Starting Agent" : "Run Local Agent"}
            </Button>
            <Button disabled={!canUpdate || syncing} type="button" onClick={() => void syncNow()}>
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing" : "Sync Now"}
            </Button>
            <a
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-medium text-text transition hover:bg-bg-muted"
              href="/api/attendance/device-user-mappings/template"
            >
                <Download className="h-4 w-4" />
                Download template
            </a>
            <Button disabled={!canUpdate || uploading} variant="secondary" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" />
              {uploading ? "Uploading" : "Upload template"}
            </Button>
            <input
              accept=".xlsx"
              className="sr-only"
              disabled={!canUpdate || uploading}
              ref={fileInputRef}
              type="file"
              onChange={(event) => void uploadTemplate(event.target.files?.[0] ?? null)}
            />
            <Button disabled={refreshing} variant="secondary" type="button" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
          </>
        )}
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}
      {agentHealth ? (
        <AdminCallout tone={agentHealth.reachable ? "success" : "warning"}>
          Local agent: {agentHealth.reachable ? "running" : "not running"}. Device:
          {" "}{agentHealth.payload?.checks?.deviceTcpReachable ? "reachable" : "not checked/unreachable"}.
        </AdminCallout>
      ) : null}
      {!canUpdate ? <AdminCallout tone="warning">You can review mappings, but this account cannot update employee mappings.</AdminCallout> : null}
      {syncResult ? (
        <AdminCallout tone={(syncResult.failed ?? 0) > 0 || syncResult.syncInProgress ? "warning" : "success"}>
          {syncResult.syncInProgress ? (
            syncResult.message ?? "Attendance sync is already running."
          ) : (
            <>
              Sync summary: {syncResult.totalRead ?? 0} read, {syncResult.filteredBeforeStart ?? 0} before 2026-01-01 filtered,
              {" "}{syncResult.sent ?? 0} sent, {syncResult.inserted ?? 0} inserted, {syncResult.duplicate ?? 0} duplicates,
              {" "}{syncResult.skipped ?? 0} skipped, {syncResult.failed ?? 0} failed.
            </>
          )}
        </AdminCallout>
      ) : null}
      {uploadResult ? (
        <AdminCallout tone={uploadResult.failed > 0 ? "warning" : "success"}>
          <div className="space-y-2">
            <p className="font-bold">
              Upload summary: {uploadResult.imported} imported from {uploadResult.received} rows, {uploadResult.failed} failed.
            </p>
            {uploadResult.failures.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {uploadResult.failures.slice(0, 8).map((failure) => (
                  <li key={`${failure.row}-${failure.message}`}>Row {failure.row}: {failure.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </AdminCallout>
      ) : null}

      <AdminTableShell
        action={(
          <select
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">All users</option>
            <option value="unmapped">Unmapped</option>
            <option value="active">Mapped active</option>
            <option value="inactive">Inactive</option>
          </select>
        )}
        description="Assign employees by HR_ID and choose whether each mapping is active for ingestion."
        title="Device Users"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Device User</th>
                <th className="px-4 py-3">Latest Punch</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Employee HR_ID</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredMappings.map((row) => (
                <MappingRow
                  canUpdate={canUpdate}
                  employees={data?.employees ?? []}
                  key={`${row.deviceId}-${row.deviceUserId}-${row.employeeHrId ?? ""}-${row.isActive ? "active" : "inactive"}`}
                  row={row}
                  onSave={save}
                />
              ))}
              {filteredMappings.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>
                    No device users match this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Recently seen device users that are not assigned to an employee HR_ID."
        title="Recent Unmapped Device Users"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Device User</th>
                <th className="px-4 py-3">Latest Punch</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentUnmapped ?? []).map((row) => (
                <tr className="border-b border-slate-100 last:border-0" key={`recent-${row.deviceId}-${row.deviceUserId}`}>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-slate-700">{row.deviceId}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-black text-slate-900">{row.deviceUserId}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">{formatDate(row.latestPunchAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{statusBadge(row)}</td>
                </tr>
              ))}
              {(data?.recentUnmapped ?? []).length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={4}>
                    No recent unmapped device users.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
    </div>
  );
}
