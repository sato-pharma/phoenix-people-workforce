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
import {
  PortalStackingCell,
  portalStackingBodyClassName,
  portalStackingHeadClassName,
  portalStackingRowClassName,
  portalStackingTableClassName,
} from "@/components/employee-portal/portal-primitives";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import type {
  AttendanceDeviceUserMappingDashboard,
  AttendanceDeviceUserMappingRow,
} from "@/lib/attendance/device-user-mapping";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";


// Called directly from the BROWSER, not proxied through the Next.js server - the server only
// reaches this when it happens to run on the same machine (local dev). Calling it straight from
// the browser is what lets "Sync Now" work from the real production page too, as long as the
// browser viewing it is on the machine the agent runs on. See Program.cs's CORS policy.
const LOCAL_AGENT_BASE_URL = "http://127.0.0.1:8787";

type Props = {
  canRunLocalAgentSpawn: boolean;
  canUpdate: boolean;
  initialData: AttendanceDeviceUserMappingDashboard | null;
  initialError: string | null;
  localAgentDirectToken: string | null;
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

async function fetchAgentHealth(): Promise<AgentHealth> {
  try {
    // http:// is correct here and must stay. LOCAL_AGENT_BASE_URL is hardcoded loopback
    // (127.0.0.1), so this request never reaches a network — there is no wire to intercept. The
    // Secure Contexts spec classes loopback as a potentially trustworthy origin for exactly that
    // reason, which is why the browser does not flag it either. See the /sync-now call below.
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    const response = await fetch(`${LOCAL_AGENT_BASE_URL}/health`, { cache: "no-store" });
    const payload = await response.json().catch(() => undefined);
    return { ok: response.ok, reachable: true, payload };
  } catch {
    // No response at all: either nothing is listening on this browser's machine, or the agent's
    // CORS policy rejected the origin - both read the same to a caller, and both correctly mean
    // "Sync Now" is unavailable from here.
    return { ok: false, reachable: false };
  }
}

function formatDate(value: string | null) {
  if (!value) return "No punches seen";
  return stableEnGbFormatter({
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  }).format(new Date(value));
}

// Sentinel value for the employee dropdown. Not an HR_ID, and deliberately cannot collide with
// one: it marks the row as belonging to somebody who is not in `employees` at all.
const NON_EMPLOYEE_OPTION = "__non_employee__";

function statusBadge(row: AttendanceDeviceUserMappingRow) {
  if (row.status === "active") {
    return <Badge variant="success">Mapped</Badge>;
  }
  if (row.status === "inactive") {
    return <Badge variant="neutral">Inactive</Badge>;
  }
  // Grey, not orange: a named driver or guard is a settled answer, not an outstanding one.
  if (row.status === "non_employee") {
    return <Badge variant="neutral">Not an employee</Badge>;
  }
  return <Badge variant="warning">Unmapped</Badge>;
}

function employeeLabel(fullName: string) {
  return fullName;
}

function MappingRow({
  canUpdate,
  employees,
  onSave,
  row,
}: {
  canUpdate: boolean;
  employees: AttendanceDeviceUserMappingDashboard["employees"];
  onSave: (input: { deviceId: string; deviceUserId: string; employeeHrId: string | null; isActive: boolean; nonEmployeeLabel: string | null }) => Promise<void>;
  row: AttendanceDeviceUserMappingRow;
}) {
  const [employeeHrId, setEmployeeHrId] = useState(row.employeeHrId ?? "");
  const [isActive, setIsActive] = useState(row.isActive && Boolean(row.employeeHrId));
  const [nonEmployee, setNonEmployee] = useState(Boolean(row.nonEmployeeLabel));
  const [nonEmployeeLabel, setNonEmployeeLabel] = useState(row.nonEmployeeLabel ?? "");
  const [saving, setSaving] = useState(false);
  const savedEmployeeHrId = row.employeeHrId ?? "";
  const savedIsActive = row.isActive && Boolean(row.employeeHrId);
  const savedNonEmployeeLabel = row.nonEmployeeLabel ?? "";
  const trimmedLabel = nonEmployeeLabel.trim();
  const hasChanges =
    employeeHrId !== savedEmployeeHrId
    || isActive !== savedIsActive
    || (nonEmployee ? trimmedLabel : "") !== savedNonEmployeeLabel;
  // An empty label is refused rather than saved as a blank: "not an employee, and no idea which"
  // is exactly the unmapped state this option exists to get out of.
  const cannotSave =
    !canUpdate || saving || !hasChanges || (isActive && !employeeHrId) || (nonEmployee && !trimmedLabel);

  async function save() {
    setSaving(true);
    try {
      await onSave({
        deviceId: row.deviceId,
        deviceUserId: row.deviceUserId,
        employeeHrId: employeeHrId || null,
        isActive,
        // Always sent, never omitted: this screen knows about the field, so clearing the choice
        // here is a real instruction to drop the label, not an absent-minded omission.
        nonEmployeeLabel: nonEmployee ? trimmedLabel : null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className={cn(portalStackingRowClassName, "border-b border-slate-100 py-2 last:border-0 md:py-0")}>
      <PortalStackingCell className="break-words text-sm font-semibold text-slate-700" label="Device">
        {row.deviceId}
        <div className="text-sm font-black text-slate-900">User {row.deviceUserId}</div>
      </PortalStackingCell>
      <PortalStackingCell className="break-words text-sm text-slate-600" label="Latest Punch">
        {formatDate(row.latestPunchAt)}
      </PortalStackingCell>
      <PortalStackingCell label="Status">
        {statusBadge(row)}
      </PortalStackingCell>
      <PortalStackingCell className="min-w-0 break-words" label="Employee">
        <SearchableSelect
          className="h-9 w-full px-3 disabled:text-slate-400"
          disabled={!canUpdate || saving}
          value={nonEmployee ? NON_EMPLOYEE_OPTION : employeeHrId}
          onChange={(event) => {
            const next = event.target.value;
            if (next === NON_EMPLOYEE_OPTION) {
              setNonEmployee(true);
              setEmployeeHrId("");
              setIsActive(false);
              return;
            }
            setNonEmployee(false);
            setEmployeeHrId(next);
            if (!next) setIsActive(false);
          }}
        >
          <option value="">Select employee</option>
          <option value={NON_EMPLOYEE_OPTION}>Not an employee (driver / guard / cleaner)</option>
          {employees.map((employee) => (
            <option key={employee.hrId} value={employee.hrId}>
              {employeeLabel(employee.fullName)}
            </option>
          ))}
        </SearchableSelect>
        {nonEmployee ? (
          <input
            className={cn(phxFieldClassName, "mt-2")}
            disabled={!canUpdate || saving}
            maxLength={80}
            placeholder="Driver, guard, cleaner"
            type="text"
            value={nonEmployeeLabel}
            onChange={(event) => setNonEmployeeLabel(event.target.value)}
          />
        ) : null}
      </PortalStackingCell>
      <PortalStackingCell label="Active">
        <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            checked={isActive}
            className="h-4 w-4 border-slate-300 text-orange-600 focus:ring-orange-500 disabled:opacity-50"
            disabled={!canUpdate || saving || !employeeHrId}
            type="checkbox"
            onChange={(event) => setIsActive(event.target.checked)}
          />
          Active
        </label>
      </PortalStackingCell>
      <PortalStackingCell className="md:text-right" label="Action">
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
      </PortalStackingCell>
    </tr>
  );
}

export function DeviceUserMappingManager({
  canRunLocalAgentSpawn,
  canUpdate,
  initialData,
  initialError,
  localAgentDirectToken,
}: Props) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [startingAgent, setStartingAgent] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive" | "non_employee" | "unmapped">("all");
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

  async function save(input: { deviceId: string; deviceUserId: string; employeeHrId: string | null; isActive: boolean; nonEmployeeLabel: string | null }) {
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
      if (!localAgentDirectToken) {
        throw new Error("Sync Now is not available for your role.");
      }

      // http:// is correct here and must stay — same loopback reasoning as fetchAgentHealth above.
      // THE BEARER TOKEN BELOW IS THE PART WORTH THINKING ABOUT, AND IT IS FINE FOR ONE REASON
      // ONLY: 127.0.0.1 never leaves the machine. A bearer token over plaintext http:// to any
      // routable address would be a real finding, not a suppressible one — so if
      // LOCAL_AGENT_BASE_URL ever stops being loopback, this suppression is wrong and must go with
      // it, not be carried along.
      //
      // Do not "fix" this by switching to https://. The agent would then need a locally trusted
      // certificate, which means shipping a private key with it or minting one per machine — a
      // real key-management problem bought in exchange for securing a channel that has no network
      // segment to secure.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const response = await fetch(`${LOCAL_AGENT_BASE_URL}/sync-now`, {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localAgentDirectToken}`,
        },
        method: "POST",
        signal: AbortSignal.timeout(600_000),
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 409) {
        // The agent itself reports "a sync is already running" as 409 - not a failure.
        setSyncResult({ ...payload, failed: 0, syncInProgress: true });
        setNotice(payload.message ?? "Attendance sync is already running.");
      } else if (!response.ok) {
        const detail = Array.isArray(payload.errors) ? payload.errors.join("; ") : undefined;
        throw new Error(payload.message ?? detail ?? "Attendance sync failed.");
      } else {
        setSyncResult(payload);
        setNotice(`Sync complete: ${payload.inserted ?? 0} inserted, ${payload.duplicate ?? 0} duplicates, ${payload.skipped ?? 0} skipped.`);
      }
      await load();
      await loadAgentHealth();
    } catch (syncError) {
      if (syncError instanceof DOMException && syncError.name === "TimeoutError") {
        setError("Attendance agent sync timed out while reading the fingerprint device.");
      } else if (syncError instanceof TypeError) {
        setError(
          `Local attendance agent is not reachable at ${LOCAL_AGENT_BASE_URL} from this browser. ` +
            "Make sure you're viewing this page on the machine running the agent.",
        );
      } else {
        setError(syncError instanceof Error ? syncError.message : "Attendance sync failed.");
      }
    } finally {
      setSyncing(false);
    }
  }

  async function startAgent() {
    setStartingAgent(true);
    setError(null);
    setNotice(null);

    try {
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
            <AdminInsightChip tone="neutral">{data?.summary.nonEmployee ?? 0} not employees</AdminInsightChip>
            <AdminInsightChip tone="slate">{data?.summary.active ?? 0} active mappings</AdminInsightChip>
          </>
        )}
        description="Map numeric fingerprint device users to Phoenix employee HR_IDs. Only active mappings are used during raw punch ingestion."
        eyebrow="Attendance"
        icon={<Fingerprint className="h-3.5 w-3.5" />}
        title="Device User Mapping"
        actions={(
          <>
            {canRunLocalAgentSpawn ? (
              <Button disabled={!canUpdate || startingAgent} variant="secondary" type="button" onClick={() => void startAgent()}>
                <RefreshCw className={`h-4 w-4 ${startingAgent ? "animate-spin" : ""}`} />
                {startingAgent ? "Starting Agent" : "Run Local Agent"}
              </Button>
            ) : null}
            {agentHealth?.reachable ? (
              <Button disabled={!canUpdate || syncing || !localAgentDirectToken} type="button" onClick={() => void syncNow()}>
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing" : "Sync Now"}
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-medium text-slate-200">
                Auto-sync: every 2 h + 5 PM daily
              </span>
            )}
            <a
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 backdrop-blur transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white"
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
        <AdminCallout tone={agentHealth.reachable ? "success" : "neutral"}>
          {agentHealth.reachable ? (
            <>
              Local agent: <strong>reachable from your browser</strong>. Device:{" "}
              {agentHealth.payload?.checks?.deviceTcpReachable ? "reachable" : "not checked / unreachable"}.
            </>
          ) : (
            <div className="space-y-1">
              <p>
                <strong>Local agent not reachable from this browser.</strong> Sync still runs automatically —
                every 2 hours and daily at 5 PM — as long as the agent is running on the Windows machine
                connected to your ZKTeco fingerprint device. &quot;Sync Now&quot; only works when you view this
                page from that same machine.
              </p>
              <p className="text-xs">
                To start it: open a PowerShell window in{" "}
                <code className="rounded bg-slate-100 px-1 font-mono text-slate-700">local-attendance-agent\</code>
                {" "}and run{" "}
                <code className="rounded bg-slate-100 px-1 font-mono text-slate-700">.\start-agent.ps1</code>.
                For automatic startup, run{" "}
                <code className="rounded bg-slate-100 px-1 font-mono text-slate-700">.\install-scheduled-tasks.ps1</code>{" "}
                (requires Administrator).
              </p>
            </div>
          )}
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
          <SearchableSelect
            className="h-9 px-3"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          >
            <option value="all">All users</option>
            <option value="unmapped">Unmapped</option>
            <option value="non_employee">Not an employee</option>
            <option value="active">Mapped active</option>
            <option value="inactive">Inactive</option>
          </SearchableSelect>
        )}
        description="Assign each device user to an employee and choose whether each mapping is active for ingestion."
        title="Device Users"
      >
        <div>
          {/* Six columns at px-4 cannot fit a phone, so on mobile the rows stack and each cell
              carries its own label; the column headers are hidden because they would label
              nothing. See the Cell helper above for why this table stacks rather than becoming a
              separate card list like the read-only reports do. */}
          <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
            <colgroup>
              <col className="w-[16%]" />
              <col className="w-[14%]" />
              <col className="w-[12%]" />
              <col className="w-[33%]" />
              <col className="w-[10%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead className={cn(portalStackingHeadClassName, "bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500")}>
              <tr>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Latest Punch</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className={portalStackingBodyClassName}>
              {filteredMappings.map((row) => (
                <MappingRow
                  canUpdate={canUpdate}
                  employees={data?.employees ?? []}
                  key={`${row.deviceId}-${row.deviceUserId}-${row.employeeHrId ?? ""}-${row.nonEmployeeLabel ?? ""}-${row.isActive ? "active" : "inactive"}`}
                  row={row}
                  onSave={save}
                />
              ))}
              {filteredMappings.length === 0 ? (
                <tr className={portalStackingRowClassName}>
                  <td className="block px-4 py-8 text-center text-sm text-slate-500 md:table-cell" colSpan={6}>
                    No device users match this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="Recently seen device users that are not assigned to an employee."
        title="Recent Unmapped Device Users"
      >
        <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[30%]" />
            <col className="w-[40%]" />
          </colgroup>
          <thead className={cn(portalStackingHeadClassName, "bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500")}>
            <tr>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Latest Punch</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className={portalStackingBodyClassName}>
            {(data?.recentUnmapped ?? []).map((row) => (
              <tr className={cn(portalStackingRowClassName, "border-b border-slate-100 last:border-0")} key={`recent-${row.deviceId}-${row.deviceUserId}`}>
                <PortalStackingCell className="break-words text-sm font-semibold text-slate-700" label="Device">
                  {row.deviceId}
                  <div className="font-black text-slate-900">User {row.deviceUserId}</div>
                </PortalStackingCell>
                <PortalStackingCell className="break-words text-sm text-slate-600" label="Latest Punch">{formatDate(row.latestPunchAt)}</PortalStackingCell>
                <PortalStackingCell label="Status">{statusBadge(row)}</PortalStackingCell>
              </tr>
            ))}
            {(data?.recentUnmapped ?? []).length === 0 ? (
              <tr className={portalStackingRowClassName}>
                <td className="block px-4 py-8 text-center text-sm text-slate-500 md:table-cell" colSpan={3}>
                  No recent unmapped device users.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </AdminTableShell>
    </div>
  );
}
