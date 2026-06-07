"use client";

import { useMemo, useState, useTransition } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Download,
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
  showTimeColumn?: boolean;
  showAttendeesColumn?: boolean;
  showAreaColumn?: boolean;
  showWorkplaceMemoField?: boolean;
  workplaceRegions?: string[];
};

type DraftItem = EmployeePlanItemInput & {
  key: string;
  returnNotes?: EmployeePlan["items"][number]["returnNotes"];
};

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
    doubleVisitMedicalRepHrId: "",
    doubleVisitMedicalRepName: "",
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
    .filter((row) => row.activityTitle.trim() || row.objective?.trim() || row.attendees?.trim() || row.doubleVisitMedicalRepHrId?.trim() || row.notes?.trim())
    .map((row, index) => ({
      activityDate: row.activityDate,
      activityTitle: row.activityTitle.trim() || row.activityType,
      activityType: row.activityType,
      area: row.area,
      attendees: row.attendees,
      doubleVisitMedicalRepHrId: row.activityType === "Double Visit" ? row.doubleVisitMedicalRepHrId : null,
      doubleVisitMedicalRepName: row.activityType === "Double Visit" ? row.doubleVisitMedicalRepName : null,
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
  initialWorkspace,
  selectedPlanId,
  showTimeColumn = true,
  showAttendeesColumn = true,
  showAreaColumn = true,
  showWorkplaceMemoField = false,
  workplaceRegions = [],
}: PlansWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [activeKind, setActiveKind] = useState<EmployeePlanKind>("weekly");
  const [anchorDate, setAnchorDate] = useState(today());
  const [selectedPlan, setSelectedPlan] = useState<string | null>(selectedPlanId ?? null);
  const [rows, setRows] = useState<DraftItem[]>(() => defaultRows("weekly", today()));
  const [message, setMessage] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [returnNotes, setReturnNotes] = useState<Record<string, Record<string, string>>>({});
  const [isPending, startTransition] = useTransition();

  const period = useMemo(() => buildEmployeePlanPeriod(activeKind, anchorDate), [activeKind, anchorDate]);
  const plans = workspace.plans;
  const plan = plans.find((item) => item.id === selectedPlan) ?? null;
  const ownPlans = plans.filter((item) => item.employeeHrId === workspace.currentEmployee?.hrId);
  const managerQueue = plans.filter((item) => item.status === "submitted" && item.managerHrId === access.hrId);
  const ceoQueue = plans.filter((item) => item.status === "manager_approved" && (access.role === "CEO" || access.role === "Super Admin"));
  const hrQueue = plans.filter((item) => ["final_approved", "hr_acknowledged"].includes(item.status) && workspace.canAcknowledgeHr);
  const calendarRows = rows.filter((row) => row.activityDate >= period.periodStartDate && row.activityDate <= period.periodEndDate);
  const normalizedWorkplaceRegions = useMemo(() => {
    const unique = Array.from(new Set(workplaceRegions.map((region) => String(region ?? "").trim()).filter(Boolean)));
    unique.sort((left, right) => left.localeCompare(right));
    return unique;
  }, [workplaceRegions]);
  const workplaceRegionSet = useMemo(() => new Set(normalizedWorkplaceRegions.map((region) => region.toLowerCase())), [normalizedWorkplaceRegions]);

  function resetRows(kind: EmployeePlanKind, date: string) {
    setRows(defaultRows(kind, date));
  }

  function updateRow(key: string, field: keyof EmployeePlanItemInput, value: string) {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      if (field === "activityType" && value !== "Double Visit") {
        return {
          ...row,
          activityType: value as EmployeePlanItemInput["activityType"],
          doubleVisitMedicalRepHrId: "",
          doubleVisitMedicalRepName: "",
        };
      }
      return { ...row, [field]: value };
    }));
  }

  function updateReturnNote(planId: string, itemId: string, value: string) {
    setReturnNotes((current) => ({
      ...current,
      [planId]: {
        ...(current[planId] ?? {}),
        [itemId]: value,
      },
    }));
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
        doubleVisitMedicalRepHrId: "",
        doubleVisitMedicalRepName: "",
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
    const rowNotes = action.includes("return")
      ? Object.entries(returnNotes[planId] ?? {})
          .map(([itemId, note]) => ({ itemId, note: note.trim() }))
          .filter((note) => note.note)
      : [];
    const response = await fetch(`/api/weekly-plans/${planId}/decision`, {
      body: JSON.stringify({ action, comment, returnNotes: rowNotes }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComment("");
    if (action.includes("return")) {
      setReturnNotes((current) => ({ ...current, [planId]: {} }));
    }
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

  function downloadExport(url: string) {
    window.location.assign(url);
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
      doubleVisitMedicalRepHrId: item.doubleVisitMedicalRepHrId ?? "",
      doubleVisitMedicalRepName: item.doubleVisitMedicalRepName ?? "",
      endTime: item.endTime ?? "",
      key: item.id,
      locationText: item.locationText ?? "",
      notes: item.notes,
      objective: item.objective ?? "",
      returnNotes: item.returnNotes,
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
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryTile label="Drafts" value={workspace.summary.drafts} />
        <SummaryTile label="Manager pending" value={workspace.summary.managerPending} />
        <SummaryTile label="CEO pending" value={workspace.summary.ceoPending} />
        <SummaryTile label="Final approved" value={workspace.summary.finalApproved} />
        <SummaryTile label="HR acknowledged" value={workspace.summary.hrAcknowledged} />
        <SummaryTile label="Returned" value={workspace.summary.returned} tone="amber" />
        <SummaryTile label="Rejected" value={workspace.summary.rejected} tone="red" />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
          onClick={() => downloadExport("/api/weekly-plans/export?format=xlsx")}
          type="button"
        >
          <Download className="mr-2 h-4 w-4" />
          Export visible XLSX
        </button>
        <button
          className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
          onClick={() => downloadExport("/api/weekly-plans/export?format=pdf")}
          type="button"
        >
          <Download className="mr-2 h-4 w-4" />
          Export visible PDF
        </button>
        {plan ? (
          <>
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg border border-orange-200 bg-orange-50 px-3 text-sm font-bold text-orange-800 hover:bg-orange-100"
              onClick={() => downloadExport(`/api/weekly-plans/export?format=xlsx&planId=${encodeURIComponent(plan.id)}`)}
              type="button"
            >
              <Download className="mr-2 h-4 w-4" />
              Selected XLSX
            </button>
            <button
              className="inline-flex h-9 items-center justify-center rounded-lg border border-orange-200 bg-orange-50 px-3 text-sm font-bold text-orange-800 hover:bg-orange-100"
              onClick={() => downloadExport(`/api/weekly-plans/export?format=pdf&planId=${encodeURIComponent(plan.id)}`)}
              type="button"
            >
              <Download className="mr-2 h-4 w-4" />
              Selected PDF
            </button>
          </>
        ) : null}
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
              <table className="min-w-[1460px] w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">Date</th>
              {showTimeColumn ? <th className="px-3 py-3">Time</th> : null}
                    <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3 w-56">Title / objective</th>
                    {showAttendeesColumn ? <th className="px-3 py-3">Attendees</th> : null}
                      <th className="px-3 py-3">Workplace</th>
                    {showAreaColumn ? <th className="px-3 py-3">Area</th> : null}
                    <th className="px-3 py-3">Double visit Medical Rep</th>
                    <th className="px-3 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const hasReturnNotes = Boolean(row.returnNotes?.length);
                    return (
                    <tr className={`border-t ${hasReturnNotes ? "border-amber-200 bg-amber-50/40" : "border-slate-100"}`} key={row.key}>
                      <td className="px-3 py-3">
                        <input className="h-9 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityDate", event.target.value)} type="date" value={row.activityDate} />
                      </td>
              {showTimeColumn ? (
                <td className="px-3 py-3">
                  <div className="flex gap-2">
                    <input className="h-9 w-24 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "startTime", event.target.value)} type="time" value={row.startTime ?? ""} />
                    <input className="h-9 w-24 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "endTime", event.target.value)} type="time" value={row.endTime ?? ""} />
                  </div>
                </td>
              ) : null}
                      <td className="px-3 py-3">
                        <select className="h-9 rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityType", event.target.value)} value={row.activityType}>
                          {employeePlanActivityTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-3 w-56">
                        <input className="mb-2 h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "activityTitle", event.target.value)} placeholder="Activity title" value={row.activityTitle} />
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "objective", event.target.value)} placeholder="Objective" value={row.objective ?? ""} />
                      </td>
                      {showAttendeesColumn ? (
                        <td className="px-3 py-3">
                          <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "attendees", event.target.value)} value={row.attendees ?? ""} />
                        </td>
                      ) : null}
                      <td className="px-3 py-3">
                        <select
                          className="h-9 w-full rounded-md border border-slate-200 px-2"
                          disabled={!planCanEdit(plan)}
                          onChange={(event) => updateRow(row.key, "locationText", event.target.value)}
                          value={row.locationText ?? ""}
                        >
                          <option value="">Select region</option>
                          {row.locationText && !workplaceRegionSet.has(String(row.locationText).toLowerCase()) ? (
                            <option value={row.locationText}>{row.locationText}</option>
                          ) : null}
                          {normalizedWorkplaceRegions.map((region) => <option key={region} value={region}>{region}</option>)}
                        </select>
                        {showWorkplaceMemoField ? (
                          <input
                            className="mt-2 h-9 w-full rounded-md border border-slate-200 px-2"
                            disabled={!planCanEdit(plan)}
                            onChange={(event) => updateRow(row.key, "area", event.target.value)}
                            placeholder="Area"
                            value={row.area ?? ""}
                            type="text"
                          />
                        ) : null}
                      </td>
                      {showAreaColumn ? (
                        <td className="px-3 py-3">
                          <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "area", event.target.value)} placeholder="Area" value={row.area ?? ""} />
                        </td>
                      ) : null}
                      <td className="px-3 py-3">
                        {row.activityType === "Double Visit" ? (
                          <select
                            className="h-9 w-full rounded-md border border-slate-200 px-2"
                            disabled={!planCanEdit(plan) || workspace.medicalRepOptions.length === 0}
                            onChange={(event) => updateRow(row.key, "doubleVisitMedicalRepHrId", event.target.value)}
                            value={row.doubleVisitMedicalRepHrId ?? ""}
                          >
                            <option value="">Select Medical Rep</option>
                            {row.doubleVisitMedicalRepHrId && !workspace.medicalRepOptions.some((rep) => rep.hrId === row.doubleVisitMedicalRepHrId) ? (
                              <option value={row.doubleVisitMedicalRepHrId}>
                                {row.doubleVisitMedicalRepName || row.doubleVisitMedicalRepHrId}
                              </option>
                            ) : null}
                            {workspace.medicalRepOptions.map((rep) => (
                              <option key={rep.hrId} value={rep.hrId}>
                                {rep.fullName}{rep.areaName ? ` - ${rep.areaName}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs font-semibold text-slate-400">Only for Double Visit</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <input className="h-9 w-full rounded-md border border-slate-200 px-2" disabled={!planCanEdit(plan)} onChange={(event) => updateRow(row.key, "notes", event.target.value)} value={row.notes ?? ""} />
                        {hasReturnNotes ? (
                          <div className="mt-2 space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                            {row.returnNotes?.map((note) => (
                              <p key={note.id}>{note.actorRole ?? "Reviewer"}: {note.note}</p>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );})}
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
          <QueueCard
            onOpen={loadPlanForEdit}
            plans={ownPlans}
            title="My Plans"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onReturnNote={updateReturnNote}
            plans={managerQueue}
            returnNotes={returnNotes}
            title="Manager Review"
            type="manager"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onReturnNote={updateReturnNote}
            plans={ceoQueue}
            returnNotes={returnNotes}
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

function SummaryTile({ label, tone = "slate", value }: { label: string; tone?: "amber" | "red" | "sky" | "slate"; value: number }) {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    slate: "border-slate-200 bg-white text-slate-900",
  }[tone];
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <p className="text-xs font-bold uppercase text-current">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

function QueueCard({
  onOpen,
  plans,
  title,
}: {
  onOpen: (plan: EmployeePlan) => void;
  plans: EmployeePlan[];
  title: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="font-black text-slate-900">{title}</h3>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.length === 0 ? <p className="text-sm font-semibold text-slate-500">No plans yet.</p> : null}
        {plans.map((plan) => (
          <div className="rounded-lg border border-slate-200 p-3 hover:bg-slate-50" key={plan.id}>
          <button className="w-full text-left" onClick={() => onOpen(plan)} type="button">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-black text-slate-900">{plan.planKind} {plan.periodKey}</p>
              <span className={`rounded-full border px-2 py-1 text-[11px] font-black ${statusTone(plan.status)}`}>{statusLabels[plan.status]}</span>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-500">Revision {plan.revision}</p>
          </button>
          </div>
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
  onReturnNote,
  plans,
  returnNotes,
  title,
  type,
}: {
  comment: string;
  isPending: boolean;
  onComment: (value: string) => void;
  onDecision: (planId: string, action: string) => void;
  onReturnNote?: (planId: string, itemId: string, value: string) => void;
  plans: EmployeePlan[];
  returnNotes?: Record<string, Record<string, string>>;
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
            {type !== "hr" ? (
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                {plan.items.map((item) => (
                  <label className="block" key={item.id}>
                    <span className="block text-xs font-black text-slate-600">
                      {formatDate(item.activityDate)} - {item.activityTitle}
                    </span>
                    <input
                      className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-sm"
                      onChange={(event) => onReturnNote?.(plan.id, item.id, event.target.value)}
                      placeholder="Optional row return note"
                      value={returnNotes?.[plan.id]?.[item.id] ?? ""}
                    />
                  </label>
                ))}
              </div>
            ) : null}
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
                <>
                  <Button disabled={isPending} onClick={() => onDecision(plan.id, "hr_acknowledge")} variant="secondary">
                    <CircleAlert className="mr-2 h-4 w-4" />
                    Acknowledge
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
