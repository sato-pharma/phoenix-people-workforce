"use client";

import type { FormEvent } from "react";
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
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  LeaveAccrualPreview,
  LeaveAnalytics,
  LeaveAuditLog,
  LeaveCalendarItem,
  LeavePolicy,
  LeaveRequest,
  LeaveType,
  LeaveWallet,
  PublicHoliday,
  TeamAvailabilityDay,
} from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import { LeaveAccrualPanel } from "./leave-accrual-panel";
import { LeaveActivityLog } from "./leave-activity-log";
import { LeaveAnalyticsPanel } from "./leave-analytics-panel";
import { LeaveAvailabilityView } from "./leave-availability-view";
import { LeaveCalendarView } from "./leave-calendar-view";
import { LeaveRequestForm } from "./leave-request-form";
import { LeaveRequestHistory } from "./leave-request-history";
import {
  buttonClassName,
  fieldClassName,
  formatDate,
  MetricCard,
  Panel,
  PanelHeader,
  prettyStatus,
  textAreaClassName,
  Toast,
  uniqueValues,
} from "./leave-ui-primitives";

type WorkspaceCommon = {
  calendarItems?: LeaveCalendarItem[];
  holidays?: PublicHoliday[];
  leaveTypes: LeaveType[];
  policy?: LeavePolicy;
  requests: LeaveRequest[];
  teamAvailability?: TeamAvailabilityDay[];
};

type EmployeeLeaveWorkspaceProps = WorkspaceCommon & {
  wallet: LeaveWallet;
};

type AdminLeaveWorkspaceProps = WorkspaceCommon & {
  accrualPreview?: LeaveAccrualPreview | null;
  activityLogs?: LeaveAuditLog[];
  capabilities?: {
    canExport: boolean;
    canManageLeave: boolean;
  };
  dashboard: {
    analytics?: LeaveAnalytics;
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

export function EmployeeLeaveWorkspace({
  calendarItems,
  holidays,
  leaveTypes,
  policy,
  requests,
  wallet,
}: EmployeeLeaveWorkspaceProps) {
  const [toast, setToast] = useState<string | null>(null);

  async function cancelRequest(request: LeaveRequest) {
    const comment = window.prompt("Cancellation comment (optional)");
    if (comment === null) return;
    const response = await fetch(`/api/leave/requests/${request.id}`, {
      body: JSON.stringify({ comment }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to cancel leave request.");
    setToast("Leave request cancelled.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  return (
    <div className="space-y-6" data-testid="employee-leave-workspace">
      <Toast message={toast} />
      <div className="grid gap-3 md:grid-cols-5">
        <MetricCard icon={<ShieldCheck className="h-5 w-5" />} label="Annual Entitlement" value={wallet.annualEntitlement} />
        <MetricCard icon={<Plus className="h-5 w-5" />} label="Accrued" value={wallet.accrued} />
        <MetricCard icon={<CheckCircle2 className="h-5 w-5" />} label="Used" value={wallet.used} />
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending" value={wallet.pending} />
        <MetricCard icon={<Gauge className="h-5 w-5" />} label="Available" value={wallet.available} />
      </div>

      <LeaveRequestForm holidays={holidays} leaveTypes={leaveTypes} onToast={setToast} policy={policy} />

      <LeaveCalendarView
        holidays={holidays}
        initialItems={calendarItems}
        requests={requests}
        title="My Leave Calendar"
      />

      <LeaveRequestHistory
        actions={(request) => ["pending_manager", "manager_approved", "pending_hr"].includes(request.status) ? (
          <button
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 hover:bg-rose-100"
            data-testid="employee-leave-cancel-button"
            onClick={() => cancelRequest(request)}
            type="button"
          >
            Cancel
          </button>
        ) : null}
        requests={requests}
        title="Vacation / Leave Report"
      />
    </div>
  );
}

export function ManagerLeaveApprovalWorkspace({
  calendarItems,
  holidays,
  leaveTypes,
  policy,
  requests,
  teamAvailability,
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
    <div className="space-y-6" data-testid="manager-leave-workspace">
      <Toast message={toast} />
      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending Manager" value={pendingRequests.length} />
        <MetricCard icon={<CalendarDays className="h-5 w-5" />} label="Upcoming Team Leaves" value={upcoming.length} />
        <MetricCard icon={<ShieldCheck className="h-5 w-5" />} label="Policy" value={policy?.name ?? "Default"} />
        <MetricCard icon={<Settings2 className="h-5 w-5" />} label="Active Types" value={leaveTypes.length} />
      </div>
      <LeaveCalendarView
        holidays={holidays}
        initialItems={calendarItems}
        requests={requests}
        title="Team Leave Calendar"
      />
      <LeaveAvailabilityView
        holidays={holidays}
        initialDays={teamAvailability}
        requests={requests}
        title="Team Availability"
      />
      <LeaveRequestHistory
        actions={(request) => request.status === "pending_manager" ? (
          <>
            <button className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700" data-testid="manager-leave-approve-button" onClick={() => decide(request, "approved")} type="button">Approve</button>
            <button className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" data-testid="manager-leave-reject-button" onClick={() => decide(request, "rejected")} type="button">Reject</button>
          </>
        ) : null}
        requests={requests}
        title="Manager Leave Approval"
      />
    </div>
  );
}

function AdminFilters({ leaveTypes, requests }: { leaveTypes: LeaveType[]; requests: LeaveRequest[] }) {
  const lines = uniqueValues(requests, (request) => request.employee?.lineName);
  const areas = uniqueValues(requests, (request) => request.employee?.areaName);
  const managers = uniqueValues(requests, (request) => request.employee?.managerHrId);
  return (
    <Panel>
      <PanelHeader description="Filter HR reports by employee, HR_ID, line, area, status, type, month, year, and date range." icon={<SlidersHorizontal className="h-5 w-5" />} title="Report Filters" />
      <form action="/admin/leave" className="grid gap-3 p-4 sm:p-5 md:grid-cols-4 xl:grid-cols-8">
        <input className={fieldClassName} name="employee" placeholder="Employee" />
        <input className={fieldClassName} name="employeeHrId" placeholder="HR ID" />
        <select className={fieldClassName} name="line"><option value="">All lines</option>{lines.map((line) => <option key={line}>{line}</option>)}</select>
        <select className={fieldClassName} name="area"><option value="">All areas</option>{areas.map((area) => <option key={area}>{area}</option>)}</select>
        <select className={fieldClassName} name="managerHrId"><option value="">All managers</option>{managers.map((manager) => <option key={manager}>{manager}</option>)}</select>
        <select className={fieldClassName} name="leaveTypeId"><option value="">All leave types</option>{leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select>
        <select className={fieldClassName} name="status">
          <option value="">All statuses</option>
          {["pending_manager", "pending_hr", "hr_approved", "manager_rejected", "hr_rejected", "cancelled"].map((status) => <option key={status} value={status}>{prettyStatus(status)}</option>)}
        </select>
        <input className={fieldClassName} name="month" placeholder="Month" type="number" min="1" max="12" />
        <input className={fieldClassName} name="year" placeholder="Year" type="number" min="2024" max="2100" />
        <input className={fieldClassName} name="startDate" type="date" />
        <input className={fieldClassName} name="endDate" type="date" />
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
          <form
            className="rounded-2xl border border-orange-100 bg-orange-50/70 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              post("/api/leave/settings/types", {
                affectsPayroll: data.get("affectsPayroll") === "on",
                code: String(data.get("code")),
                isActive: data.get("isActive") === "on",
                isPaid: data.get("isPaid") === "on",
                name: String(data.get("name")),
                requiresAttachment: data.get("requiresAttachment") === "on",
                requiresHrApproval: data.get("requiresHrApproval") === "on",
                requiresManagerApproval: data.get("requiresManagerApproval") === "on",
              }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save leave type."));
            }}
          >
            <div className="grid gap-2 md:grid-cols-2">
              <input className={fieldClassName} name="name" placeholder="Leave type name" required />
              <input className={fieldClassName} name="code" placeholder="leave_type_code" required />
            </div>
            <div className="mt-3 grid gap-2 text-xs font-bold text-slate-700 sm:grid-cols-2">
              {[
                ["isPaid", "Paid leave", true],
                ["isActive", "Active", true],
                ["requiresManagerApproval", "Manager approval", true],
                ["requiresHrApproval", "HR approval", true],
                ["requiresAttachment", "Requires attachment", false],
                ["affectsPayroll", "Payroll impact metadata", false],
              ].map(([name, label, checked]) => (
                <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-orange-100" key={String(name)}>
                  <input className="h-4 w-4 rounded border-slate-300 text-orange-600" defaultChecked={Boolean(checked)} name={String(name)} type="checkbox" />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <button className={cn(buttonClassName, "mt-3 w-full bg-slate-950 text-white hover:bg-slate-800")} type="submit">Save Leave Type</button>
          </form>
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
  accrualPreview,
  activityLogs,
  calendarItems,
  capabilities,
  dashboard,
  holidays,
  leaveTypes,
  policies,
  requests,
  teamAvailability,
}: AdminLeaveWorkspaceProps) {
  const [toast, setToast] = useState<string | null>(null);
  const annualType = leaveTypes.find((type) => type.code === "annual_leave") ?? leaveTypes[0];
  const canManageLeave = capabilities?.canManageLeave ?? true;
  const canExport = capabilities?.canExport ?? true;

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
    <div className="space-y-6" data-testid="admin-leave-workspace">
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

      <LeaveCalendarView
        holidays={holidays}
        initialItems={calendarItems}
        requests={requests}
        title="Enterprise Leave Calendar"
      />

      <LeaveAvailabilityView
        holidays={holidays}
        initialDays={teamAvailability}
        requests={requests}
        title="Enterprise Team Availability"
      />

      <LeaveAnalyticsPanel analytics={dashboard.analytics} holidays={holidays} requests={requests} />

      {canManageLeave ? (
        <LeaveAccrualPanel onToast={setToast} preview={accrualPreview} />
      ) : (
        <Panel>
          <PanelHeader
            description="Monthly accrual, settings, and manual adjustments are restricted to HR and Super Admin roles."
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Restricted HR Controls"
          />
          <div className="px-5 py-8 text-sm font-semibold text-slate-600">
            Your current role can review permitted leave records, but cannot run accruals or change leave configuration.
          </div>
        </Panel>
      )}

      <div className={cn("grid gap-4", canManageLeave ? "xl:grid-cols-[1fr_380px]" : "")}>
        <AdminFilters leaveTypes={leaveTypes} requests={requests} />
        {canManageLeave ? (
          <Panel>
            <PanelHeader
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
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-black tracking-tight text-slate-950">Requests Report</h2>
        {canExport ? (
          <a className={cn(buttonClassName, "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50")} href="/api/leave/export">
            <Download className="h-4 w-4" />
            Export Excel
          </a>
        ) : null}
      </div>

      <LeaveRequestHistory
        actions={(request) => canManageLeave && request.status === "pending_hr" ? (
          <>
            <button className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700" data-testid="hr-leave-approve-button" onClick={() => hrDecision(request, "approved")} type="button">HR Approve</button>
            <button className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" data-testid="hr-leave-reject-button" onClick={() => hrDecision(request, "rejected")} type="button">HR Reject</button>
          </>
        ) : null}
        requests={requests}
        title="Admin Leave Requests Report"
      />

      {canManageLeave ? <AdminSettings holidays={holidays} leaveTypes={leaveTypes} policies={policies} /> : null}

      {canManageLeave ? <LeaveActivityLog logs={activityLogs} /> : null}
    </div>
  );
}
