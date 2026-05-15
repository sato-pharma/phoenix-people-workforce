"use client";

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import {
  Banknote,
  BarChart3,
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
  RefreshCcw,
  UploadCloud,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type {
  ActiveEmployeeAccrualReport,
  LeaveAnalytics,
  LeaveAuditLog,
  LeaveCalendarItem,
  LeavePolicy,
  LeaveRequest,
  LeaveTitleWeekendRule,
  LeaveType,
  LeaveWallet,
  PublicHoliday,
  TeamAvailabilityDay,
  VacationReportWorkspace,
} from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import { ActiveEmployeesAccrualTable } from "./active-employees-accrual";
import { HistoricalVacationUpload } from "./historical-vacation-upload";
import { LeaveAnalyticsPanel } from "./leave-analytics-panel";
import { LeaveAvailabilityView } from "./leave-availability-view";
import { LeaveCalendarView } from "./leave-calendar-view";
import { LeaveRequestForm } from "./leave-request-form";
import { LeaveRequestHistory } from "./leave-request-history";
import { VacationReportTabs } from "./vacation-report";
import {
  buttonClassName,
  fieldClassName,
  formatDate,
  MetricCard,
  Panel,
  PanelHeader,
  textAreaClassName,
  Toast,
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
  defaultVacationTab?: "request" | "my" | "team" | "company";
  employeePolicy?: { hireDate: string | null; jobTitle: string | null; positionTitle: string | null };
  sickBackdateDays?: number;
  vacationReports?: VacationReportWorkspace | null;
  viewMode?: "reports" | "request";
  wallet: LeaveWallet;
  weekendDays?: number[];
};

type AdminManagementTabKey = "accrual" | "approvals" | "analytics" | "holidays" | "settings" | "upload";

type AdminLeaveWorkspaceProps = WorkspaceCommon & {
  activeEmployeesAccrual?: ActiveEmployeeAccrualReport | null;
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
  employeeRequestWorkspace?: EmployeeLeaveWorkspaceProps | null;
  policies: LeavePolicy[];
  titleWeekendRules?: LeaveTitleWeekendRule[];
  defaultManagementTab?: AdminManagementTabKey;
  defaultVacationTab?: "request" | "my" | "team" | "company";
  viewMode?: "management" | "reports" | "request";
  vacationReports?: VacationReportWorkspace | null;
};

function EmployeeVacationRequestPanel({
  calendarItems,
  employeePolicy,
  holidays,
  leaveTypes,
  policy,
  requests,
  sickBackdateDays,
  wallet,
  weekendDays,
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

      <LeaveRequestForm
        employeePolicy={employeePolicy}
        holidays={holidays}
        leaveTypes={leaveTypes}
        onToast={setToast}
        policy={policy}
        sickBackdateDays={sickBackdateDays}
        wallet={wallet}
        weekendDays={weekendDays}
      />

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

export function EmployeeLeaveWorkspace(props: EmployeeLeaveWorkspaceProps) {
  if (props.viewMode === "reports") {
    return (
      <VacationReportTabs
        action="/employee-portals/leave"
        defaultTab={props.defaultVacationTab ?? "my"}
        leaveTypes={props.leaveTypes}
        reports={props.vacationReports}
      />
    );
  }

  return <EmployeeVacationRequestPanel {...props} />;
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

function nationalVacationEndDate(holiday: PublicHoliday) {
  return holiday.endDate ?? holiday.date;
}

function nationalVacationDurationDays(holiday: PublicHoliday) {
  if (holiday.durationDays && holiday.durationDays > 0) return holiday.durationDays;
  const start = new Date(`${holiday.date}T00:00:00.000Z`);
  const end = new Date(`${nationalVacationEndDate(holiday)}T00:00:00.000Z`);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 1;
}

function nationalVacationOverlapsMonth(holiday: PublicHoliday, month: string, year: string) {
  if (!month && !year) return true;
  const numericYear = year ? Number(year) : Number(holiday.date.slice(0, 4));
  const numericMonth = month ? Number(month) : null;
  if (!Number.isFinite(numericYear)) return true;
  const rangeStart = numericMonth
    ? new Date(Date.UTC(numericYear, numericMonth - 1, 1)).toISOString().slice(0, 10)
    : `${numericYear}-01-01`;
  const rangeEnd = numericMonth
    ? new Date(Date.UTC(numericYear, numericMonth, 0)).toISOString().slice(0, 10)
    : `${numericYear}-12-31`;
  return holiday.date <= rangeEnd && nationalVacationEndDate(holiday) >= rangeStart;
}

function AdminSettings({
  holidays,
  leaveTypes,
  policies,
  titleWeekendRules,
}: {
  holidays?: PublicHoliday[];
  leaveTypes: LeaveType[];
  policies: LeavePolicy[];
  titleWeekendRules?: LeaveTitleWeekendRule[];
}) {
  const [toast, setToast] = useState<string | null>(null);
  const defaultPolicy = policies.find((policy) => policy.isDefault) ?? policies[0];
  const annualType = leaveTypes.find((type) => type.code === "annual_leave") ?? leaveTypes[0];

  async function post(url: string, body: unknown) {
    const response = await fetch(url, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to save settings.");
    setToast("Leave settings updated.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  async function syncGoogleHolidays() {
    const year = new Date().getFullYear();
    const results = [];
    for (const targetYear of [year, year + 1]) {
      const response = await fetch("/api/leave/settings/holidays/google-sync", {
        body: JSON.stringify({ country: "EG", year: targetYear }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to sync Google Calendar national vacations.");
      results.push(payload);
    }
    const synced = results.reduce((sum, item) => sum + Number(item.synced ?? 0), 0);
    const usedFallback = results.some((item) => item.source === "nager_date_fallback");
    setToast(`${usedFallback ? "Google Calendar failed; synced fallback" : "Synced Google Calendar"} national vacation(s): ${synced} for EG ${year}-${year + 1}.`);
    window.setTimeout(() => window.location.reload(), 900);
  }

  async function saveTitleWeekendRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rules = (titleWeekendRules ?? []).map((rule, index) => ({
      title: rule.title,
      weekendDays: String(data.get(`weekendDays-${index}`) ?? "5").split(",").map((item) => Number(item.trim())).filter(Number.isFinite),
    }));
    await post("/api/leave/settings/title-weekends", { rules });
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
              annualDaysFirstYear: Number(data.get("annualDaysFirstYear")),
              id: defaultPolicy?.id,
              isDefault: true,
              name: String(data.get("name")),
              weekendDays: String(data.get("weekendDays")).split(",").map((item) => Number(item.trim())).filter(Number.isFinite),
            }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save policy."));
          }}
        >
          <input className={fieldClassName} defaultValue={defaultPolicy?.name ?? "Egypt Annual Leave Policy"} name="name" />
          <div className="grid grid-cols-2 gap-3">
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysFirstYear ?? 15} name="annualDaysFirstYear" type="number" step="0.25" />
            <input className={fieldClassName} defaultValue={defaultPolicy?.annualDaysAfterFirstYear ?? 21} name="annualDaysAfterFirstYear" type="number" step="0.25" />
          </div>
          <select className={fieldClassName} defaultValue={(defaultPolicy?.weekendDays ?? [5, 6]).join(",")} name="weekendDays">
            <option value="5">Default: Friday only</option>
            <option value="5,6">Default: Friday + Saturday</option>
          </select>
          <button className={cn(buttonClassName, "w-full bg-orange-600 text-white hover:bg-orange-700")} type="submit">Save Policy</button>
        </form>
      </Panel>

      <Panel>
        <PanelHeader
          action={(
            <button
              className={cn(buttonClassName, "border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100")}
              onClick={() => syncGoogleHolidays().catch((error) => setToast(error instanceof Error ? error.message : "Unable to sync Google Calendar national vacations."))}
              type="button"
            >
              <RefreshCcw className="h-4 w-4" />
              Sync Google Calendar
            </button>
          )}
          description=""
          icon={<CalendarDays className="h-5 w-5" />}
          title="National Vacations"
        />
        <form
          className="grid gap-3 p-4 sm:p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            post("/api/leave/settings/holidays", {
              country: "EG",
              date: String(data.get("date")),
              name: String(data.get("name")),
            }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save national vacation."));
          }}
        >
          <input className={fieldClassName} name="name" placeholder="National vacation name" required />
          <input className={fieldClassName} name="date" required type="date" />
          <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Add National Vacation</button>
        </form>
        <div className="max-h-64 overflow-y-auto px-4 pb-4 sm:px-5">
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <th className="px-4 py-3">National Vacation</th>
                  <th className="px-4 py-3">Start Date</th>
                  <th className="px-4 py-3">End Date</th>
                  <th className="px-4 py-3">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {(holidays ?? []).map((holiday) => (
                  <tr className="bg-white transition hover:bg-slate-50" key={holiday.id}>
                    <td className="px-4 py-3 font-black text-slate-900">{holiday.name}</td>
                    <td className="px-4 py-3 font-semibold text-slate-700">{formatDate(holiday.date)}</td>
                    <td className="px-4 py-3 font-semibold text-slate-700">{formatDate(nationalVacationEndDate(holiday))}</td>
                    <td className="px-4 py-3 font-semibold text-slate-700">
                      {nationalVacationDurationDays(holiday)} day{nationalVacationDurationDays(holiday) === 1 ? "" : "s"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

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

      <Panel className="xl:col-span-3">
        <PanelHeader
          description="Set the weekly off days by employee title. Friday only means Saturday is counted as a working day."
          icon={<CalendarCheck className="h-5 w-5" />}
          title="Title Weekend Rules"
        />
        <form className="p-4 sm:p-5" onSubmit={(event) => saveTitleWeekendRules(event).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save title weekend rules."))}>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Employees</th>
                  <th className="px-4 py-3">Weekly Off Days</th>
                  <th className="px-4 py-3">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {(titleWeekendRules ?? []).map((rule, index) => (
                  <tr className="transition hover:bg-orange-50/40" key={rule.titleKey}>
                    <td className="px-4 py-3">
                      <p className="font-black text-slate-950">{rule.title}</p>
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-600">{rule.employeeCount}</td>
                    <td className="px-4 py-3">
                      <select className={fieldClassName} defaultValue={rule.weekendDays.join(",")} name={`weekendDays-${index}`}>
                        <option value="5">Friday only</option>
                        <option value="5,6">Friday + Saturday</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={rule.isConfigured ? "success" : "neutral"}>
                        {rule.isConfigured ? "Saved rule" : "System default"}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {(titleWeekendRules ?? []).length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm font-semibold text-slate-500" colSpan={4}>
                      No active employee titles found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <button className={cn(buttonClassName, "mt-4 w-full bg-slate-950 text-white hover:bg-slate-800")} type="submit">
            Save Title Weekend Rules
          </button>
        </form>
      </Panel>
    </div>
  );
}

function PublicHolidaySettings({ holidays }: { holidays?: PublicHoliday[] }) {
  const [toast, setToast] = useState<string | null>(null);
  const now = new Date();
  const [filterMonth, setFilterMonth] = useState(String(now.getMonth() + 1));
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));
  const filteredHolidays = (holidays ?? []).filter((holiday) => nationalVacationOverlapsMonth(holiday, filterMonth, filterYear));
  const availableYears = Array.from(new Set([
    String(now.getFullYear()),
    String(now.getFullYear() + 1),
    ...(holidays ?? []).flatMap((holiday) => [holiday.date.slice(0, 4), nationalVacationEndDate(holiday).slice(0, 4)]),
  ])).sort();

  async function post(url: string, body: unknown) {
    const response = await fetch(url, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Unable to save settings.");
    setToast("National vacations updated.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  async function syncGoogleHolidays() {
    const year = new Date().getFullYear();
    const results = [];
    for (const targetYear of [year, year + 1]) {
      const response = await fetch("/api/leave/settings/holidays/google-sync", {
        body: JSON.stringify({ country: "EG", year: targetYear }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to sync Google Calendar national vacations.");
      results.push(payload);
    }
    const synced = results.reduce((sum, item) => sum + Number(item.synced ?? 0), 0);
    const usedFallback = results.some((item) => item.source === "nager_date_fallback");
    setToast(`${usedFallback ? "Google Calendar failed; synced fallback" : "Synced Google Calendar"} national vacation(s): ${synced} for EG ${year}-${year + 1}.`);
    window.setTimeout(() => window.location.reload(), 900);
  }

  return (
    <Panel>
      <Toast message={toast} />
      <PanelHeader
        action={(
          <button
            className={cn(buttonClassName, "border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100")}
            onClick={() => syncGoogleHolidays().catch((error) => setToast(error instanceof Error ? error.message : "Unable to sync Google Calendar national vacations."))}
            type="button"
          >
            <RefreshCcw className="h-4 w-4" />
            Sync Google Calendar
          </button>
        )}
        description=""
        icon={<CalendarDays className="h-5 w-5" />}
        title="National Vacations"
      />
      <form
        className="grid gap-3 p-4 sm:p-5 md:grid-cols-[1fr_180px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          post("/api/leave/settings/holidays", {
            country: "EG",
            date: String(data.get("date")),
            name: String(data.get("name")),
          }).catch((error) => setToast(error instanceof Error ? error.message : "Unable to save national vacation."));
        }}
      >
        <input className={fieldClassName} name="name" placeholder="National vacation name" required />
        <input className={fieldClassName} name="date" required type="date" />
        <button className={cn(buttonClassName, "bg-slate-950 text-white hover:bg-slate-800")} type="submit">Add National Vacation</button>
      </form>
      <div className="grid gap-3 px-4 pb-4 sm:px-5 md:grid-cols-[220px_180px_auto]">
        <select className={fieldClassName} onChange={(event) => setFilterMonth(event.target.value)} value={filterMonth}>
          <option value="">All months</option>
          {Array.from({ length: 12 }, (_, index) => {
            const month = index + 1;
            const label = new Date(Date.UTC(2026, index, 1)).toLocaleString("en", { month: "long" });
            return <option key={month} value={month}>{label}</option>;
          })}
        </select>
        <select className={fieldClassName} onChange={(event) => setFilterYear(event.target.value)} value={filterYear}>
          <option value="">All years</option>
          {availableYears.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
        <button className={cn(buttonClassName, "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50")} onClick={() => { setFilterMonth(""); setFilterYear(""); }} type="button">
          Clear Filter
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto px-4 pb-4 sm:px-5">
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                <th className="px-4 py-3">National Vacation</th>
                <th className="px-4 py-3">Start Date</th>
                <th className="px-4 py-3">End Date</th>
                <th className="px-4 py-3">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredHolidays.map((holiday) => (
                <tr className="bg-white transition hover:bg-slate-50" key={holiday.id}>
                  <td className="px-4 py-3 font-black text-slate-900">{holiday.name}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700">{formatDate(holiday.date)}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700">{formatDate(nationalVacationEndDate(holiday))}</td>
                  <td className="px-4 py-3 font-semibold text-slate-700">
                    {nationalVacationDurationDays(holiday)} day{nationalVacationDurationDays(holiday) === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
              {filteredHolidays.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm font-semibold text-slate-500" colSpan={4}>
                    No national vacations found for the selected month and year.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

type HrBalanceDecision = "deduct" | "no_deduct";

function HrDecisionActions({
  onDecision,
  request,
}: {
  onDecision: (request: LeaveRequest, decision: "approved" | "rejected", balanceDecision?: HrBalanceDecision | null) => void;
  request: LeaveRequest;
}) {
  const [balanceDecision, setBalanceDecision] = useState<HrBalanceDecision>("deduct");
  const needsBalanceDecision = request.leaveType?.code === "other";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsBalanceDecision ? (
        <select
          className="h-9 rounded-xl border border-orange-200 bg-white px-3 text-xs font-black text-slate-800 outline-none focus:border-orange-400"
          data-testid="hr-other-balance-decision-select"
          onChange={(event) => setBalanceDecision(event.target.value as HrBalanceDecision)}
          value={balanceDecision}
        >
          <option value="deduct">Deduct Balance</option>
          <option value="no_deduct">Do Not Deduct</option>
        </select>
      ) : null}
      <button
        className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-700"
        data-testid="hr-leave-approve-button"
        onClick={() => onDecision(request, "approved", needsBalanceDecision ? balanceDecision : null)}
        type="button"
      >
        HR Approve
      </button>
      <button
        className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700"
        data-testid="hr-leave-reject-button"
        onClick={() => onDecision(request, "rejected", null)}
        type="button"
      >
        HR Reject
      </button>
    </div>
  );
}

export function AdminLeaveManagementWorkspace({
  activeEmployeesAccrual,
  calendarItems,
  capabilities,
  dashboard,
  defaultManagementTab = "accrual",
  defaultVacationTab,
  employeeRequestWorkspace,
  holidays,
  leaveTypes,
  policies,
  requests,
  teamAvailability,
  titleWeekendRules,
  viewMode = "management",
  vacationReports,
}: AdminLeaveWorkspaceProps) {
  const [toast, setToast] = useState<string | null>(null);
  const [managementTab, setManagementTab] = useState<AdminManagementTabKey>(defaultManagementTab);
  const annualType = leaveTypes.find((type) => type.code === "annual_leave") ?? leaveTypes[0];
  const canManageLeave = capabilities?.canManageLeave ?? true;
  const canExport = capabilities?.canExport ?? true;

  async function hrDecision(request: LeaveRequest, decision: "approved" | "rejected", balanceDecision?: HrBalanceDecision | null) {
    const comment = decision === "rejected" ? window.prompt("HR rejection comment") : window.prompt("HR comment (optional)");
    if (decision === "rejected" && !comment?.trim()) return setToast("A rejection comment is required.");
    if (decision === "approved" && request.leaveType?.code === "other" && balanceDecision !== "deduct" && balanceDecision !== "no_deduct") {
      return setToast("Choose whether Other leave deducts from balance before HR approval.");
    }
    const response = await fetch(`/api/leave/requests/${request.id}/hr-decision`, {
      body: JSON.stringify({ balanceDecision, comment, decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) return setToast(payload.error ?? "Unable to record HR decision.");
    setToast("HR decision recorded.");
    window.setTimeout(() => window.location.reload(), 650);
  }

  return (
    <div className="space-y-6" data-testid="admin-leave-workspace">
      <Toast message={toast} />
      {viewMode === "request" ? (
        employeeRequestWorkspace ? <EmployeeVacationRequestPanel {...employeeRequestWorkspace} /> : (
          <Panel>
            <PanelHeader
              description="A linked employee profile is required before this account can submit a vacation request."
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Vacation Request Unavailable"
            />
            <div className="px-5 py-8 text-sm font-semibold text-slate-600">
              No employee request workspace is available for this account.
            </div>
          </Panel>
        )
      ) : null}

      {viewMode === "reports" ? (
        <VacationReportTabs
          action="/admin/leave"
          defaultTab={defaultVacationTab ?? (vacationReports?.companyReport ? "company" : "my")}
          leaveTypes={leaveTypes}
          reports={vacationReports}
          showTemplateDownload={canManageLeave}
        />
      ) : null}

      {viewMode === "management" && canManageLeave ? (
        <Panel>
          <PanelHeader
            description="HR/Admin-only leave management is separated from vacation request and vacation report tabs. These panels keep audit logs centralized on the master audit page."
            icon={<Settings2 className="h-5 w-5" />}
            title="Leave Management"
          />
          <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
            {([
              ["accrual", "Employees Accrual", <Gauge className="h-4 w-4" key="accrual-icon" />],
              ["approvals", "Approval Queue", <ShieldCheck className="h-4 w-4" key="approvals-icon" />],
              ["analytics", "Analytics", <BarChart3 className="h-4 w-4" key="analytics-icon" />],
              ["holidays", "National Vacations", <CalendarDays className="h-4 w-4" key="holidays-icon" />],
              ["settings", "Policies / National Vacations / Adjustments", <Settings2 className="h-4 w-4" key="settings-icon" />],
              ["upload", "Historical Vacation Upload", <UploadCloud className="h-4 w-4" key="upload-icon" />],
            ] as Array<[AdminManagementTabKey, string, ReactNode]>).map(([key, label, icon]) => (
              <button
                className={cn(
                  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-xs font-black transition",
                  managementTab === key ? "bg-slate-950 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50",
                )}
                key={String(key)}
                onClick={() => setManagementTab(key)}
                type="button"
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <div className="space-y-5 p-4 sm:p-5">
            {managementTab === "accrual" ? <ActiveEmployeesAccrualTable report={activeEmployeesAccrual} /> : null}
            {managementTab === "approvals" ? (
              <>
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
                    <HrDecisionActions onDecision={hrDecision} request={request} />
                  ) : null}
                  detailActions={(request) => canManageLeave && request.status === "pending_hr" ? (
                    <HrDecisionActions onDecision={hrDecision} request={request} />
                  ) : null}
                  requests={requests}
                  title="Admin Leave Requests Report"
                />
              </>
            ) : null}
            {managementTab === "analytics" ? (
              <>
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
                <LeaveCalendarView holidays={holidays} initialItems={calendarItems} requests={requests} title="Enterprise Leave Calendar" />
                <LeaveAvailabilityView holidays={holidays} initialDays={teamAvailability} requests={requests} title="Enterprise Team Availability" />
                <LeaveAnalyticsPanel analytics={dashboard.analytics} holidays={holidays} requests={requests} />
              </>
            ) : null}
            {managementTab === "holidays" ? <PublicHolidaySettings holidays={holidays} /> : null}
            {managementTab === "settings" ? (
              <AdminSettings
                holidays={holidays}
                leaveTypes={leaveTypes}
                policies={policies}
                titleWeekendRules={titleWeekendRules}
              />
            ) : null}
            {managementTab === "upload" ? <HistoricalVacationUpload /> : null}
          </div>
        </Panel>
      ) : null}

      {viewMode === "management" && !canManageLeave ? (
        <Panel>
          <PanelHeader
            description="Settings, manual adjustments, and historical upload are restricted to HR and Super Admin roles."
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Restricted HR Controls"
          />
          <div className="px-5 py-8 text-sm font-semibold text-slate-600">
            Your current role can review permitted leave records, but cannot run accruals or change leave configuration.
          </div>
        </Panel>
      ) : null}

    </div>
  );
}
