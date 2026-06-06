"use client";

import { useMemo, useState, useTransition } from "react";
import {
  CalendarCheck,
  CheckCircle2,
  CircleAlert,
  Edit3,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeePlanKind, EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";
import { buildEmployeePlanPeriod, employeePlanActivityTypes } from "@/lib/weekly-planning/plan-v1";
import type { EmployeePlan, EmployeePlanItemInput, EmployeePlansWorkspace } from "@/lib/weekly-planning/service";

type PlansWorkspaceProps = {
  access: AccessContext;
  basePath?: "/admin/weekly-plans" | "/employee-portals/plans";
  initialWorkspace: EmployeePlansWorkspace;
  selectedPlanId?: string | null;
};

type DraftItem = EmployeePlanItemInput & { key: string };

const statusLabels: Record<EmployeePlanStatus, string> = {
  cancelled: "Cancelled",
  ceo_approved: "CEO approved",
  ceo_rejected: "CEO rejected",
  ceo_returned: "CEO returned",
  draft: "Draft",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  manager_rejected: "Manager rejected",
  manager_returned: "Manager returned",
  submitted: "Submitted",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function defaultRows(kind: EmployeePlanKind, anchorDate: string): DraftItem[] {
  const period = buildEmployeePlanPeriod(kind, anchorDate);
  const count = kind === "weekly"
    ? 5
    : Math.min(31, Math.round((Date.parse(`${period.periodEndDate}T00:00:00Z`) - Date.parse(`${period.periodStartDate}T00:00:00Z`)) / 86400000) + 1);
  return Array.from({ length: count }, (_, index) => ({
    activityDate: addDays(period.periodStartDate, index),
    activityTitle: index === 0 ? "Office" : "",
    activityType: "Office",
    area: "",
    attendees: "",
    endTime: "",
    key: `row-${index}-${period.periodStartDate}`,
    locationText: "",
    notes: "",
    objective: "",
    sortOrder: index,
    startTime: "",
  }));
}

function rowPayload(rows: DraftItem[]): EmployeePlanItemInput[] {
  return rows
    .filter((row) => row.activityTitle.trim() || row.objective?.trim() || row.attendees?.trim() || row.notes?.trim())
    .map((row, index) => ({
      activityDate: row.activityDate,
      activityTitle: row.activityTitle.trim() || row.activityType,
      activityType: row.activityType,
      area: row.area,
      attendees: row.attendees,
      endTime: row.endTime,
      locationText: row.locationText,
      notes: row.notes,
      objective: row.objective,
      sortOrder: index,
      startTime: row.startTime,
    }));
}

function planCanEdit(plan: EmployeePlan | null) {
  return !plan || ["draft", "manager_returned", "ceo_returned", "final_approved", "hr_acknowledged"].includes(plan.status);
}

function statusTone(status: EmployeePlanStatus) {
  if (status.includes("rejected")) return "border-red-200 bg-red-50 text-red-700";
  if (status.includes("returned")) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "final_approved" || status === "hr_acknowledged") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "submitted" || status === "manager_approved") return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function PlansWorkspace({
  access,
  basePath = "/employee-portals/plans",
  initialWorkspace,
  selectedPlanId,
}: PlansWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [activeKind, setActiveKind] = useState<EmployeePlanKind>("weekly");
  const [anchorDate, setAnchorDate] = useState(today());
  const [selectedPlan, setSelectedPlan] = useState<string | null>(selectedPlanId ?? null);
  const [rows, setRows] = useState<DraftItem[]>(() => defaultRows("weekly", today()));
  const [message, setMessage] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [isPending, startTransition] = useTransition();

  const period = useMemo(() => buildEmployeePlanPeriod(activeKind, anchorDate), [activeKind, anchorDate]);
  const plans = workspace.plans;
  const plan = plans.find((item) => item.id === selectedPlan) ?? null;
  const ownPlans = plans.filter((item) => item.employeeHrId === workspace.currentEmployee?.hrId);
  const managerQueue = plans.filter((item) => item.status === "submitted" && item.managerHrId === access.hrId);
  const ceoQueue = plans.filter((item) => item.status === "manager_approved" && (access.role === "CEO" || access.role === "Super Admin"));
  const hrQueue = plans.filter((item) => ["final_approved", "hr_acknowledged"].includes(item.status) && workspace.canAcknowledgeHr);
  const calendarRows = rows.filter((row) => row.activityDate >= period.periodStartDate && row.activityDate <= period.periodEndDate);

  function resetRows(kind: EmployeePlanKind, date: string) {
    setRows(defaultRows(kind, date));
  }

  function updateRow(key: string, field: keyof EmployeePlanItemInput, value: string) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, [field]: value } : row));
  }

  function addRow(date = period.periodStartDate) {
    setRows((current) => [
      ...current,
      {
        activityDate: date,
        activityTitle: "",
        activityType: "Office",
        area: "",
        attendees: "",
        endTime: "",
        key: `row-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        locationText: "",
        notes: "",
        objective: "",
        sortOrder: current.length,
        startTime: "",
      },
    ]);
  }

  async function reload() {
    const response = await fetch("/api/weekly-plans", { cache: "no-store" });
    const payload = await response.json();
    if (payload.success) setWorkspace(payload.data);
  }

  function runAction(action: () => Promise<void>) {
    setMessage(null);
    startTransition(async () => {
      try {
        await action();
        await reload();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Action failed.");
      }
    });
  }

  async function submitPlan(submit: boolean) {
    const payload = {
      anchorDate,
      items: rowPayload(rows),
      planKind: activeKind,
      submit,
    };
    const endpoint = plan ? `/api/weekly-plans/${plan.id}` : "/api/weekly-plans";
    const response = await fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: plan ? "PATCH" : "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to save plan.");
    setSelectedPlan(result.data.id);
    setMessage(submit ? "Plan submitted for direct manager review." : "Plan draft saved.");
  }

  async function decide(planId: string, action: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/decision`, {
      body: JSON.stringify({ action, comment }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComment("");
    setMessage("Decision recorded.");
  }

  async function acknowledge(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/acknowledge`, {
      body: JSON.stringify({ comment }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Acknowledgement failed.");
    setComment("");
    setMessage("HR acknowledgement recorded.");
  }

  function loadPlanForEdit(target: EmployeePlan) {
    setSelectedPlan(target.id);
    setActiveKind(target.planKind);
    setAnchorDate(target.periodStartDate);
    setRows(target.items.map((item, index) => ({
      activityDate: item.activityDate,
      activityTitle: item.activityTitle,
      activityType: item.activityType,
      area: item.area ?? "",
      attendees: item.attendees ?? "",
      endTime: item.endTime ?? "",
      key: item.id,
      locationText: item.locationText ?? "",
      notes: item.notes,
      objective: item.objective ?? "",
      sortOrder: index,
      startTime: item.startTime ?? "",
    })));
  }

  return (
    <div className="space-y-5">
      {!workspace.schemaReady ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          Planning database migration is not applied yet. Apply the staging migration before smoke testing.
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Eligibility</p>
          <p className="mt-2 text-lg font-black text-slate-900">
            {workspace.canSubmitPlans ? "Can submit plans" : "Review access only"}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {workspace.currentEmployee?.jobTitle ?? access.role}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Direct manager</p>
          <p className="mt-2 text-lg font-black text-slate-900">{workspace.currentEmployee?.managerName ?? "Not assigned"}</p>
          <p className="mt-1 text-sm text-slate-600">{workspace.currentEmployee?.managerHrId ?? "Manager HR ID missing"}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Google Calendar</p>
          <p className="mt-2 text-lg font-black text-slate-900">
            {workspace.googleCalendar.connected ? "Connected" : "Not connected"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
              href={`/api/integrations/google-calendar/connect?returnTo=${encodeURIComponent(basePath)}`}
            >
              <CalendarCheck className="mr-2 h-4 w-4" />
              Connect
            </a>
          </div>
        </div>
      </div>

      {message ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">{message}</div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
              {(["weekly", "monthly"] as const).map((kind) => (
                <button
                  className={`rounded-md px-4 py-2 text-sm font-bold ${activeKind === kind ? "bg-orange-600 text-white" : "text-slate-700 hover:bg-slate-50"}`}
                  key={kind}
                  onClick={() => {
                    setActiveKind(kind);
                    setSelectedPlan(null);
                    resetRows(kind, anchorDate);
                  }}
                  type="button"
                >
                  {kind === "weekly" ? "Weekly Plan" : "Monthly Plan"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                className="h-10 rounded-lg border border-slate-200 px-3 text-sm font-semibold"
                onChange={(event) => {
                  setAnchorDate(event.target.value);
                  resetRows(activeKind, event.target.value);
                }}
                type="date"
                value={anchorDate}
              />
              <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600">
                {period.periodKey}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-slate-900">Calendar view</h3>
                <p className="text-sm text-slate-600">{formatDate(period.periodStartDate)} - {formatDate(period.periodEndDate)}</p>
              </div>
              <Button disabled={!workspace.canSubmitPlans || !planCanEdit(plan)} onClick={() => addRow()} variant="secondary">
                <Edit3 className="mr-2 h-4 w-4" />
                Add row
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-5">
              {calendarRows.slice(0, activeKind === "weekly" ? 5 : 31).map((row) => (
                <button
                  className="min-h-[104px] rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-orange-200 hover:bg-orange-50"
                  key={row.key}
                  onClick={() => addRow(row.activityDate)}
                  type="button"
                >
                  <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">{formatDate(row.activityDate)}</p>
                  <p className="mt-2 text-sm font-bold text-slate-900">{row.activityTitle || "No activity"}</p>
                  <p className="mt-1 text-xs text-slate-600">{row.activityType}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="text-base font-black text-slate-900">Activity rows</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1180px] w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3">Time</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Title / objective</th>
                    <th className="px-3 py-3">Attendees</th>
                    <th className="px-3 py-3">Location / area</th>
                    <th className="px-3 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr className="border-t border-slate-100" key={row.key}>
                      <td className="px-3 py-3">
                        <input className="h-9 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityDate", event.target.value)} type="date" value={row.activityDate} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-2">
                          <input className="h-9 w-24 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "startTime", event.target.value)} type="time" value={row.startTime ?? ""} />
                          <input className="h-9 w-24 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "endTime", event.target.value)} type="time" value={row.endTime ?? ""} />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <select className="h-9 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityType", event.target.value)} value={row.activityType}>
                          {employeePlanActivityTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <input className="mb-2 h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityTitle", event.target.value)} placeholder="Activity title" value={row.activityTitle} />
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "objective", event.target.value)} placeholder="Objective" value={row.objective ?? ""} />
                      </td>
                      <td className="px-3 py-3">
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "attendees", event.target.value)} value={row.attendees ?? ""} />
                      </td>
                      <td className="px-3 py-3">
                        <input className="mb-2 h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "locationText", event.target.value)} placeholder="Location" value={row.locationText ?? ""} />
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "area", event.target.value)} placeholder="Area" value={row.area ?? ""} />
                      </td>
                      <td className="px-3 py-3">
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "notes", event.target.value)} value={row.notes ?? ""} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4">
              <Button disabled={isPending || !workspace.canSubmitPlans || !planCanEdit(plan)} onClick={() => runAction(() => submitPlan(false))} variant="secondary">Save draft</Button>
              <Button disabled={isPending || !workspace.canSubmitPlans || !planCanEdit(plan)} onClick={() => runAction(() => submitPlan(true))}>
                <Send className="mr-2 h-4 w-4" />
                Submit
              </Button>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <QueueCard title="My Plans" plans={ownPlans} onOpen={loadPlanForEdit} />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            plans={managerQueue}
            title="Manager Review"
            type="manager"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            plans={ceoQueue}
            title="CEO Review"
            type="ceo"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId) => runAction(() => acknowledge(planId))}
            plans={hrQueue}
            title="HR Acknowledgement"
            type="hr"
          />
        </aside>
      </div>
    </div>
  );
}

function QueueCard({ onOpen, plans, title }: { onOpen: (plan: EmployeePlan) => void; plans: EmployeePlan[]; title: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="font-black text-slate-900">{title}</h3>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.length === 0 ? <p className="text-sm font-semibold text-slate-500">No plans yet.</p> : null}
        {plans.map((plan) => (
          <button className="w-full rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50" key={plan.id} onClick={() => onOpen(plan)} type="button">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-black text-slate-900">{plan.planKind} {plan.periodKey}</p>
              <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${statusTone(plan.status)}`}>{statusLabels[plan.status]}</span>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-500">Revision {plan.revision} - Calendar {plan.calendarStatus}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function ReviewCard({
  comment,
  isPending,
  onComment,
  onDecision,
  plans,
  title,
  type,
}: {
  comment: string;
  isPending: boolean;
  onComment: (value: string) => void;
  onDecision: (planId: string, action: string) => void;
  plans: EmployeePlan[];
  title: string;
  type: "manager" | "ceo" | "hr";
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="font-black text-slate-900">{title}</h3>
      </div>
      <div className="space-y-3 p-3">
        {plans.length === 0 ? <p className="text-sm font-semibold text-slate-500">No pending items.</p> : null}
        {plans.map((plan) => (
          <div className="rounded-lg border border-slate-200 p-3" key={plan.id}>
            <p className="font-black text-slate-900">{plan.employeeName}</p>
            <p className="text-xs font-semibold text-slate-500">{plan.planKind} {plan.periodKey} - {statusLabels[plan.status]}</p>
            <textarea
              className="mt-3 min-h-20 w-full rounded-lg border border-slate-200 p-2 text-sm"
              onChange={(event) => onComment(event.target.value)}
              placeholder={type === "hr" ? "Acknowledgement note" : "Comment required for reject/return"}
              value={comment}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {type === "manager" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "manager_approve")}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</Button>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "manager_return")} variant="secondary"><RotateCcw className="mr-2 h-4 w-4" />Return</Button>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "manager_reject")} variant="destructive"><XCircle className="mr-2 h-4 w-4" />Reject</Button>
                </>
              ) : null}
              {type === "ceo" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "ceo_approve")}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</Button>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "ceo_return")} variant="secondary"><RotateCcw className="mr-2 h-4 w-4" />Return</Button>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "ceo_reject")} variant="destructive"><XCircle className="mr-2 h-4 w-4" />Reject</Button>
                </>
              ) : null}
              {type === "hr" ? (
                <Button disabled={isPending} onClick={() => onDecision(plan.id, "hr_acknowledge")} variant="secondary">
                  <CircleAlert className="mr-2 h-4 w-4" />
                  Acknowledge
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
