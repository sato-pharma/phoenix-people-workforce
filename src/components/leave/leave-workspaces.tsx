"use client";

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import {
  Banknote,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  Gauge,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  LeavePolicy,
  LeaveRequest,
  LeaveType,
  LeaveWallet,
  PublicHoliday,
} from "@/lib/leave/types";
import { cn } from "@/lib/utils";

type WorkspaceCommon = {
  holidays?: PublicHoliday[];
  leaveTypes: LeaveType[];
  policy?: LeavePolicy;
  requests: LeaveRequest[];
};

type EmployeeLeaveWorkspaceProps = WorkspaceCommon & {
  wallet: LeaveWallet;
};

type AdminLeaveWorkspaceProps = WorkspaceCommon & {
  dashboard: {
    approvedRequests: number;
    employeesOnLeaveToday: number;
    leaveBalanceUtilization: Array<{ available: number; line: string; used: number; utilization: number }>;
    leaveDaysByLine: Array<{ days: number; line: string }>;
    pendingRequests: number;
    rejectedRequests: number;
    totalRequests: number;
    upcomingLeaves: number;
  };
  policies: LeavePolicy[];
};

const fieldClassName =
  "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-500/10";

const textAreaClassName =
  "min-h-24 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-500/10";

const buttonClassName =
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-55";

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[18px] border border-slate-200 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.06)]", className)}>
      {children}
    </section>
  );
}

function PanelHeader({
  action,
  description,
  icon,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="flex min-w-0 gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-black tracking-tight text-slate-950">{title}</h2>
          <p className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-[16px] border border-slate-200 bg-white px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
          <div className="mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</div>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
          {icon}
        </span>
      </div>
    </div>
  );
}

function statusVariant(status: string): "danger" | "neutral" | "success" | "warning" {
  if (status.includes("approved")) return "success";
  if (status.includes("rejected") || status === "cancelled" || status === "blocked") return "danger";
  if (status.includes("pending")) return "warning";
  return "neutral";
}

function prettyStatus(status: string) {
  return status.replace(/_/g, " ");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00.000Z`));
}

function holidayDates(holidays?: PublicHoliday[]) {
  return new Set((holidays ?? []).map((holiday) => holiday.date));
}

function calculateWorkingDaysPreview(startDate: string, endDate: string, holidays?: PublicHoliday[], weekendDays = [5, 6]) {
  if (!startDate || !endDate || endDate < startDate) return 0;
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const weekends = new Set(weekendDays);
  const holidaySet = holidayDates(holidays);
  let total = 0;

  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86400000)) {
    const dateKey = cursor.toISOString().slice(0, 10);
    if (weekends.has(cursor.getUTCDay()) || holidaySet.has(dateKey)) continue;
    total += 1;
  }
  return total;
}

function uniqueValues(requests: LeaveRequest[], selector: (request: LeaveRequest) => string | null | undefined) {
  return Array.from(new Set(requests.map(selector).filter(Boolean) as string[])).sort();
}

function RequestDetailModal({
  onClose,
  request,
}: {
  onClose: () => void;
  request: LeaveRequest | null;
}) {
  if (!request) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 backdrop-blur-sm sm:items-center">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.28)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">{request.leaveType?.name ?? "Leave"}</p>
            <h3 className="mt-1 text-xl font-black tracking-tight text-slate-950">{request.employee?.fullName ?? request.employeeHrId}</h3>
          </div>
          <button className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["HR ID", request.employeeHrId],
              ["From", formatDate(request.startDate)],
              ["To", formatDate(request.endDate)],
              ["Working Days", request.totalWorkingDays],
              ["Manager", prettyStatus(request.managerStatus)],
              ["HR", prettyStatus(request.hrStatus)],
              ["Payroll", prettyStatus(request.payrollStatus)],
              ["Status", prettyStatus(request.status)],
            ].map(([label, value]) => (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={String(label)}>
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
                <p className="mt-1 text-sm font-black text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Reason / Comment</p>
            <p className="mt-2 text-sm leading-6 text-slate-700">{request.reason || "No reason provided."}</p>
            {request.attachmentUrl ? (
              <a className="mt-3 inline-flex items-center gap-2 text-sm font-black text-orange-700 hover:text-orange-800" href={request.attachmentUrl} target="_blank">
                <FileText className="h-4 w-4" />
                Open attachment
              </a>
            ) : null}
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Approval History</p>
            <div className="mt-3 space-y-3">
              {request.approvalHistory?.length ? request.approvalHistory.map((approval) => (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={approval.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-black text-slate-900">{approval.approverRole} · {approval.approverHrId}</p>
                    <Badge variant={statusVariant(approval.status)}>{approval.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{new Date(approval.actionDate).toLocaleString()}</p>
                  {approval.comment ? <p className="mt-2 text-sm text-slate-700">{approval.comment}</p> : null}
                </div>
              )) : (
                <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500">No decisions recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RequestsTable({
  actions,
  requests,
  title = "Leave Requests",
}: {
  actions?: (request: LeaveRequest) => ReactNode;
  requests: LeaveRequest[];
  title?: string;
}) {
  const [selected, setSelected] = useState<LeaveRequest | null>(null);

  return (
    <>
      <Panel className="overflow-hidden">
        <PanelHeader
          description={`${requests.length} request${requests.length === 1 ? "" : "s"} in the current view.`}
          icon={<FileText className="h-5 w-5" />}
          title={title}
        />
        {requests.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <CalendarDays className="h-5 w-5" />
            </div>
            <p className="mt-4 text-base font-black text-slate-950">No leave requests found.</p>
            <p className="mt-1 text-sm text-slate-500">Submitted leave requests will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                  {["Request Date", "Employee", "Leave Type", "From", "To", "Duration", "Status", "Manager", "HR", "Updated", "Actions"].map((column) => (
                    <th className="px-4 py-3" key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {requests.map((request) => (
                  <tr className="transition hover:bg-slate-50/70" key={request.id}>
                    <td className="px-4 py-4 font-semibold text-slate-600">{formatDate(request.requestedAt)}</td>
                    <td className="px-4 py-4">
                      <p className="font-black text-slate-950">{request.employee?.fullName ?? request.employeeHrId}</p>
                      <p className="mt-1 font-mono text-xs text-slate-500">{request.employeeHrId}</p>
                    </td>
                    <td className="px-4 py-4 font-semibold text-slate-700">{request.leaveType?.name ?? "Leave"}</td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.startDate)}</td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.endDate)}</td>
                    <td className="px-4 py-4 font-black text-slate-950">{request.totalWorkingDays}</td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.status)}>{prettyStatus(request.status)}</Badge></td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.managerStatus)}>{prettyStatus(request.managerStatus)}</Badge></td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.hrStatus)}>{prettyStatus(request.hrStatus)}</Badge></td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.updatedAt)}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-700 hover:bg-white" onClick={() => setSelected(request)} type="button">
                          View
                        </button>
                        {actions?.(request)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <RequestDetailModal onClose={() => setSelected(null)} request={selected} />
    </>
  );
}

function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 shadow-[0_18px_48px_rgba(15,23,42,0.20)]">
      {message}
    </div>
  );
}

export function EmployeeLeaveWorkspace({
  holidays,
  leaveTypes,
  policy,
  requests,
  wallet,
}: EmployeeLeaveWorkspaceProps) {
  const [formState, setFormState] = useState({ endDate: "", leaveTypeId: leaveTypes[0]?.id ?? "", reason: "", startDate: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const workingDays = calculateWorkingDaysPreview(formState.startDate, formState.endDate, holidays, policy?.weekendDays);
  const invalidRange = Boolean(formState.startDate && formState.endDate && formState.endDate < formState.startDate);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setToast(null);
    try {
      const response = await fetch("/api/leave/requests", {
        body: new FormData(event.currentTarget),
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to submit leave request.");
      setToast("Leave request submitted.");
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Unable to submit leave request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Toast message={toast} />
      <div className="grid gap-3 md:grid-cols-5">
        <MetricCard icon={<ShieldCheck className="h-5 w-5" />} label="Annual Entitlement" value={wallet.annualEntitlement} />
        <MetricCard icon={<Plus className="h-5 w-5" />} label="Accrued" value={wallet.accrued} />
        <MetricCard icon={<CheckCircle2 className="h-5 w-5" />} label="Used" value={wallet.used} />
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending" value={wallet.pending} />
        <MetricCard icon={<Gauge className="h-5 w-5" />} label="Available" value={wallet.available} />
      </div>

      <Panel>
        <PanelHeader
          description="Submit a request using Phoenix policy rules, working-day calculation, and balance validation."
          icon={<CalendarCheck className="h-5 w-5" />}
          title="New Leave Request"
        />
        <form className="grid gap-4 p-4 sm:p-5 lg:grid-cols-12" onSubmit={submit}>
          <label className="lg:col-span-3">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Leave Type</span>
            <select className={fieldClassName} name="leaveTypeId" onChange={(event) => setFormState((current) => ({ ...current, leaveTypeId: event.target.value }))} value={formState.leaveTypeId}>
              {leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
          </label>
          <label className="lg:col-span-2">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">From Date</span>
            <input className={fieldClassName} min={new Date().toISOString().slice(0, 10)} name="startDate" onChange={(event) => setFormState((current) => ({ ...current, startDate: event.target.value }))} required type="date" value={formState.startDate} />
          </label>
          <label className="lg:col-span-2">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">To Date</span>
            <input className={fieldClassName} min={formState.startDate || new Date().toISOString().slice(0, 10)} name="endDate" onChange={(event) => setFormState((current) => ({ ...current, endDate: event.target.value }))} required type="date" value={formState.endDate} />
          </label>
          <div className="lg:col-span-2">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Duration</span>
            <div className={cn(fieldClassName, "flex items-center bg-slate-50 text-slate-950")}>{invalidRange ? "Invalid range" : `${workingDays} working day${workingDays === 1 ? "" : "s"}`}</div>
          </div>
          <label className="lg:col-span-3">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Attachment</span>
            <div className="flex h-11 items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-500">
              <Upload className="h-4 w-4" />
              <input className="min-w-0 flex-1 text-xs" name="attachment" type="file" />
            </div>
          </label>
          <label className="lg:col-span-9">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reason / Comment</span>
            <textarea className={textAreaClassName} name="reason" onChange={(event) => setFormState((current) => ({ ...current, reason: event.target.value }))} value={formState.reason} />
          </label>
          <div className="flex items-end lg:col-span-3">
            <button className={cn(buttonClassName, "w-full bg-orange-600 text-white shadow-[0_14px_30px_rgba(249,115,22,0.24)] hover:bg-orange-700")} disabled={isSubmitting || invalidRange || workingDays <= 0} type="submit">
              <CalendarCheck className="h-4 w-4" />
              {isSubmitting ? "Submitting..." : "Submit Request"}
            </button>
          </div>
        </form>
      </Panel>

      <RequestsTable requests={requests} title="Vacation / Leave Report" />
    </div>
  );
}

export function ManagerLeaveApprovalWorkspace({
  leaveTypes,
  policy,
  requests,
}: WorkspaceCommon) {
  const [toast, setToast] = useState<string | null>(null);
  const pendingRequests = requests.filter((request) => request.status === "pending_manager");
  const upcoming = requests.filter((request) => request.status === "hr_approved" && request.startDate >= new Date().toISOString().slice(0, 10));

  async function decide(request: LeaveRequest, decision: "approved" | "rejected") {
    const comment = decision === "rejected" ? window.prompt("Rejection comment") : window.prompt("Manager comment (optional)");
    if (decision === "rejected" && !comment?.trim()) return setToast("A rejection comment is required.");
    const response = await fetch(`/api/leave/requests/${request.id}/manager-decision`, {
      body: JSON.stringify({ comment, decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to record decision.");
    setToast("Manager decision recorded.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  return (
    <div className="space-y-6">
      <Toast message={toast} />
      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending Manager" value={pendingRequests.length} />
        <MetricCard icon={<CalendarDays className="h-5 w-5" />} label="Upcoming Team Leaves" value={upcoming.length} />
        <MetricCard icon={<ShieldCheck className="h-5 w-5" />} label="Policy" value={policy?.name ?? "Default"} />
        <MetricCard icon={<Settings2 className="h-5 w-5" />} label="Active Types" value={leaveTypes.length} />
      </div>
      <RequestsTable
        actions={(request) => request.status === "pending_manager" ? (
          <>
            <button className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700" onClick={() => decide(request, "approved")} type="button">Approve</button>
            <button className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" onClick={() => decide(request, "rejected")} type="button">Reject</button>
          </>
        ) : null}
        requests={requests}
        title="Manager Leave Approval"
      />
    </div>
  );
}

function AdminFilters({ requests }: { requests: LeaveRequest[] }) {
  const lines = uniqueValues(requests, (request) => request.employee?.lineName);
  const areas = uniqueValues(requests, (request) => request.employee?.areaName);
  return (
    <Panel>
      <PanelHeader description="Filter HR reports by employee, HR_ID, line, area, status, type, month, year, and date range." icon={<SlidersHorizontal className="h-5 w-5" />} title="Report Filters" />
      <form action="/admin/leave" className="grid gap-3 p-4 sm:p-5 md:grid-cols-4 xl:grid-cols-8">
        <input className={fieldClassName} name="employee" placeholder="Employee" />
        <input className={fieldClassName} name="employeeHrId" placeholder="HR ID" />
        <select className={fieldClassName} name="line"><option value="">All lines</option>{lines.map((line) => <option key={line}>{line}</option>)}</select>
        <select className={fieldClassName} name="area"><option value="">All areas</option>{areas.map((area) => <option key={area}>{area}</option>)}</select>
        <select className={fieldClassName} name="status">
          <option value="">All statuses</option>
          {["pending_manager", "pending_hr", "hr_approved", "manager_rejected", "hr_rejected", "cancelled"].map((status) => <option key={status} value={status}>{prettyStatus(status)}</option>)}
        </select>
        <input className={fieldClassName} name="month" placeholder="Month" type="number" min="1" max="12" />
        <input className={fieldClassName} name="year" placeholder="Year" type="number" min="2024" max="2100" />
        <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Apply</button>
      </form>
    </Panel>
  );
}

function AdminSettings({
  holidays,
  leaveTypes,
  policies,
}: {
  holidays?: PublicHoliday[];
  leaveTypes: LeaveType[];
  policies: LeavePolicy[];
}) {
  const [toast, setToast] = useState<string | null>(null);
  const defaultPolicy = policies.find((policy) => policy.isDefault) ?? policies[0];

  async function post(url: string, body: unknown) {
    const response = await fetch(url, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to save settings.");
    setToast("Leave settings updated.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Toast message={toast} />
      <Panel>
        <PanelHeader description="Policy values are configurable and seeded with the Egypt Annual Leave Policy." icon={<ShieldCheck className="h-5 w-5" />} title="Leave Policy" />
        <form
          className="space-y-3 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            post("/api/leave/settings/policies", {
              annualDaysAfterFirstYear: Number(data.get("annualDaysAfterFirstYear")),
              annualDaysDisability: Number(data.get("annualDaysDisability")),
              annualDaysFirstYear: Number(data.get("annualDaysFirstYear")),
              annualDaysSenior: Number(data.get("annualDaysSenior")),
              id: defaultPolicy?.id,
              isDefault: true,
              name: String(data.get("name")),
              seniorAfterAge: Number(data.get("seniorAfterAge")),
              seniorAfterYears: Number(data.get("seniorAfterYears")),
              weekendDays: String(data.get("weekendDays")).split(",").map((item) => Number(item.trim())).filter(Number.isFinite),
            }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save policy."));
          }}
        >
          <input className={fieldClassName} defaultValue={defaultPolicy?.name ?? "Egypt Annual Leave Policy"} name="name" />
          <div className="grid grid-cols-2 gap-3">
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysFirstYear ?? 15} name="annualDaysFirstYear" type="number" step="0.25" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysAfterFirstYear ?? 21} name="annualDaysAfterFirstYear" type="number" step="0.25" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysSenior ?? 30} name="annualDaysSenior" type="number" step="0.25" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysDisability ?? 45} name="annualDaysDisability" type="number" step="0.25" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.seniorAfterYears ?? 10} name="seniorAfterYears" type="number" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.seniorAfterAge ?? 50} name="seniorAfterAge" type="number" />
          </div>
          <input className={fieldClassName} defaultValue={(defaultPolicy?.weekendDays ?? [5, 6]).join(",")} name="weekendDays" />
          <button className={cn(buttonClassName, "w-full bg-orange-600 text-white hover:bg-orange-700")} type="submit">Save Policy</button>
        </form>
      </Panel>

      <Panel>
        <PanelHeader description="Control paid status, payroll impact, attachments, and approval requirements." icon={<Settings2 className="h-5 w-5" />} title="Leave Types" />
        <div className="space-y-2 p-4 sm:p-5">
          {leaveTypes.map((type) => (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={type.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-black text-slate-950">{type.name}</p>
                <Badge variant={type.isActive ? "success" : "neutral"}>{type.isActive ? "Active" : "Inactive"}</Badge>
              </div>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{type.code}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHeader description="Public holidays are excluded from working-day calculations." icon={<CalendarDays className="h-5 w-5" />} title="Public Holidays" />
        <form
          className="grid gap-3 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            post("/api/leave/settings/holidays", {
              country: "EG",
              date: String(data.get("date")),
              name: String(data.get("name")),
            }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save holiday."));
          }}
        >
          <input className={fieldClassName} name="name" placeholder="Holiday name" required />
          <input className={fieldClassName} name="date" required type="date" />
          <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Add Holiday</button>
        </form>
        <div className="max-h-64 space-y-2 overflow-y-auto px-4 pb-4 sm:px-5">
          {(holidays ?? []).map((holiday) => (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" key={holiday.id}>
              <span className="text-sm font-bold text-slate-800">{holiday.name}</span>
              <span className="text-xs font-black text-slate-500">{formatDate(holiday.date)}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function AdminLeaveManagementWorkspace({
  dashboard,
  holidays,
  leaveTypes,
  policies,
  requests,
}: AdminLeaveWorkspaceProps) {
  const [toast, setToast] = useState<string | null>(null);
  const annualType = leaveTypes.find((type) => type.code === "annual_leave") ?? leaveTypes[0];

  async function hrDecision(request: LeaveRequest, decision: "approved" | "rejected") {
    const comment = decision === "rejected" ? window.prompt("HR rejection comment") : window.prompt("HR comment (optional)");
    if (decision === "rejected" && !comment?.trim()) return setToast("A rejection comment is required.");
    const response = await fetch(`/api/leave/requests/${request.id}/hr-decision`, {
      body: JSON.stringify({ comment, decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to record HR decision.");
    setToast("HR decision recorded.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  async function runAccrual() {
    const response = await fetch("/api/leave/accrual/run", { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to run accrual.");
    setToast(`Accrual processed for ${payload.processed} employees.`);
    window.setTimeout(() => window.location.reload(), 650);
  }

  async function adjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/leave/adjustments", {
      body: JSON.stringify({
        amount: Number(data.get("amount")),
        employeeHrId: String(data.get("employeeHrId")),
        leaveTypeId: String(data.get("leaveTypeId")),
        reason: String(data.get("reason")),
        year: Number(data.get("year")) || undefined,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to adjust balance.");
    setToast("Leave balance adjusted.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  return (
    <div className="space-y-6">
      <Toast message={toast} />
      <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
        <MetricCard icon={<FileText className="h-5 w-5" />} label="Total Requests" value={dashboard.totalRequests} />
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending" value={dashboard.pendingRequests} />
        <MetricCard icon={<CheckCircle2 className="h-5 w-5" />} label="Approved" value={dashboard.approvedRequests} />
        <MetricCard icon={<XCircle className="h-5 w-5" />} label="Rejected" value={dashboard.rejectedRequests} />
        <MetricCard icon={<CalendarCheck className="h-5 w-5" />} label="On Leave Today" value={dashboard.employeesOnLeaveToday} />
        <MetricCard icon={<CalendarDays className="h-5 w-5" />} label="Upcoming" value={dashboard.upcomingLeaves} />
        <MetricCard icon={<Gauge className="h-5 w-5" />} label="Lines Used" value={dashboard.leaveDaysByLine.length} />
        <MetricCard icon={<Banknote className="h-5 w-5" />} label="Utilization Lines" value={dashboard.leaveBalanceUtilization.length} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <AdminFilters requests={requests} />
        <Panel>
          <PanelHeader
            action={<button className={cn(buttonClassName, "bg-orange-600 text-white hover:bg-orange-700")} onClick={runAccrual} type="button"><Plus className="h-4 w-4" /> Run Accrual</button>}
            description="Create an audited adjustment transaction with mandatory reason."
            icon={<Gauge className="h-5 w-5" />}
            title="Manual Adjustment"
          />
          <form className="grid gap-3 p-4 sm:p-5" onSubmit={adjust}>
            <input className={fieldClassName} name="employeeHrId" placeholder="Employee HR ID" required />
            <select className={fieldClassName} defaultValue={annualType?.id} name="leaveTypeId">
              {leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <input className={fieldClassName} name="amount" placeholder="Days +/-" required step="0.25" type="number" />
              <input className={fieldClassName} defaultValue={new Date().getFullYear()} name="year" type="number" />
            </div>
            <textarea className={textAreaClassName} name="reason" placeholder="Adjustment reason" required />
            <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Record Adjustment</button>
          </form>
        </Panel>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-black tracking-tight text-slate-950">Requests Report</h2>
        <a className={cn(buttonClassName, "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50")} href="/api/leave/export">
          <Download className="h-4 w-4" />
          Export Excel
        </a>
      </div>

      <RequestsTable
        actions={(request) => request.status === "pending_hr" ? (
          <>
            <button className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700" onClick={() => hrDecision(request, "approved")} type="button">HR Approve</button>
            <button className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" onClick={() => hrDecision(request, "rejected")} type="button">HR Reject</button>
          </>
        ) : null}
        requests={requests}
        title="Admin Leave Requests Report"
      />

      <AdminSettings holidays={holidays} leaveTypes={leaveTypes} policies={policies} />
    </div>
  );
}
