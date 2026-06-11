"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";

// Client-only flag without setState-in-effect: false on the server/during
// hydration, true on the client. Used to gate document.body portals.
const emptySubscribe = () => () => {};
import {
  BadgeCheck,
  CalendarDays,
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

// Premium field controls (square corners, slate-300 border, orange focus ring) -
// matched to the Report It module's design language.
const cin = "h-8 w-full border border-slate-300 bg-white px-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";
const tableSelectClass = "h-10 w-full min-w-0 cursor-pointer border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors duration-150 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";
const tableInputClass = "h-10 w-full min-w-0 border border-orange-200 bg-orange-50/50 px-3 text-sm font-semibold text-slate-800 placeholder:text-orange-400 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors duration-150 focus:border-orange-500 focus:bg-orange-50 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-60";
// Taller field controls for the touch-friendly mobile bottom-sheet editor.
const mobileField = "h-11 w-full border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string) {
  const result: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function isDefaultWorkingDay(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day >= 0 && day <= 4;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDayNumber(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatMonthYear(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDayName(value: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function createDraftRow(activityDate: string, index: number, keySeed = "row"): DraftItem {
  return {
    activityDate,
    activityTitle: "",
    activityType: "Office",
    area: "",
    attendees: "",
    doubleVisitMedicalRepHrId: "",
    doubleVisitMedicalRepName: "",
    endTime: "",
    key: `${keySeed}-${activityDate}-${index}`,
    locationText: "",
    notes: "",
    objective: "",
    sortOrder: index,
    startTime: "",
  };
}

function sortDraftRows(rows: DraftItem[]) {
  return [...rows]
    .sort((left, right) => left.activityDate.localeCompare(right.activityDate))
    .map((row, index) => ({ ...row, sortOrder: index }));
}

function defaultRows(kind: EmployeePlanKind, anchorDate: string): DraftItem[] {
  const period = buildEmployeePlanPeriod(kind, anchorDate);
  const days = dateRange(period.periodStartDate, period.periodEndDate);
  const selectedDays = kind === "monthly" ? days.filter(isDefaultWorkingDay) : days;
  return selectedDays.map((date, index) => createDraftRow(date, index));
}

function rowPayload(rows: DraftItem[]): EmployeePlanItemInput[] {
  return sortDraftRows(rows).map((row, index) => ({
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
  basePath,
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

  // The fixed mobile bars and sheet are portalled to document.body so they escape
  // the employee-portal page-transition wrapper's CSS transform (which would
  // otherwise re-anchor position:fixed to that scrolling container).
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // The global portal bottom nav (≈56px + safe area) only exists on the employee
  // portal surface, not the admin review page. Offset the action bar accordingly.
  const onAdminSurface = basePath === "/admin/weekly-plans";
  const calendarHref = onAdminSurface ? "/hr-calendar" : "/employee-portals/calendar";
  const actionBarBottom = onAdminSurface
    ? "env(safe-area-inset-bottom)"
    : "calc(56px + env(safe-area-inset-bottom))";

  const period = useMemo(
    () => buildEmployeePlanPeriod(activeKind, anchorDate),
    [activeKind, anchorDate],
  );
  const periodDays = useMemo(
    () => dateRange(period.periodStartDate, period.periodEndDate),
    [period.periodEndDate, period.periodStartDate],
  );
  const selectedDateSet = useMemo(
    () => new Set(rows.map((row) => row.activityDate)),
    [rows],
  );
  const workingDayCount = useMemo(
    () => periodDays.filter(isDefaultWorkingDay).length,
    [periodDays],
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
  const noPlanRows = rows.length === 0;
  const submitBlocked = !canEdit || doubleVisitMissingRep || noPlanRows;

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
    setRows((current) => sortDraftRows(current.filter((row) => row.key !== key)));
    setSheetKey(null);
  }

  function addRow() {
    setRows((current) => {
      const used = new Set(current.map((row) => row.activityDate));
      const nextDate =
        periodDays.find((date) => !used.has(date)) ??
        addDays(current[current.length - 1]?.activityDate ?? period.periodEndDate, 1);
      return sortDraftRows([...current, createDraftRow(nextDate, current.length, `row-add-${Date.now()}`)]);
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
    <div className="border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
      Planning database migration is not applied yet.
    </div>
  ) : null;

  const messageBanner = message ? (
    <div className="border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">
      {message}
    </div>
  ) : null;

  return (
    <>
      {/* ===================== MOBILE (< md) ===================== */}
      <div className="space-y-4 pb-28 md:hidden">
        {schemaBanner}

        {/* Compact header */}
        <div className="border border-slate-200 bg-white p-4 shadow-sm">
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

          <div className="mt-3 flex flex-col gap-2">
            <input
              className="h-11 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800"
              onChange={(event) => onAnchorChange(event.target.value)}
              type="date"
              value={anchorDate}
            />
            <div className="grid grid-cols-2 gap-2">
              <Link
                aria-label="Open calendar"
                className="inline-flex h-11 items-center justify-center gap-1.5 border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 active:bg-orange-100"
                href={calendarHref}
              >
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
              <button
                className="inline-flex h-11 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 active:bg-slate-50"
                onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
                type="button"
              >
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>
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
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{doubleVisitWarning}</span>
          </div>
        ) : null}

        {noPlanRows ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Add at least one planning day before saving or submitting.</span>
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
              className="flex w-full items-center justify-center gap-1.5 border border-dashed border-orange-300 bg-orange-50/40 py-3 text-sm font-bold text-orange-600 active:bg-orange-50"
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
          {ownPlans.length > 0 ? (
            <QueueCard onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
          ) : null}
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
      {mounted && workspace.canSubmitPlans
        ? createPortal(
            <div
              className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
              style={{ bottom: actionBarBottom }}
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
            </div>,
            document.body,
          )
        : null}

      {/* Mobile bottom-sheet row editor */}
      {mounted && sheetRow
        ? createPortal(
            <RowEditSheet
              canEdit={canEdit}
              medicalRepOptions={workspace.medicalRepOptions}
              onClose={() => setSheetKey(null)}
              onDelete={() => deleteRow(sheetRow.key)}
              onRep={(hrId) => setRowRep(sheetRow.key, hrId)}
              onUpdate={(field, value) => updateRow(sheetRow.key, field, value)}
              regions={regions}
              row={sheetRow}
            />,
            document.body,
          )
        : null}

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
        <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_18px_44px_rgba(15,23,42,0.07)]">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-500">My Plan</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">
                {activeKind === "weekly" ? "Weekly plan table" : "Monthly plan table"}
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                {formatDate(period.periodStartDate)} to {formatDate(period.periodEndDate)} - {period.periodKey}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-orange-700">
                {rows.length} selected day{rows.length === 1 ? "" : "s"}
              </span>
              {activeKind === "monthly" ? (
                <span className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600">
                  {workingDayCount} working days default
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="inline-flex w-full border border-slate-200 bg-slate-50 p-1 sm:w-auto">
              {(["weekly", "monthly"] as const).map((kind) => (
                <button
                  className={`min-h-10 flex-1 px-4 text-sm font-black transition-colors duration-150 sm:flex-none ${
                    activeKind === kind
                      ? "bg-slate-950 text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)]"
                      : "text-slate-700 hover:bg-white"
                  }`}
                  key={kind}
                  onClick={() => onKindChange(kind)}
                  type="button"
                >
                  {kind === "weekly" ? "Weekly Plan" : "Monthly Plan"}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor="plan-anchor-date">
                Anchor date
              </label>
              <input
                className="h-10 border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                id="plan-anchor-date"
                onChange={(event) => onAnchorChange(event.target.value)}
                type="date"
                value={anchorDate}
              />
              <span className="border border-slate-200 bg-white px-3 py-2 text-sm font-black text-slate-700">
                {period.periodKey}
              </span>
              <Link
                aria-label="Open calendar"
                className="inline-flex h-10 items-center gap-1.5 border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100"
                href={calendarHref}
              >
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
            </div>
          </div>
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}

        {doubleVisitWarning ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{doubleVisitWarning}</span>
          </div>
        ) : null}

        {noPlanRows ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Add at least one planning day before saving or submitting.</span>
          </div>
        ) : null}

        {/* Full-width plan table */}
        <div className="min-w-0 space-y-5">
          <section className="min-w-0 overflow-hidden border border-slate-200 bg-white shadow-[0_24px_58px_rgba(15,23,42,0.08)]">
            <div className="bg-slate-950 px-4 py-4 text-white sm:px-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-400">Planning table</p>
                  <h3 className="mt-1 text-lg font-black">
                    {activeKind === "weekly" ? "Weekly activities" : "Monthly activities"}
                  </h3>
                  <p className="mt-1 text-sm font-semibold text-slate-300">
                    Build each day with activity, geography, medical rep context, and notes.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-9 items-center gap-1.5 border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
                    type="button"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export XLSX
                  </button>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => window.location.assign("/api/weekly-plans/export?format=pdf")}
                    type="button"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export PDF
                  </button>
                  {plan ? (
                    <>
                      <button
                        className="inline-flex h-9 items-center gap-1.5 border border-orange-400/45 bg-orange-500/15 px-3 text-xs font-black text-orange-100 transition hover:border-orange-300"
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
                        className="inline-flex h-9 items-center gap-1.5 border border-orange-400/45 bg-orange-500/15 px-3 text-xs font-black text-orange-100 transition hover:border-orange-300"
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
            </div>

            <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canEdit || selectedDateSet.size >= periodDays.length}
                  onClick={addRow}
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add day
                </button>
                <button
                  className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canEdit}
                  onClick={() => resetRows(activeKind, anchorDate)}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset working days
                </button>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                <span className="border border-slate-200 bg-white px-2.5 py-1.5">Rows: {rows.length}</span>
                <span className="border border-slate-200 bg-white px-2.5 py-1.5">Period days: {periodDays.length}</span>
              </div>
            </div>

            <div className="overflow-x-auto bg-white">
              <table className="w-full min-w-[1280px] border-collapse">
                <thead className="bg-slate-50">
                  <tr className="border-b border-slate-200 text-left text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                    <th className="w-[190px] px-4 py-3">Date</th>
                    <th className="w-[180px] px-3 py-3">Activity</th>
                    <th className="w-[210px] px-3 py-3">Region</th>
                    <th className="w-[210px] px-3 py-3">Area</th>
                    <th className="w-[250px] px-3 py-3">Medical Rep</th>
                    <th className="px-3 py-3">Notes</th>
                    <th className="w-[84px] px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row, rowIndex) => {
                    const hasReturnNotes = Boolean(row.returnNotes?.length);
                    const autoRep = repForArea(workspace.medicalRepOptions, row.area ?? "");
                    const availableAreas = areasForRegion(workspace.medicalRepOptions, row.locationText ?? "");
                    const rowTone = hasReturnNotes
                      ? "bg-amber-50/70"
                      : rowIndex % 2 === 0
                        ? "bg-white"
                        : "bg-slate-50/45";

                    return (
                      <Fragment key={row.key}>
                        <tr className={`align-middle transition-colors hover:bg-orange-50/35 ${rowTone}`}>
                          <td className="px-4 py-3">
                            <time
                              className="flex items-center gap-3"
                              dateTime={row.activityDate}
                              title={row.activityDate}
                            >
                              <span className="flex h-16 w-20 shrink-0 flex-col items-center justify-center border border-orange-200 bg-gradient-to-b from-orange-50 to-white shadow-[0_6px_18px_rgba(249,115,22,0.08)]">
                                <span className="text-[10px] font-black uppercase tracking-wide text-orange-500">
                                  {formatDayName(row.activityDate)}
                                </span>
                                <span className="mt-0.5 text-xl font-black leading-none text-slate-950">
                                  {formatDayNumber(row.activityDate)}
                                </span>
                                <span className="mt-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
                                  {formatMonthYear(row.activityDate)}
                                </span>
                              </span>
                              <div className="min-w-0">
                                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">
                                  Plan day
                                </p>
                                <p className="mt-1 text-sm font-black text-slate-900">Day {rowIndex + 1}</p>
                              </div>
                            </time>
                          </td>
                          <td className="px-3 py-3">
                            <select
                              className={tableSelectClass}
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
                          </td>
                          <td className="px-3 py-3">
                            <select
                              className={tableSelectClass}
                              disabled={!canEdit}
                              onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                              value={row.locationText ?? ""}
                            >
                              <option value="">Select region</option>
                              {row.locationText &&
                              !regions.some((region) => region.toLowerCase() === (row.locationText ?? "").toLowerCase()) ? (
                                <option value={row.locationText}>{row.locationText}</option>
                              ) : null}
                              {regions.map((region) => (
                                <option key={region} value={region}>
                                  {region}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <select
                              className={tableSelectClass}
                              disabled={!canEdit || !row.locationText}
                              onChange={(e) => updateRow(row.key, "area", e.target.value)}
                              value={row.area ?? ""}
                            >
                              <option value="">{row.locationText ? "Select area" : "Choose region first"}</option>
                              {row.area &&
                              !availableAreas.some((area) => area.toLowerCase() === (row.area ?? "").toLowerCase()) ? (
                                <option value={row.area}>{row.area}</option>
                              ) : null}
                              {availableAreas.map((area) => (
                                <option key={area} value={area}>
                                  {area}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            {row.activityType === "Double Visit" ? (
                              <select
                                className={tableSelectClass}
                                disabled={!canEdit || workspace.medicalRepOptions.length === 0}
                                onChange={(e) => setRowRep(row.key, e.target.value)}
                                value={row.doubleVisitMedicalRepHrId ?? ""}
                              >
                                <option value="">Select Medical Rep</option>
                                {row.doubleVisitMedicalRepHrId &&
                                !workspace.medicalRepOptions.some((rep) => rep.hrId === row.doubleVisitMedicalRepHrId) ? (
                                  <option value={row.doubleVisitMedicalRepHrId}>
                                    {row.doubleVisitMedicalRepName || row.doubleVisitMedicalRepHrId}
                                  </option>
                                ) : null}
                                {workspace.medicalRepOptions.map((rep) => (
                                  <option key={rep.hrId} value={rep.hrId}>
                                    {rep.fullName}
                                    {rep.areaName ? ` - ${rep.areaName}` : ""}
                                  </option>
                                ))}
                              </select>
                            ) : autoRep ? (
                              <div className="flex h-10 min-w-0 items-center border border-violet-200 bg-violet-50/70 px-3">
                                <span className="truncate text-sm font-black text-violet-700">{autoRep.fullName}</span>
                              </div>
                            ) : (
                              <div className="flex h-10 min-w-0 items-center border border-slate-200 bg-white px-3">
                                <span className="text-xs font-semibold text-slate-400">
                                  {row.area ? "No rep for this area" : "Select area first"}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <input
                              className={tableInputClass}
                              disabled={!canEdit}
                              onChange={(e) => updateRow(row.key, "notes", e.target.value)}
                              placeholder="Notes for this day..."
                              value={row.notes ?? ""}
                            />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              aria-label={`Remove ${formatDate(row.activityDate)}`}
                              className="inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={!canEdit || rows.length <= 1}
                              onClick={() => deleteRow(row.key)}
                              type="button"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                        {hasReturnNotes ? (
                          <tr className="bg-amber-50/80">
                            <td className="px-4 py-2" colSpan={7}>
                              <div className="space-y-1 border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                                {row.returnNotes?.map((note) => (
                                  <p key={note.id}>
                                    {note.actorRole ?? "Reviewer"}: {note.note}
                                  </p>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer actions */}
            <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                <span className={`border px-2.5 py-1.5 ${statusTone(plan?.status ?? "draft")}`}>
                  {statusLabels[plan?.status ?? "draft"]}
                </span>
                <span className="border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                  {workspace.canSubmitPlans ? "Creator access" : "Review access only"}
                </span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  disabled={isPending || !canEdit || noPlanRows}
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
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            {ownPlans.length > 0 ? (
              <QueueCard onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
            ) : null}
            {managerQueue.length > 0 ? (
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
            ) : null}
            {ceoQueue.length > 0 ? (
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
            ) : null}
            {hrQueue.length > 0 ? (
              <ReviewCard
                comment={comment}
                isPending={isPending}
                onComment={setComment}
                onDecision={(planId) => runAction(() => acknowledge(planId))}
                plans={hrQueue}
                title="HR Acknowledgement"
                type="hr"
              />
            ) : null}
          </div>
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
    <div className="border border-slate-200 bg-white p-3 shadow-sm">
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
        <div className={`mt-2 flex items-center gap-1.5 border px-2.5 py-1.5 text-xs font-bold ${alt.cls}`}>
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
      className={`block w-full border bg-white p-3 text-left shadow-sm transition-colors active:bg-slate-50 ${
        hasReturnNotes ? "border-amber-300" : "border-slate-200"
      }`}
      onClick={onOpen}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-12 flex-col items-center justify-center border border-orange-200 bg-orange-50">
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
        className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto border-t border-slate-200 bg-white shadow-2xl"
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
                <p className="border border-amber-200 bg-amber-50 p-2.5 text-xs font-semibold text-amber-800">
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
              className="min-h-20 w-full border border-orange-200 bg-orange-50/50 p-2.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-60"
              disabled={!canEdit}
              onChange={(e) => onUpdate("notes", e.target.value)}
              placeholder="Notes for this day..."
              value={row.notes ?? ""}
            />
          </Field>

          {row.returnNotes?.length ? (
            <div className="space-y-1 border border-amber-200 bg-amber-50 p-3">
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
    <div className={`border border-slate-200 border-l-4 bg-white p-4 ${accentCls}`}>
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
    <div className={`border p-3 ${toneClass}`}>
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
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 bg-slate-900 px-4 py-3">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.length === 0 ? (
          <p className="text-sm font-semibold text-slate-500">No plans yet.</p>
        ) : null}
        {plans.map((p) => (
          <div className="border border-slate-200 p-3 hover:bg-slate-50" key={p.id}>
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
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 bg-slate-900 px-4 py-3">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
      </div>
      <div className="space-y-3 p-3">
        {plans.map((p) => (
          <div className="border border-slate-200 p-3" key={p.id}>
            <p className="font-black text-slate-900">{p.employeeName}</p>
            <p className="text-xs font-semibold text-slate-500">
              {p.planKind} {p.periodKey} — {statusLabels[p.status]}
            </p>
            <textarea
              className="mt-3 min-h-20 w-full border border-slate-200 p-2 text-sm"
              onChange={(e) => onComment(e.target.value)}
              placeholder={type === "hr" ? "Acknowledgement note" : "Comment for reject/return"}
              value={comment}
            />
            {type !== "hr" ? (
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto border border-slate-200 bg-slate-50 p-2">
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
