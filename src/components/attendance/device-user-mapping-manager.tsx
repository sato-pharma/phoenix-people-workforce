"use client";

import { useMemo, useState } from "react";
import { Fingerprint, RefreshCw, Save } from "lucide-react";

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
        <Button disabled={!canUpdate || saving || (isActive && !employeeHrId)} size="sm" type="button" onClick={save}>
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving" : "Save"}
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
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive" | "unmapped">("all");

  const filteredMappings = useMemo(() => {
    const rows = data?.mappings ?? [];
    if (statusFilter === "all") return rows;
    return rows.filter((row) => row.status === statusFilter);
  }, [data?.mappings, statusFilter]);

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
          <Button disabled={refreshing} variant="outline" type="button" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
        )}
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="success">{notice}</AdminCallout> : null}
      {!canUpdate ? <AdminCallout tone="warning">You can review mappings, but this account cannot update employee mappings.</AdminCallout> : null}

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
                  key={`${row.deviceId}-${row.deviceUserId}`}
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
