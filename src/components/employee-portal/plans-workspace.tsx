"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
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

type DraftItem = EmployeePlanItemInput & {
  key: string;
  returnNotes?: EmployeePlan["items"][number]["returnNotes"];
};

type MedicalRepOption = EmployeePlansWorkspace["medicalRepOptions"][number];

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

const cin = "h-8 w-full rounded border border-slate-200 bg-white px-2 text-sm text-slate-800 placeholder:text-slate-300 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";
const csel = "h-8 w-full rounded border border-slate-200 bg-white px-2 text-sm text-slate-800 focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";
const cinNotes = "h-8 w-full rounded border border-orange-200 bg-orange-50/70 px-2 text-sm text-slate-800 placeholder:text-orange-300 focus:border-orange-400 focus:bg-orange-50 focus:outline-none focus:ring-1 focus:ring-orange-400/25 transition-colors duration-150 disabled:opacity-60 disabled:cursor-not-allowed";
const ROW_GRID = "grid grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_minmax(0,1.6fr)] gap-x-3";
// Taller field controls for the touch-friendly mobile bottom-sheet editor.
const mobileField = "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";

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

function formatDayName(value: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function defaultRows(kind: EmployeePlanKind, anchorDate: string): DraftItem[] {
  const period = buildEmployeePlanPeriod(kind, anchorDate);
  const count =
    kind === "weekly"
      ? 5
      : Math.min(
          31,
          Math.round(
            (Date.parse(`${period.periodEndDate}T00:00:00Z`) -
              Date.parse(`${period.periodStartDate}T00:00:00Z`)) /
              86400000,
          ) + 1,
        );
  return Array.from({ length: count }, (_, index) => ({
    activityDate: addDays(period.periodStartDate, index),
    activityTitle: "",
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
  return rows.map((row, index) => ({
    activityDate: row.activityDate,
    activityTitle: row.activityType,
    activityType: row.activityType,
    area: row.area,
    attendees: row.attendees,
    doubleVisitMedicalRepHrId:
      row.activityType === "Double Visit" ? row.doubleVisitMedicalRepHrId : null,
    doubleVisitMedicalRepName:
      row.activityType === "Double Visit" ? row.doubleVisitMedicalRepName : null,
    endTime: row.endTime,
    locationText: row.locationText,
    notes: row.notes,
    objective: row.objective,
    sortOrder: index,
    startTime: row.startTime,
  }));
}

function planCanEdit(plan: EmployeePlan | null) {
  return (
    !plan ||
    ["draft", "manager_returned", "ceo_returned", "final_approved", "hr_acknowledged"].includes(
      plan.status,
    )
  );
}

function statusTone(status: EmployeePlanStatus) {
  if (status.includes("rejected")) return "border-red-200 bg-red-50 text-red-700";
  if (status.includes("returned")) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "final_approved" || status === "hr_acknowledged")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "submitted" || status === "manager_approved")
    return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function areasForRegion(options: MedicalRepOption[], region: string): string[] {
  if (!region) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rep of options) {
    if (rep.regionName?.toLowerCase() === region.toLowerCase() && rep.areaName) {
      const k = rep.areaName.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        result.push(rep.areaName);
      }
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function repForArea(options: MedicalRepOption[], area: string): MedicalRepOption | null {
  if (!area) return null;
  return options.find((r) => r.areaName?.toLowerCase() === area.toLowerCase()) ?? null;
}

/** Map raw service/DB/workflow errors to short, friendly, action-oriented messages. UI-only. */
function friendlyError(message: string): string {
  const text = message || "Action failed.";
  if (/duplicate key|already exists|active_period_uidx|23505/i.test(text)) {
    return "You already have an active plan for this period.";
  }
  if (/comment.*requires|requires a comment|COMMENT_REQUIRED/i.test(text)) {
    return "Please add a comment explaining the return or rejection.";
  }
  if (/Double Visit requires|not available for this employee line/i.test(text)) {
    return "Each Double Visit day needs a same-line Medical Rep selected.";
  }
  if (/^forbidden/i.test(text)) {
    return "You do not have permission to perform this action.";
  }
  return text;
}

export function PlansWorkspace({
  access,
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
  const [returnNotes, setReturnNotes] = useState<Record<string, Record<string, string>>>({});
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const period = useMemo(
    () => buildEmployeePlanPeriod(activeKind, anchorDate),
    [activeKind, anchorDate],
  );
  const plans = workspace.plans;
  const plan = plans.find((item) => item.id === selectedPlan) ?? null;
  const ownPlans = plans.filter(
    (item) => item.employeeHrId === workspace.currentEmployee?.hrId,
  );
  const managerQueue = plans.filter(
    (item) => item.status === "submitted" && item.managerHrId === access.hrId,
  );
  const ceoQueue = plans.filter(
    (item) =>
      item.status === "manager_approved" &&
      (access.role === "CEO" || access.role === "Super Admin"),
  );
  const hrQueue = plans.filter(
    (item) =>
      ["final_approved", "hr_acknowledged"].includes(item.status) &&
      workspace.canAcknowledgeHr,
  );
  const canEdit = planCanEdit(plan) && workspace.canSubmitPlans;
  const regions = useMemo(() => workspace.workplaceRegions, [workspace.workplaceRegions]);

  // Double Visit validation mirrors the server rule so we can block submit early.
  const hasDoubleVisit = rows.some((row) => row.activityType === "Double Visit");
  const doubleVisitMissingRep = rows.some(
    (row) => row.activityType === "Double Visit" && !row.doubleVisitMedicalRepHrId,
  );
  const noSameLineReps = hasDoubleVisit && workspace.medicalRepOptions.length === 0;
  const submitBlocked = !canEdit || doubleVisitMissingRep;

  const sheetRow = rows.find((row) => row.key === sheetKey) ?? null;

  // Lock body scroll while the mobile bottom sheet is open.
  useEffect(() => {
    if (!sheetRow) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetRow]);

  function resetRows(kind: EmployeePlanKind, date: string) {
    setRows(defaultRows(kind, date));
    setSheetKey(null);
  }

  function updateRow(key: string, field: keyof EmployeePlanItemInput, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        if (field === "activityType" && value !== "Double Visit") {
          return {
            ...row,
            activityType: value as EmployeePlanItemInput["activityType"],
            doubleVisitMedicalRepHrId: "",
            doubleVisitMedicalRepName: "",
          };
        }
        if (field === "locationText") return { ...row, locationText: value, area: "" };
        return { ...row, [field]: value };
      }),
    );
  }

  function setRowRep(key: string, hrId: string) {
    const found = workspace.medicalRepOptions.find((r) => r.hrId === hrId);
    setRows((current) =>
      current.map((r) =>
        r.key === key
          ? {
              ...r,
              doubleVisitMedicalRepHrId: hrId,
              doubleVisitMedicalRepName: found?.fullName ?? "",
            }
          : r,
      ),
    );
  }

  function deleteRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
    setSheetKey(null);
  }

  function addRow() {
    setRows((current) => {
      const last = current[current.length - 1];
      const nextDate = last ? addDays(last.activityDate, 1) : period.periodStartDate;
      return [
        ...current,
        {
          activityDate: nextDate,
          activityTitle: "",
          activityType: "Office",
          area: "",
          attendees: "",
          doubleVisitMedicalRepHrId: "",
          doubleVisitMedicalRepName: "",
          endTime: "",
          key: `row-add-${Date.now()}`,
          locationText: "",
          notes: "",
          objective: "",
          sortOrder: current.length,
          startTime: "",
        },
      ];
    });
  }

  function updateReturnNote(planId: string, itemId: string, value: string) {
    setReturnNotes((current) => ({
      ...current,
      [planId]: { ...(current[planId] ?? {}), [itemId]: value },
    }));
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
        setMessage(friendlyError(error instanceof Error ? error.message : "Action failed."));
      }
    });
  }

  async function submitPlan(submit: boolean) {
    const payload = { anchorDate, items: rowPayload(rows), planKind: activeKind, submit };
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
          .filter((n) => n.note)
      : [];
    const response = await fetch(`/api/weekly-plans/${planId}/decision`, {
      body: JSON.stringify({ action, comment, returnNotes: rowNotes }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComment("");
    if (action.includes("return")) setReturnNotes((c) => ({ ...c, [planId]: {} }));
    setMessage("Decision recorded.");
  }

  async function acknowledge(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/acknowledge`, {
      body: JSON.stringify({ comment }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.message ?? "Acknowledgement failed.");
    setComment("");
    setMessage("HR acknowledgement recorded.");
  }

  function loadPlanForEdit(target: EmployeePlan) {
    setSelectedPlan(target.id);
    setActiveKind(target.planKind);
    setAnchorDate(target.periodStartDate);
    setSheetKey(null);
    setRows(
      target.items.map((item, index) => ({
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
      })),
    );
  }

  function onKindChange(kind: EmployeePlanKind) {
    setActiveKind(kind);
    setSelectedPlan(null);
    resetRows(kind, anchorDate);
  }

  function onAnchorChange(value: string) {
    setAnchorDate(value);
    resetRows(activeKind, value);
  }

  const doubleVisitWarning = noSameLineReps
    ? "No same-line Medical Rep is available. Please contact your manager or change the activity type."
    : doubleVisitMissingRep
      ? "Each Double Visit day needs a same-line Medical Rep selected before you can submit."
      : null;

  const schemaBanner = !workspace.schemaReady ? (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
      Planning database migration is not applied yet.
    </div>
  ) : null;

  const messageBanner = message ? (
    <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">
      {message}
    </div>
  ) : null;

  return (
    <>
      {/* ===================== MOBILE (< md) ===================== */}
      <div className="space-y-4 pb-28 md:hidden">
        {schemaBanner}

        {/* Compact header */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-black text-slate-900">
                {activeKind === "weekly" ? "Weekly Plan" : "Monthly Plan"}
              </h2>
              <p className="mt-0.5 text-xs font-semibold text-slate-500">
                {formatDate(period.periodStartDate)} – {formatDate(period.periodEndDate)} · {period.periodKey}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-black ${statusTone(plan?.status ?? "draft")}`}
            >
              {statusLabels[plan?.status ?? "draft"]}
            </span>
          </div>

          <div className="mt-3">
            <ChoiceGroup
              aria-label="Plan type"
              className="grid-cols-2"
              onChange={onKindChange}
              options={[
                { label: "Weekly Plan", value: "weekly" },
                { label: "Monthly Plan", value: "monthly" },
              ]}
              value={activeKind}
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <input
              className="h-11 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) => onAnchorChange(event.target.value)}
              type="date"
              value={anchorDate}
            />
            <button
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 active:bg-slate-50"
              onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
              type="button"
            >
              <Download className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>

        {/* Info chips */}
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          <InfoChip
            label="Eligibility"
            value={workspace.canSubmitPlans ? "Can submit" : "Review only"}
          />
          <InfoChip
            label="Manager"
            value={workspace.currentEmployee?.managerName ?? "Not assigned"}
          />
          <InfoChip label="Secured" value="RLS · service-role only" />
        </div>

        {/* Mini KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <Kpi label="Drafts" value={workspace.summary.drafts} />
          <Kpi label="Pending" value={workspace.summary.managerPending + workspace.summary.ceoPending} />
          <Kpi label="Approved" value={workspace.summary.finalApproved} />
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}

        {doubleVisitWarning ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{doubleVisitWarning}</span>
          </div>
        ) : null}

        {/* Day cards */}
        <div className="space-y-2.5">
          {rows.map((row) => (
            <MobileDayCard
              key={row.key}
              medicalRepOptions={workspace.medicalRepOptions}
              onOpen={() => setSheetKey(row.key)}
              row={row}
            />
          ))}
          {canEdit ? (
            <button
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-orange-300 bg-orange-50/40 py-3 text-sm font-bold text-orange-600 active:bg-orange-50"
              onClick={addRow}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Add day
            </button>
          ) : null}
        </div>

        {/* My plans + review queues */}
        <div className="space-y-3">
          <QueueCard onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
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
        </div>
      </div>

      {/* Mobile sticky action bar (sits above the global bottom nav, clears safe area) */}
      {workspace.canSubmitPlans ? (
        <div
          className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
          style={{
            bottom: "var(--portal-bottom-nav-h, env(safe-area-inset-bottom))",
          }}
        >
          <Button
            className="flex-1"
            disabled={isPending || !canEdit}
            onClick={() => runAction(() => submitPlan(false))}
            variant="secondary"
          >
            Save draft
          </Button>
          <Button
            className="flex-1"
            disabled={isPending || submitBlocked}
            onClick={() => runAction(() => submitPlan(true))}
          >
            <Send className="mr-2 h-4 w-4" />
            Submit
          </Button>
        </div>
      ) : null}

      {/* Mobile bottom-sheet row editor */}
      {sheetRow ? (
        <RowEditSheet
          canEdit={canEdit}
          medicalRepOptions={workspace.medicalRepOptions}
          onClose={() => setSheetKey(null)}
          onDelete={() => deleteRow(sheetRow.key)}
          onRep={(hrId) => setRowRep(sheetRow.key, hrId)}
          onUpdate={(field, value) => updateRow(sheetRow.key, field, value)}
          regions={regions}
          row={sheetRow}
        />
      ) : null}

      {/* ===================== DESKTOP / TABLET (>= md) ===================== */}
      <div className="hidden min-w-0 space-y-5 md:block">
        {schemaBanner}

        {/* Context tiles */}
        <div className="grid gap-3 sm:grid-cols-2">
          <ContextTile
            accent="orange"
            label="Eligibility"
            sub={workspace.currentEmployee?.jobTitle ?? access.role ?? ""}
            value={workspace.canSubmitPlans ? "Can submit plans" : "Review access only"}
          />
          <ContextTile
            accent="slate"
            label="Direct manager"
            sub={workspace.currentEmployee?.managerHrId ?? "Manager HR ID missing"}
            value={workspace.currentEmployee?.managerName ?? "Not assigned"}
          />
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <Kpi label="Drafts" value={workspace.summary.drafts} />
          <Kpi label="Mgr pending" value={workspace.summary.managerPending} />
          <Kpi label="CEO pending" value={workspace.summary.ceoPending} />
          <Kpi label="Approved" value={workspace.summary.finalApproved} />
          <Kpi label="HR ack'd" value={workspace.summary.hrAcknowledged} />
          <Kpi label="Returned" tone="amber" value={workspace.summary.returned} />
          <Kpi label="Rejected" tone="red" value={workspace.summary.rejected} />
        </div>

        {/* Kind toggle + date picker */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded border border-slate-200 bg-white p-0.5">
            {(["weekly", "monthly"] as const).map((kind) => (
              <button
                className={`rounded px-4 py-1.5 text-sm font-bold transition-colors duration-150 ${
                  activeKind === kind ? "bg-orange-600 text-white" : "text-slate-700 hover:bg-slate-50"
                }`}
                key={kind}
                onClick={() => onKindChange(kind)}
                type="button"
              >
                {kind === "weekly" ? "Weekly Plan" : "Monthly Plan"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              className="h-9 rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) => onAnchorChange(event.target.value)}
              type="date"
              value={anchorDate}
            />
            <span className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-600">
              {period.periodKey}
            </span>
          </div>
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}

        {doubleVisitWarning ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{doubleVisitWarning}</span>
          </div>
        ) : null}

        {/* Main grid */}
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Plan table */}
          <section className="min-w-0 overflow-hidden rounded border border-slate-200 bg-white">
            {/* Dark header */}
            <div className="bg-slate-900 px-4 pb-3 pt-4">
              <div className={`${ROW_GRID} min-w-0 text-xs font-black uppercase tracking-[0.1em]`}>
                <div className="flex items-center gap-1.5 text-slate-300">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                  Date
                </div>
                <div className="flex items-center gap-1.5 text-sky-400">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                  Type
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                  Region
                </div>
                <div className="flex items-center gap-1.5 text-orange-400">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                  Area
                </div>
                <div className="flex items-center gap-1.5 text-violet-400">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                  Medical Rep
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-orange-500/50 pt-3">
                <button
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 text-xs font-bold text-slate-300 transition-colors duration-150 hover:border-orange-500/60 hover:text-orange-300"
                  onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
                  type="button"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export XLSX
                </button>
                <button
                  className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 text-xs font-bold text-slate-300 transition-colors duration-150 hover:border-orange-500/60 hover:text-orange-300"
                  onClick={() => window.location.assign("/api/weekly-plans/export?format=pdf")}
                  type="button"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export PDF
                </button>
                {plan ? (
                  <>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded border border-orange-500/40 bg-orange-900/20 px-2.5 text-xs font-bold text-orange-300 transition-colors duration-150 hover:border-orange-400 hover:text-orange-200"
                      onClick={() =>
                        window.location.assign(
                          `/api/weekly-plans/export?format=xlsx&planId=${encodeURIComponent(plan.id)}`,
                        )
                      }
                      type="button"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Selected XLSX
                    </button>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded border border-orange-500/40 bg-orange-900/20 px-2.5 text-xs font-bold text-orange-300 transition-colors duration-150 hover:border-orange-400 hover:text-orange-200"
                      onClick={() =>
                        window.location.assign(
                          `/api/weekly-plans/export?format=pdf&planId=${encodeURIComponent(plan.id)}`,
                        )
                      }
                      type="button"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Selected PDF
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {/* Day rows */}
            <div className="divide-y divide-slate-100">
              {rows.map((row, rowIndex) => {
                const hasReturnNotes = Boolean(row.returnNotes?.length);
                const rowBg = hasReturnNotes
                  ? "bg-amber-50/60"
                  : rowIndex % 2 === 0
                    ? ""
                    : "bg-slate-50/40";
                const autoRep = repForArea(workspace.medicalRepOptions, row.area ?? "");
                const availableAreas = areasForRegion(
                  workspace.medicalRepOptions,
                  row.locationText ?? "",
                );

                return (
                  <div
                    className={`group transition-colors duration-100 hover:bg-orange-50/25 ${rowBg}`}
                    key={row.key}
                  >
                    {/* 5-column row — all cells h-8 and items-center */}
                    <div className={`${ROW_GRID} min-w-0 items-center px-4 py-2`}>
                      {/* Date */}
                      <div className="flex h-8 min-w-0 flex-col justify-center border-l-2 border-orange-400/60 pl-2">
                        <span className="text-[11px] font-black uppercase leading-none tracking-[0.08em] text-orange-500">
                          {formatDayName(row.activityDate)}
                        </span>
                        <span className="mt-0.5 text-xs font-bold leading-none text-slate-700">
                          {formatDate(row.activityDate)}
                        </span>
                      </div>

                      {/* Type */}
                      <select
                        className={csel}
                        disabled={!canEdit}
                        onChange={(e) => updateRow(row.key, "activityType", e.target.value)}
                        value={row.activityType}
                      >
                        {employeePlanActivityTypes.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>

                      {/* Region */}
                      <select
                        className={csel}
                        disabled={!canEdit}
                        onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                        value={row.locationText ?? ""}
                      >
                        <option value="">Select region</option>
                        {row.locationText &&
                        !regions.some(
                          (r) => r.toLowerCase() === (row.locationText ?? "").toLowerCase(),
                        ) ? (
                          <option value={row.locationText}>{row.locationText}</option>
                        ) : null}
                        {regions.map((region) => (
                          <option key={region} value={region}>
                            {region}
                          </option>
                        ))}
                      </select>

                      {/* Area — cascades from region */}
                      <select
                        className={csel}
                        disabled={!canEdit || !row.locationText}
                        onChange={(e) => updateRow(row.key, "area", e.target.value)}
                        value={row.area ?? ""}
                      >
                        <option value="">
                          {row.locationText ? "Select area" : "Choose region first"}
                        </option>
                        {row.area &&
                        !availableAreas.some(
                          (a) => a.toLowerCase() === (row.area ?? "").toLowerCase(),
                        ) ? (
                          <option value={row.area}>{row.area}</option>
                        ) : null}
                        {availableAreas.map((area) => (
                          <option key={area} value={area}>
                            {area}
                          </option>
                        ))}
                      </select>

                      {/* Medical Rep — DV selector or auto-derived display */}
                      {row.activityType === "Double Visit" ? (
                        <select
                          className={csel}
                          disabled={!canEdit || workspace.medicalRepOptions.length === 0}
                          onChange={(e) => setRowRep(row.key, e.target.value)}
                          value={row.doubleVisitMedicalRepHrId ?? ""}
                        >
                          <option value="">Select Medical Rep</option>
                          {row.doubleVisitMedicalRepHrId &&
                          !workspace.medicalRepOptions.some(
                            (r) => r.hrId === row.doubleVisitMedicalRepHrId,
                          ) ? (
                            <option value={row.doubleVisitMedicalRepHrId}>
                              {row.doubleVisitMedicalRepName || row.doubleVisitMedicalRepHrId}
                            </option>
                          ) : null}
                          {workspace.medicalRepOptions.map((rep) => (
                            <option key={rep.hrId} value={rep.hrId}>
                              {rep.fullName}
                              {rep.areaName ? ` – ${rep.areaName}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : autoRep ? (
                        <div className="flex h-8 min-w-0 items-center rounded border border-violet-200 bg-violet-50/60 px-2">
                          <span className="truncate text-sm font-semibold text-violet-700">
                            {autoRep.fullName}
                          </span>
                        </div>
                      ) : (
                        <div className="flex h-8 min-w-0 items-center rounded border border-slate-200 bg-slate-50 px-2">
                          <span className="text-xs text-slate-400">
                            {row.area ? "No rep for this area" : "Select area first"}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Notes — full width, orange tinted */}
                    <div className="border-t border-orange-100 bg-orange-50/40 px-4 py-2">
                      <input
                        className={cinNotes}
                        disabled={!canEdit}
                        onChange={(e) => updateRow(row.key, "notes", e.target.value)}
                        placeholder="Notes for this day..."
                        value={row.notes ?? ""}
                      />
                      {hasReturnNotes ? (
                        <div className="mt-2 space-y-1 rounded border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                          {row.returnNotes?.map((note) => (
                            <p key={note.id}>
                              {note.actorRole ?? "Reviewer"}: {note.note}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer actions */}
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4">
              <Button
                disabled={isPending || !canEdit}
                onClick={() => runAction(() => submitPlan(false))}
                variant="secondary"
              >
                Save draft
              </Button>
              <Button
                disabled={isPending || submitBlocked}
                onClick={() => runAction(() => submitPlan(true))}
              >
                <Send className="mr-2 h-4 w-4" />
                Submit
              </Button>
            </div>
          </section>

          {/* Sidebar */}
          <aside className="space-y-4">
            <QueueCard onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
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
    </>
  );
}

const TIMELINE_STEPS: Array<{ icon: typeof FileText; label: string }> = [
  { icon: FileText, label: "Draft" },
  { icon: Send, label: "Submitted" },
  { icon: CheckCircle2, label: "Manager" },
  { icon: ShieldCheck, label: "Final" },
  { icon: BadgeCheck, label: "HR Ack" },
];

function timelineReachedIndex(status: EmployeePlanStatus): number {
  switch (status) {
    case "submitted":
      return 1;
    case "manager_approved":
      return 2;
    case "ceo_approved":
    case "final_approved":
      return 3;
    case "hr_acknowledged":
      return 4;
    default:
      // draft, *_returned, *_rejected, cancelled
      return 0;
  }
}

function WorkflowTimeline({ status }: { status: EmployeePlanStatus }) {
  const reached = timelineReachedIndex(status);
  const alt = status.includes("rejected")
    ? { cls: "border-red-200 bg-red-50 text-red-700", icon: XCircle, text: statusLabels[status] }
    : status.includes("returned")
      ? { cls: "border-amber-200 bg-amber-50 text-amber-700", icon: RotateCcw, text: `${statusLabels[status]} — needs edits` }
      : status === "cancelled"
        ? { cls: "border-slate-200 bg-slate-50 text-slate-600", icon: X, text: "Cancelled" }
        : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-1 overflow-x-auto">
        {TIMELINE_STEPS.map((step, index) => {
          const done = index <= reached && !alt;
          const current = index === reached && !alt;
          const Icon = step.icon;
          const tone = current
            ? "border-orange-300 bg-orange-50 text-orange-700"
            : done
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-white text-slate-400";
          return (
            <div className="flex shrink-0 items-center" key={step.label}>
              <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${tone}`}>
                <Icon className="h-3.5 w-3.5" />
                <span className="text-[11px] font-black">{step.label}</span>
              </div>
              {index < TIMELINE_STEPS.length - 1 ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
              ) : null}
            </div>
          );
        })}
      </div>
      {alt ? (
        <div className={`mt-2 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold ${alt.cls}`}>
          <alt.icon className="h-3.5 w-3.5" />
          {alt.text}
        </div>
      ) : null}
    </div>
  );
}

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</span>
      <span className="ml-1.5 text-xs font-black text-slate-700">{value}</span>
    </div>
  );
}

function MobileDayCard({
  medicalRepOptions,
  onOpen,
  row,
}: {
  medicalRepOptions: MedicalRepOption[];
  onOpen: () => void;
  row: DraftItem;
}) {
  const isDoubleVisit = row.activityType === "Double Visit";
  const autoRep = repForArea(medicalRepOptions, row.area ?? "");
  const repName = isDoubleVisit ? row.doubleVisitMedicalRepName : autoRep?.fullName ?? "";
  const needsRep = isDoubleVisit && !row.doubleVisitMedicalRepHrId;
  const hasReturnNotes = Boolean(row.returnNotes?.length);

  return (
    <button
      className={`block w-full rounded-xl border bg-white p-3 text-left shadow-sm transition-colors active:bg-slate-50 ${
        hasReturnNotes ? "border-amber-300" : "border-slate-200"
      }`}
      onClick={onOpen}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-12 flex-col items-center justify-center rounded-lg border border-orange-200 bg-orange-50">
            <span className="text-[10px] font-black uppercase leading-none text-orange-500">
              {formatDayName(row.activityDate)}
            </span>
            <span className="mt-0.5 text-xs font-black leading-none text-slate-800">
              {formatDate(row.activityDate).split(" ")[0]}
            </span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-slate-900">{row.activityType}</p>
            <p className="truncate text-xs font-semibold text-slate-500">
              {[row.locationText, row.area].filter(Boolean).join(" · ") || "No region set"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {hasReturnNotes ? (
            <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
              Feedback
            </span>
          ) : null}
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
        </div>
      </div>

      {isDoubleVisit || repName || row.notes ? (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {isDoubleVisit ? (
            needsRep ? (
              <p className="flex items-center gap-1 text-xs font-bold text-amber-700">
                <TriangleAlert className="h-3.5 w-3.5" />
                Double Visit — select a Medical Rep
              </p>
            ) : (
              <p className="text-xs font-semibold text-violet-700">Double Visit · {repName}</p>
            )
          ) : repName ? (
            <p className="text-xs font-semibold text-violet-700">Rep · {repName}</p>
          ) : null}
          {row.notes ? (
            <p className="truncate text-xs text-slate-500">{row.notes}</p>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function RowEditSheet({
  canEdit,
  medicalRepOptions,
  onClose,
  onDelete,
  onRep,
  onUpdate,
  regions,
  row,
}: {
  canEdit: boolean;
  medicalRepOptions: MedicalRepOption[];
  onClose: () => void;
  onDelete: () => void;
  onRep: (hrId: string) => void;
  onUpdate: (field: keyof EmployeePlanItemInput, value: string) => void;
  regions: string[];
  row: DraftItem;
}) {
  const isDoubleVisit = row.activityType === "Double Visit";
  const availableAreas = areasForRegion(medicalRepOptions, row.locationText ?? "");

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        aria-label="Close editor"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white shadow-2xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.08em] text-orange-500">
              {formatDayName(row.activityDate)}
            </p>
            <p className="text-sm font-black text-slate-900">Edit · {formatDate(row.activityDate)}</p>
          </div>
          <button
            aria-label="Close"
            className="rounded-full p-1.5 text-slate-400 active:bg-slate-100"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <Field label="Activity Type">
            <select
              className={mobileField}
              disabled={!canEdit}
              onChange={(e) => onUpdate("activityType", e.target.value)}
              value={row.activityType}
            >
              {employeePlanActivityTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Region">
            <select
              className={mobileField}
              disabled={!canEdit}
              onChange={(e) => onUpdate("locationText", e.target.value)}
              value={row.locationText ?? ""}
            >
              <option value="">Select region</option>
              {row.locationText &&
              !regions.some((r) => r.toLowerCase() === (row.locationText ?? "").toLowerCase()) ? (
                <option value={row.locationText}>{row.locationText}</option>
              ) : null}
              {regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Area">
            <select
              className={mobileField}
              disabled={!canEdit || !row.locationText}
              onChange={(e) => onUpdate("area", e.target.value)}
              value={row.area ?? ""}
            >
              <option value="">{row.locationText ? "Select area" : "Choose region first"}</option>
              {row.area &&
              !availableAreas.some((a) => a.toLowerCase() === (row.area ?? "").toLowerCase()) ? (
                <option value={row.area}>{row.area}</option>
              ) : null}
              {availableAreas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </Field>

          {isDoubleVisit ? (
            <Field label="Medical Rep (same line)">
              {medicalRepOptions.length === 0 ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
                  No same-line Medical Rep is available. Please contact your manager or change the
                  activity type.
                </p>
              ) : (
                <select
                  className={mobileField}
                  disabled={!canEdit}
                  onChange={(e) => onRep(e.target.value)}
                  value={row.doubleVisitMedicalRepHrId ?? ""}
                >
                  <option value="">Select Medical Rep</option>
                  {row.doubleVisitMedicalRepHrId &&
                  !medicalRepOptions.some((r) => r.hrId === row.doubleVisitMedicalRepHrId) ? (
                    <option value={row.doubleVisitMedicalRepHrId}>
                      {row.doubleVisitMedicalRepName || row.doubleVisitMedicalRepHrId}
                    </option>
                  ) : null}
                  {medicalRepOptions.map((rep) => (
                    <option key={rep.hrId} value={rep.hrId}>
                      {rep.fullName}
                      {rep.areaName ? ` – ${rep.areaName}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}

          <Field label="Remarks">
            <textarea
              className="min-h-20 w-full rounded-lg border border-orange-200 bg-orange-50/50 p-2.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-60"
              disabled={!canEdit}
              onChange={(e) => onUpdate("notes", e.target.value)}
              placeholder="Notes for this day..."
              value={row.notes ?? ""}
            />
          </Field>

          {row.returnNotes?.length ? (
            <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] font-black uppercase tracking-[0.08em] text-amber-700">
                Reviewer feedback
              </p>
              {row.returnNotes.map((note) => (
                <p className="text-xs font-semibold text-amber-900" key={note.id}>
                  {note.actorRole ?? "Reviewer"}: {note.note}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2 pt-1">
            {canEdit ? (
              <Button
                className="flex-1"
                onClick={onDelete}
                variant="destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete day
              </Button>
            ) : null}
            <Button className="flex-1" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function ContextTile({
  accent,
  label,
  sub,
  value,
}: {
  accent: "orange" | "slate";
  label: string;
  sub: string;
  value: string;
}) {
  const accentCls =
    accent === "orange"
      ? "border-l-orange-500 bg-orange-50/40"
      : "border-l-slate-400 bg-slate-50/40";
  return (
    <div className={`rounded border border-slate-200 border-l-4 bg-white p-4 ${accentCls}`}>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-2 text-base font-black text-slate-900">{value}</p>
      {sub ? <p className="mt-0.5 text-sm text-slate-600">{sub}</p> : null}
    </div>
  );
}

function Kpi({
  label,
  tone = "slate",
  value,
}: {
  label: string;
  tone?: "amber" | "red" | "sky" | "slate";
  value: number;
}) {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    slate: "border-slate-200 bg-white text-slate-900",
  }[tone];
  return (
    <div className={`rounded border p-3 ${toneClass}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">{label}</p>
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
    <div className="overflow-hidden rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-900 px-4 py-3">
        <h3 className="font-black text-white">{title}</h3>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.length === 0 ? (
          <p className="text-sm font-semibold text-slate-500">No plans yet.</p>
        ) : null}
        {plans.map((p) => (
          <div className="rounded border border-slate-200 p-3 hover:bg-slate-50" key={p.id}>
            <button className="w-full text-left" onClick={() => onOpen(p)} type="button">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-slate-900">
                  {p.planKind} {p.periodKey}
                </p>
                <span
                  className={`rounded-full border px-2 py-1 text-[11px] font-black ${statusTone(p.status)}`}
                >
                  {statusLabels[p.status]}
                </span>
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-500">Revision {p.revision}</p>
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
  type: "ceo" | "hr" | "manager";
}) {
  if (plans.length === 0) return null;
  return (
    <div className="overflow-hidden rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-900 px-4 py-3">
        <h3 className="font-black text-white">{title}</h3>
      </div>
      <div className="space-y-3 p-3">
        {plans.map((p) => (
          <div className="rounded border border-slate-200 p-3" key={p.id}>
            <p className="font-black text-slate-900">{p.employeeName}</p>
            <p className="text-xs font-semibold text-slate-500">
              {p.planKind} {p.periodKey} — {statusLabels[p.status]}
            </p>
            <textarea
              className="mt-3 min-h-20 w-full rounded border border-slate-200 p-2 text-sm"
              onChange={(e) => onComment(e.target.value)}
              placeholder={type === "hr" ? "Acknowledgement note" : "Comment for reject/return"}
              value={comment}
            />
            {type !== "hr" ? (
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-2">
                {p.items.map((item) => (
                  <label className="block" key={item.id}>
                    <span className="block text-xs font-black text-slate-600">
                      {formatDate(item.activityDate)} — {item.activityTitle}
                    </span>
                    <input
                      className={cin}
                      onChange={(e) => onReturnNote?.(p.id, item.id, e.target.value)}
                      placeholder="Optional row return note"
                      value={returnNotes?.[p.id]?.[item.id] ?? ""}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {type !== "hr" && comment.trim().length === 0 ? (
              <p className="mt-2 text-xs font-semibold text-amber-700">
                A comment is required to return or reject a plan.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {type === "manager" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(p.id, "manager_approve")}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "manager_return")}
                    variant="secondary"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Return
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "manager_reject")}
                    variant="destructive"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    Reject
                  </Button>
                </>
              ) : null}
              {type === "ceo" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(p.id, "ceo_approve")}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "ceo_return")}
                    variant="secondary"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Return
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "ceo_reject")}
                    variant="destructive"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    Reject
                  </Button>
                </>
              ) : null}
              {type === "hr" ? (
                <Button
                  disabled={isPending}
                  onClick={() => onDecision(p.id, "hr_acknowledge")}
                  variant="secondary"
                >
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
