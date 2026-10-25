"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Inbox } from "lucide-react";

import { AdminInsightChip, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import type {
  ActionHubData,
  ActionHubItem,
  ActionHubModule,
  ContractRenewalDetail,
  ExcuseDetail,
  LeaveDetail,
  MarketingDetail,
  OutstationDetail,
  ResignationDetail,
} from "@/components/action-center/types";
import { ACTION_HUB_MODULE_LABELS, REJECTION_TEMPLATES } from "@/components/action-center/types";
import { WeeklyPlanCalendar } from "@/components/action-center/weekly-plan-calendar";
import { isEmployeeContext, type EmployeeContext } from "@/lib/action-center/employee-context";
import { OUTSTATION_CLAIM_CHANGED_CODE } from "@/lib/outstation/claim-revision";
import {
  buildMarketingDecisionConfirmPrompt,
  type MarketingConfirmDecision,
} from "@/lib/marketing-requests/decision-confirm-prompt";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { cn } from "@/lib/utils";
import {
  phxButtonApproveClassName,
  phxButtonApproveDenseClassName,
  phxButtonDangerClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";


// ── Snooze helpers (localStorage, no backend) ────────────────────────────────
const SNOOZE_KEY = "phoenix-action-snooze:v1";
// Every access is guarded: storage can throw (a private window, blocked site data), and a snooze that
// cannot be saved simply is not remembered (2026-10-26 cache audit, P3).
function getSnoozeMap(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch { return {}; }
}
function saveSnoozeMap(m: Record<string, number>) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(m)); }
  catch { /* not remembered */ }
}
function setSnoozeExpiry(id: string) {
  const m = getSnoozeMap();
  m[id] = Date.now() + 86_400_000;
  saveSnoozeMap(m);
}
function isSnoozed(id: string): boolean {
  return (getSnoozeMap()[id] ?? 0) > Date.now();
}
function purgeSnoozed() {
  const m = getSnoozeMap();
  const now = Date.now();
  saveSnoozeMap(Object.fromEntries(Object.entries(m).filter(([, v]) => v > now)));
}

/**
 * The version of an outstation claim this list was loaded with, or "" for any other item. It goes
 * back with Approve and Reject so a claim that moved after the list loaded (an extra ticket, a
 * journey stop) is refused instead of approved at figures nobody here saw.
 */
function outstationRevisionOf(item: ActionHubItem): string {
  return item.detail.module === "outstation" ? item.detail.revision : "";
}

type Props = {
  initialData: ActionHubData;
  initialModule?: ActionHubModule | null;
  initialId?: string | null;
  callerRole?: string | null;
  // When embedded inside the two-tab Actions workspace, the parent renders the
  // page hero, so the hub skips its own to avoid a duplicate title band.
  embedded?: boolean;
};

type ContextData = EmployeeContext;

const SLA_THRESHOLDS: Record<ActionHubModule, number> = {
  leave: 3,
  excuse: 2,
  outstation: 3,
  resignation: 5,
  marketing: 3,
  contract_renewal: 7,
  weekly_plan: 2,
};

const MODULE_COLORS: Record<ActionHubModule, string> = {
  leave: "bg-sky-50 text-sky-700 border-sky-200/80",
  resignation: "bg-rose-50 text-rose-700 border-rose-200/80",
  excuse: "bg-amber-50 text-amber-800 border-amber-200/80",
  outstation: "bg-violet-50 text-violet-700 border-violet-200/80",
  marketing: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
  contract_renewal: "bg-teal-50 text-teal-700 border-teal-200/80",
  weekly_plan: "bg-indigo-50 text-indigo-700 border-indigo-200/80",
};

const MODULE_DOTS: Record<ActionHubModule, string> = {
  leave: "bg-sky-500",
  resignation: "bg-rose-500",
  excuse: "bg-amber-500",
  outstation: "bg-violet-500",
  marketing: "bg-emerald-500",
  contract_renewal: "bg-teal-500",
  weekly_plan: "bg-indigo-500",
};

const URGENCY_COLORS: Record<string, string> = {
  high: "bg-rose-50 text-rose-700 border-rose-200/80",
  normal: "bg-amber-50 text-amber-800 border-amber-200/80",
  low: "bg-slate-50 text-slate-500 border-slate-200",
};

function daysSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function itemSlaAge(item: ActionHubItem) {
  return item.slaAgeDays ?? daysSince(item.submittedAt);
}

function itemIsOverdue(item: ActionHubItem) {
  return item.slaIsOverdue ?? itemSlaAge(item) >= SLA_THRESHOLDS[item.module];
}

function ModuleBadge({ module }: { module: ActionHubModule }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.08em] ${MODULE_COLORS[module]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${MODULE_DOTS[module]}`} />
      {ACTION_HUB_MODULE_LABELS[module]}
    </span>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  if (urgency === "normal") return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-phx-2xs font-bold ${URGENCY_COLORS[urgency]}`}>
      {urgency === "high" ? "Urgent" : "Low"}
    </span>
  );
}

function SlaBadge({ item }: { item: ActionHubItem }) {
  const age = itemSlaAge(item);
  if (age <= 0) return null;
  const overdue = itemIsOverdue(item);
  const threshold = SLA_THRESHOLDS[item.module];
  const daysLeft = threshold - age;
  if (overdue) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-phx-danger-line/80 bg-phx-danger-bg px-1.5 py-0.5 text-phx-2xs font-bold text-phx-danger">
        <span className="h-1 w-1 rounded-full bg-rose-500" />
        Overdue {age}d
      </span>
    );
  }
  if (daysLeft <= 1) {
    return (
      <span className="inline-flex items-center rounded-full border border-phx-warn-line/80 bg-phx-warn-bg px-1.5 py-0.5 text-phx-2xs font-bold text-phx-warn">
        {daysLeft === 0 ? "Due today" : "1d left"}
      </span>
    );
  }
  return null;
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800" dir="auto">{value}</dd>
    </div>
  );
}

function ApprovalTimeline({ steps }: { steps: LeaveDetail["approvalSteps"] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <p className="mb-3 text-phx-xs font-black uppercase tracking-wide text-slate-500">Approval history</p>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.stepKey} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${step.status === "approved" ? "bg-emerald-500" : step.status === "rejected" ? "bg-rose-500" : step.status === "pending" ? "bg-amber-400" : "bg-slate-300"}`} />
              <span className="text-xs font-bold text-slate-700">{step.genericStep.replace(/_/g, " ")}</span>
              {step.approverName && <span className="text-phx-xs text-slate-500">· {step.approverName}</span>}
              <span className={`ml-auto text-phx-xs font-black ${step.status === "approved" ? "text-emerald-700" : step.status === "rejected" ? "text-rose-700" : step.status === "pending" ? "text-amber-700" : "text-slate-500"}`}>
                {step.status === "approved" ? "✓ approved" : step.status === "rejected" ? "✗ rejected" : step.status}
              </span>
              {step.decidedAt && (
                <span className="text-phx-2xs text-slate-400">
                  {new Date(step.decidedAt).toLocaleDateString("en", { day: "2-digit", month: "short" })}
                </span>
              )}
            </div>
            {step.decisionComment && (
              <p className="mt-0.5 rounded bg-slate-50 px-2 py-1 text-phx-xs italic text-slate-600">
                &ldquo;{step.decisionComment}&rdquo;
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LeaveDetailView({ detail }: { detail: LeaveDetail }) {
  return (
    <div>
      <dl className="grid grid-cols-2 gap-4">
        <DetailRow label="Type" value={detail.vacationType} />
        <DetailRow label="Duration" value={`${Number(detail.durationDays.toFixed(2))} day${detail.durationDays === 1 ? "" : "s"}`} />
        <DetailRow label="Start date" value={detail.startDate} />
        <DetailRow label="End date" value={detail.endDate} />
        <DetailRow label="Payment" value={detail.paymentStatus} />
        <DetailRow label="Balance before" value={`${Number(detail.balanceBeforeDays.toFixed(2))} days`} />
        {detail.slaAgeDays > 0 && (
          <div className="col-span-2">
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-phx-2xs font-bold ${detail.slaAgeDays >= 3 ? "border-rose-300 bg-rose-100 text-rose-800" : "border-amber-300 bg-amber-100 text-amber-900"}`}>
              {detail.slaAgeDays} day{detail.slaAgeDays === 1 ? "" : "s"} since submission
            </span>
          </div>
        )}
      </dl>
      <ApprovalTimeline steps={detail.approvalSteps} />
    </div>
  );
}

function ResignationDetailView({ detail }: { detail: ResignationDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Effective date" value={detail.effectiveDate} />
      <DetailRow label="Submitted" value={detail.submittedDate} />
      <DetailRow label="Job title" value={detail.jobTitle} />
      <DetailRow label="Line" value={detail.lineName} />
      {detail.reason && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-slate-500">Reason</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.reason}</dd>
        </div>
      )}
      {detail.workflowNotes && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-slate-500">Notes</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.workflowNotes}</dd>
        </div>
      )}
      {detail.rejectedReason && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-rose-600">Rejected reason</dt>
          <dd className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{detail.rejectedReason}</dd>
        </div>
      )}
    </dl>
  );
}

function ExcuseDetailView({ detail }: { detail: ExcuseDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Type" value={detail.excuseType === "morning" ? "Morning excuse" : "Afternoon excuse"} />
      <DetailRow label="Date" value={detail.excuseDate} />
      <DetailRow label="Duration" value={`${detail.durationHours} hours`} />
      <DetailRow label="Department" value={detail.departmentName} />
      <DetailRow label="Line" value={detail.lineName} />
      <DetailRow label="Manager" value={detail.managerName} />
    </dl>
  );
}

function OutstationDetailView({ detail }: { detail: OutstationDetail }) {
  const recColor =
    detail.approvalRecommendation === "auto_approve"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : detail.approvalRecommendation === "hr_review"
        ? "border-rose-300 bg-rose-50 text-rose-800"
        : "border-amber-300 bg-amber-50 text-amber-900";

  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Expense type" value={detail.expenseType} />
      <DetailRow label="Destination" value={detail.toLabel} />
      <DetailRow label="Trip start" value={detail.tripStartDate} />
      <DetailRow label="Trip end" value={detail.tripEndDate} />
      <DetailRow label="Claimed amount" value={`${Number(detail.claimedTotalAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`} />
      <DetailRow label="Allowance" value={`${Number(detail.allowanceAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`} />
      <div className="col-span-2 flex items-center gap-2">
        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${recColor}`}>
          {detail.approvalRecommendation.replace(/_/g, " ")}
        </span>
        {detail.approvalReason && <span className="text-xs text-slate-500">{detail.approvalReason}</span>}
      </div>
      {detail.notes && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-slate-500">Notes</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.notes}</dd>
        </div>
      )}
    </dl>
  );
}

function MarketingDetailView({ detail }: { detail: MarketingDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Request code" value={detail.requestCode} />
      <DetailRow label="Customer" value={detail.customerName} />
      <DetailRow label="Type" value={detail.requestType} />
      <DetailRow label="Current step" value={detail.currentStepName} />
      {detail.estimatedCost !== null && (
        <DetailRow label="Est. cost" value={`${Number(detail.estimatedCost || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`} />
      )}
      <DetailRow label="Pay date" value={detail.payDate} />
    </dl>
  );
}

function ContractRenewalDetailView({ detail }: { detail: ContractRenewalDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Renewal date" value={detail.requestedRenewalDate} />
      <DetailRow label="Status" value={detail.currentStatus.replace(/_/g, " ")} />
      <DetailRow label="Job title" value={detail.jobTitle} />
      <DetailRow label="Line" value={detail.lineName} />
      <DetailRow label="Area" value={detail.areaName} />
      {detail.proposedStartDate && <DetailRow label="Proposed start" value={detail.proposedStartDate} />}
      {detail.proposedEndDate && <DetailRow label="Proposed end" value={detail.proposedEndDate} />}
      {detail.workflowNotes && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-slate-500">Notes</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.workflowNotes}</dd>
        </div>
      )}
      {detail.decisionReason && (
        <div className="col-span-2">
          <dt className="mb-1 text-phx-xs font-bold uppercase tracking-wide text-rose-600">Decision reason</dt>
          <dd className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{detail.decisionReason}</dd>
        </div>
      )}
    </dl>
  );
}

// The day-by-day plan grid (WeeklyPlanCalendar + PlanActivityCard + helpers) now lives in
// ./weekly-plan-calendar.tsx so the Approvals Hub plan pages render the identical calendar from
// one source. Imported above.

function EmployeeContextPanel({ data, loading }: { data: ContextData | null; loading: boolean }) {
  if (loading) return <p className="text-sm text-slate-400">Loading context…</p>;
  if (!data) return <p className="text-sm text-slate-400">Context unavailable.</p>;

  const priorLeaveDecisions = (data.recentLeave ?? []).map((r) => r.hrDecision ?? r.managerDecision);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2.5 text-phx-xs font-black uppercase tracking-wide text-slate-500">
          Attendance · last 30 days
        </p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Complete", value: data.attendance.completeDays, cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
            { label: "Late", value: data.attendance.lateDays, cls: "border-amber-200 bg-amber-50 text-amber-800" },
            { label: "Absent", value: data.attendance.absentDays, cls: "border-rose-200 bg-rose-50 text-rose-800" },
            { label: "Short days", value: data.attendance.shortDays, cls: "border-slate-200 bg-white text-slate-700" },
            { label: "Deductions", value: data.attendance.deductionDays, cls: "border-slate-200 bg-white text-slate-700" },
            { label: "Total tracked", value: data.attendance.totalRows, cls: "border-slate-200 bg-white text-slate-700" },
          ].map(({ label, value, cls }) => (
            <div key={label} className={`rounded-lg border p-2.5 text-center ${cls}`}>
              <p className="text-lg font-black">{value}</p>
              <p className="text-phx-2xs font-bold uppercase">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {(data.recentLeave?.length ?? 0) > 0 && (
        <div>
          <p className="mb-2 text-phx-xs font-black uppercase tracking-wide text-slate-500">
            Recent leave &nbsp;
            <span className="font-mono tracking-wider text-slate-400">
              {priorLeaveDecisions.map((d) => d === "approved" ? "✓" : d === "rejected" ? "✗" : "–").join(" ")}
            </span>
          </p>
          <div className="space-y-1">
            {data.recentLeave.map((r, i) => {
              const d = r.hrDecision ?? r.managerDecision;
              return (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
                  <span className={d === "approved" ? "font-bold text-emerald-600" : d === "rejected" ? "font-bold text-rose-600" : "text-slate-400"}>
                    {d === "approved" ? "✓" : d === "rejected" ? "✗" : "–"}
                  </span>
                  <span>{r.vacationType.replace(/_/g, " ")} · {r.startDate} – {r.endDate}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(data.recentExcuses?.length ?? 0) > 0 && (
        <div>
          <p className="mb-2 text-phx-xs font-black uppercase tracking-wide text-slate-500">Recent excuses</p>
          <div className="space-y-1">
            {data.recentExcuses.map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
                <span className={e.status === "approved" ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>
                  {e.status === "approved" ? "✓" : "✗"}
                </span>
                <span>{e.excuseType} · {e.excuseDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-black text-slate-900">Keyboard shortcuts</p>
          <button onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-700">×</button>
        </div>
        <table className="w-full">
          <tbody>
            {[
              ["j / ↓", "Next item"],
              ["k / ↑", "Previous item"],
              ["a", "Approve (excuse / outstation)"],
              ["r", "Focus comment textarea"],
              ["Esc", "Clear selection"],
              ["?", "Toggle this panel"],
            ].map(([key, desc]) => (
              <tr key={key} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-4">
                  <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs font-bold text-slate-700">{key}</kbd>
                </td>
                <td className="py-2 text-xs text-slate-600">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function resolveLeaveActions(detail: LeaveDetail): Array<{ key: string; label: string; variant: "approve" | "reject" | "neutral" }> {
  const av = detail.actionAvailability;
  const actions: Array<{ key: string; label: string; variant: "approve" | "reject" | "neutral" }> = [];
  if (av.approve) actions.push({ key: "approve", label: "Approve", variant: "approve" });
  // Two returns on every vacation approval (owner, 2026-10-08): one click, or one that carries a comment.
  if (av.return) actions.push({ key: "return_plain", label: "Return for Edit", variant: "neutral" });
  if (av.return) actions.push({ key: "return", label: "Return for Edit with Comment", variant: "neutral" });
  if (av.reject) actions.push({ key: "reject", label: "Reject", variant: "reject" });
  if (av.acknowledge) actions.push({ key: "acknowledge", label: "Acknowledge (HR)", variant: "neutral" });
  return actions;
}

function resolveResignationActions(status: string): Array<{ key: string; label: string; variant: "approve" | "reject" | "neutral" }> {
  if (status === "submitted") {
    return [
      { key: "mark_review", label: "Mark Under Review", variant: "neutral" },
      { key: "reject", label: "Reject", variant: "reject" },
    ];
  }
  if (status === "under_review") {
    return [
      { key: "approve", label: "Approve", variant: "approve" },
      { key: "reject", label: "Reject", variant: "reject" },
    ];
  }
  return [];
}

export function ActionCenterHub({ initialData, initialModule, initialId, callerRole, embedded }: Props) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contextCacheRef = useRef(new Map<string, ContextData | null>());

  const [activeModule, setActiveModule] = useState<ActionHubModule | "all">(initialModule ?? "all");
  const [activeFilter, setActiveFilter] = useState<"all" | "overdue" | "high">("all");
  const [viewAsItems, setViewAsItems] = useState<ActionHubItem[] | null>(null);
  const [viewAsOffset, setViewAsOffset] = useState(0);
  const [viewAsTotal, setViewAsTotal] = useState(0);
  const VIEW_AS_LIMIT = 50;

  const allItems = useMemo(() => viewAsItems ?? initialData.items, [initialData, viewAsItems]);
  const initialDeepLinkMissing = Boolean(
    initialId && !initialData.items.some((item) => item.id === initialId && (initialModule ? item.module === initialModule : true)),
  );

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (initialId) {
      const found = initialData.items.find((item) => item.id === initialId && (initialModule ? item.module === initialModule : true));
      return found ? found.id : null;
    }
    return initialData.items[0]?.id ?? null;
  });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A marketing decision clicked but not yet confirmed — nothing is sent while this is set. */
  const [marketingConfirm, setMarketingConfirm] = useState<MarketingConfirmDecision | null>(null);
  const [notice, setNotice] = useState<string | null>(
    initialDeepLinkMissing ? "The request from this notification was not found in your current Action Center queue." : null,
  );
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [detailTab, setDetailTab] = useState<"details" | "context">("details");
  const [contextData, setContextData] = useState<ContextData | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [snoozeVersion, setSnoozeVersion] = useState(0);
  const [viewAsHrId, setViewAsHrId] = useState<string | null>(null);
  const [viewAsLoading, setViewAsLoading] = useState(false);
  const [managers, setManagers] = useState<Array<{ hrId: string; name: string }> | null>(null);

  const canViewAs = callerRole === "Super Admin";

  const filteredByModule = useMemo(
    () => (activeModule === "all" ? allItems : allItems.filter((item) => item.module === activeModule)),
    [allItems, activeModule],
  );

  const filteredItems = useMemo(() => {
    // snoozeVersion is a counter incremented on every snooze action — forces re-compute
    void snoozeVersion;
    const base = filteredByModule.filter((i) => !isSnoozed(i.id));
    if (activeFilter === "overdue") return base.filter(itemIsOverdue);
    if (activeFilter === "high") return base.filter((i) => i.urgency === "high");
    return base;
  }, [filteredByModule, activeFilter, snoozeVersion]);

  const selected = useMemo(() => allItems.find((item) => item.id === selectedId) ?? null, [allItems, selectedId]);

  const moduleCounts = useMemo(() => {
    const counts: Partial<Record<ActionHubModule | "all", number>> = { all: allItems.length };
    for (const item of allItems) {
      counts[item.module] = (counts[item.module] ?? 0) + 1;
    }
    return counts;
  }, [allItems]);

  const stats = useMemo(() => {
    const overdue = filteredByModule.filter(itemIsOverdue).length;
    const total = filteredByModule.length;
    const avg = total > 0 ? filteredByModule.reduce((s, i) => s + itemSlaAge(i), 0) / total : 0;
    return { total, overdue, avgAge: avg.toFixed(1) };
  }, [filteredByModule]);

  const overdueTotalCount = useMemo(() => filteredByModule.filter(itemIsOverdue).length, [filteredByModule]);
  const highPriorityCount = useMemo(() => filteredByModule.filter((i) => i.urgency === "high").length, [filteredByModule]);

  const selectItem = useCallback((item: ActionHubItem) => {
    setSelectedId(item.id);
    setComment("");
    setError(null);
    setNotice(null);
    setDetailTab("details");
  }, []);

  // Fetch employee context lazily, with cache
  useEffect(() => {
    let cancelled = false;

    async function loadContext() {
      if (!selected) { setContextData(null); return; }
      const hrId = selected.employeeHrId;
      if (contextCacheRef.current.has(hrId)) {
        setContextData(contextCacheRef.current.get(hrId) ?? null);
        return;
      }
      setContextLoading(true);
      setContextData(null);
      try {
        const r = await fetch(`/api/approvals-hub/employee-context?hrId=${encodeURIComponent(hrId)}`);
        const body: unknown = r.ok ? await r.json() : null;
        const d = isEmployeeContext(body) ? body : null;
        if (!cancelled) {
          contextCacheRef.current.set(hrId, d);
          setContextData(d);
        }
      } catch {
        // ignore fetch errors
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    }

    void loadContext();
    return () => { cancelled = true; };
  }, [selected?.employeeHrId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snooze: purge expired entries on mount
  useEffect(() => { purgeSnoozed(); }, []);

  // Fetch managers list for super-admin view-as switcher
  useEffect(() => {
    if (!canViewAs || managers !== null) return;
    void fetch("/api/approvals-hub/managers")
      .then((r) => r.json())
      .then((d: { managers?: Array<{ hrId: string; name: string }> }) => {
        if (Array.isArray(d.managers)) setManagers(d.managers);
      })
      .catch(() => {});
  }, [canViewAs, managers]);

  // Fetch view-as items when a manager is selected (always resets to page 0)
  useEffect(() => {
    let cancelled = false;
    async function loadViewAs() {
      if (!viewAsHrId) {
        setViewAsItems(null);
        setViewAsOffset(0);
        setViewAsTotal(0);
        return;
      }
      setViewAsOffset(0);
      setViewAsLoading(true);
      try {
        const r = await fetch(
          `/api/approvals-hub/hub-data?viewAs=${encodeURIComponent(viewAsHrId)}&limit=${VIEW_AS_LIMIT}&offset=0`,
        );
        const d = (await r.json()) as { items?: ActionHubItem[]; total?: number };
        if (cancelled) return;
        if (Array.isArray(d.items)) setViewAsItems(d.items);
        if (typeof d.total === "number") setViewAsTotal(d.total);
        setViewAsLoading(false);
      } catch {
        if (!cancelled) setViewAsLoading(false);
      }
    }
    void loadViewAs();
    return () => { cancelled = true; };
  }, [viewAsHrId]);

  const loadMoreViewAs = useCallback(() => {
    if (!viewAsHrId || viewAsLoading) return;
    const nextOffset = viewAsOffset + VIEW_AS_LIMIT;
    setViewAsLoading(true);
    fetch(`/api/approvals-hub/hub-data?viewAs=${encodeURIComponent(viewAsHrId)}&limit=${VIEW_AS_LIMIT}&offset=${nextOffset}`)
      .then((r) => r.json())
      .then((d: { items?: ActionHubItem[]; total?: number }) => {
        if (Array.isArray(d.items)) {
          setViewAsItems((prev) => [...(prev ?? []), ...d.items!]);
          setViewAsOffset(nextOffset);
        }
        if (typeof d.total === "number") setViewAsTotal(d.total);
        setViewAsLoading(false);
      })
      .catch(() => setViewAsLoading(false));
  }, [viewAsHrId, viewAsOffset, viewAsLoading]);

  // Keyboard shortcuts
  const approveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!selected || busy) { approveRef.current = null; return; }
    if (selected.module === "excuse") {
      approveRef.current = () => {
        void callApi(`/api/excuses/${selected.id}/decision`, { decision: "approve", comment: null });
      };
    } else if (selected.module === "outstation") {
      approveRef.current = () => {
        void callApi(
          `/api/admin/outstation/${selected.id}`,
          { comment: null, expectedRevision: outstationRevisionOf(selected) },
          "POST",
        );
      };
    } else {
      approveRef.current = null;
    }
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        const idx = filteredItems.findIndex((i) => i.id === selectedId);
        const next = filteredItems[Math.min(idx + 1, filteredItems.length - 1)];
        if (next) { selectItem(next); e.preventDefault(); }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        const idx = filteredItems.findIndex((i) => i.id === selectedId);
        const prev = filteredItems[Math.max(idx - 1, 0)];
        if (prev) { selectItem(prev); e.preventDefault(); }
      } else if (e.key === "a") {
        approveRef.current?.();
        e.preventDefault();
      } else if (e.key === "r") {
        textareaRef.current?.focus();
        e.preventDefault();
      } else if (e.key === "Escape") {
        setComment("");
        setError(null);
      } else if (e.key === "?") {
        setShowShortcuts((p) => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filteredItems, selectedId, selectItem]);

  async function callApi(url: string, body: Record<string, unknown>, method: "POST" | "PATCH" = "POST") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok || !data.success) {
        // An outstation claim that moved after this list loaded: nothing was decided. Reload the
        // list so the new figures are on screen when the message is read, and keep his comment.
        if (data.error === OUTSTATION_CLAIM_CHANGED_CODE) router.refresh();
        throw new Error(
          typeof data.message === "string" ? data.message :
          typeof data.error === "string" ? data.error :
          "Action failed.",
        );
      }
      setComment("");
      setError(null);
      setNotice("Action recorded. Page refreshing…");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleLeaveAction(action: string) {
    if (!selected) return;
    if (action === "reject" && !comment.trim()) { setError("A rejection reason is required."); return; }
    if (action === "return" && !comment.trim()) { setError("Type the comment first, or use Return for Edit without one."); return; }
    void callApi(`/api/vacations/requests/${selected.id}/decision`, {
      decision: action === "acknowledge" ? "approve" : action === "return_plain" ? "return" : action,
      decisionComment: comment.trim() || null,
    });
  }

  function handleResignationAction(action: string) {
    if (!selected) return;
    if (action === "reject" && !comment.trim()) { setError("A rejection reason is required."); return; }
    void callApi(`/api/resignations/${selected.id}/workflow`, {
      action,
      note: action !== "reject" ? comment.trim() || undefined : undefined,
      rejectedReason: action === "reject" ? comment.trim() : undefined,
    });
  }

  function handleExcuseAction(decision: "approve" | "reject" | "return") {
    if (!selected) return;
    if (selected.readOnlyReason) { setError(selected.readOnlyReason); return; }
    if (decision === "return" && !comment.trim()) {
      setError("A manager reply is required when returning an excuse request.");
      return;
    }
    void callApi(`/api/excuses/${selected.id}/decision`, { decision, comment: comment.trim() || null });
  }

  function handleOutstationAction(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !comment.trim()) { setError("A rejection reason is required."); return; }
    // Both carry the version of the claim this list loaded, so a claim that moved since is refused.
    const expectedRevision = outstationRevisionOf(selected);
    if (decision === "approve") {
      void callApi(`/api/admin/outstation/${selected.id}`, { comment: comment.trim() || null, expectedRevision }, "POST");
    } else {
      void callApi(`/api/admin/outstation/${selected.id}`, { comment: comment.trim(), expectedRevision }, "PATCH");
    }
  }

  /**
   * Marketing decisions ask before they commit — the same guard the decision page carries. This is
   * the CEO's other route to the same irreversible write, so it must not be the unguarded one.
   */
  function handleMarketingAction(decision: MarketingConfirmDecision) {
    if (!selected) return;
    if ((decision === "reject" || decision === "return") && !comment.trim()) {
      setError("A comment is required for this action.");
      return;
    }
    setError(null);
    setMarketingConfirm(decision);
  }

  function confirmMarketingAction() {
    const decision = marketingConfirm;
    setMarketingConfirm(null);
    if (!decision || !selected) return;
    void callApi(`/api/marketing-requests/${selected.id}/decision`, { decision, comment: comment.trim() || null });
  }

  function snoozeAndUpdate(id: string) {
    setSnoozeExpiry(id);
    setSnoozeVersion((v) => v + 1);
    if (selectedId === id) setSelectedId(null);
  }

  function handleContractRenewalAction(action: string) {
    if (!selected) return;
    if (action === "not_renew" && !comment.trim()) { setError("A reason is required when not renewing."); return; }
    void callApi(`/api/contracts/${selected.id}/workflow`, { action, decisionReason: comment.trim() || undefined });
  }

  function handleWeeklyPlanAction(action: "approve" | "return" | "reject") {
    if (!selected || selected.detail.module !== "weekly_plan") return;
    if ((action === "return" || action === "reject") && !comment.trim()) {
      setError("A comment is required to return or reject a plan.");
      return;
    }
    const stage = selected.detail.stage;
    const apiAction =
      stage === "manager"
        ? action === "approve" ? "manager_approve" : action === "return" ? "manager_return" : "manager_reject"
        : action === "approve" ? "ceo_approve" : action === "return" ? "ceo_return" : "ceo_reject";
    void callApi(`/api/weekly-plans/${selected.id}/decision`, { action: apiAction, comment: comment.trim() || null });
  }

  function handleRequestVisitDetails() {
    if (!selected) return;
    void callApi(`/api/weekly-plans/${selected.id}/request-visit-details`, {});
  }

  async function handleBulkApprove() {
    if (bulkSelected.size === 0) return;
    setBulkBusy(true);
    const toApprove = allItems.filter((i) => bulkSelected.has(i.id) && !i.readOnlyReason);
    // A response is an approval only when it is OK. This used to count only a network failure as
    // failed, so a refusal (403, 409, 500) was reported as "approved". An outstation claim that moved
    // since this list loaded answers 409 and is counted on its own so the message can say why.
    const outcomes = await Promise.all(
      toApprove.map(async (item): Promise<"approved" | "changed" | "failed"> => {
        try {
          const response =
            item.module === "excuse"
              ? await fetch(`/api/excuses/${item.id}/decision`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ decision: "approve" }),
                })
              : item.module === "leave"
                ? await fetch(`/api/vacations/requests/${item.id}/decision`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ decision: "approve", comment: "" }),
                  })
                : await fetch(`/api/admin/outstation/${item.id}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ expectedRevision: outstationRevisionOf(item) }),
                  });
          if (response.ok) return "approved";
          const data = (await response.json().catch(() => ({}))) as { error?: unknown };
          return data.error === OUTSTATION_CLAIM_CHANGED_CODE ? "changed" : "failed";
        } catch {
          return "failed";
        }
      }),
    );
    const changed = outcomes.filter((outcome) => outcome === "changed").length;
    const failed = outcomes.length - outcomes.filter((outcome) => outcome === "approved").length;
    setBulkBusy(false);
    setBulkSelected(new Set());
    if (failed > 0) {
      setError(
        `${toApprove.length - failed} approved, ${failed} not approved.` +
          (changed > 0
            ? ` ${changed} outstation claim${changed === 1 ? "" : "s"} changed since this list loaded — review the new figures and approve again.`
            : ""),
      );
    } else {
      setNotice(`${toApprove.length} approved. Page refreshing…`);
    }
    router.refresh();
  }

  function toggleBulk(item: ActionHubItem, e: { stopPropagation: () => void }) {
    e.stopPropagation();
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  const modules: Array<ActionHubModule | "all"> = ["all", "leave", "resignation", "excuse", "outstation", "marketing", "contract_renewal", "weekly_plan"];
  const isBulkModule = (m: ActionHubModule | "all") => m === "excuse" || m === "outstation" || m === "leave";

  const priorLeaveHint = contextData?.recentLeave?.length
    ? contextData.recentLeave.map((r) => r.hrDecision ?? r.managerDecision)
    : null;

  const marketingDetail = selected?.detail.module === "marketing" ? selected.detail : null;
  const marketingPrompt =
    marketingConfirm && marketingDetail && selected
      ? buildMarketingDecisionConfirmPrompt({
          customerName: marketingDetail.customerName,
          decision: marketingConfirm,
          decisionLabel:
            marketingDetail.decisionLabels?.[marketingConfirm] ??
            (marketingConfirm === "approve" ? "Approve" : marketingConfirm === "reject" ? "Reject" : "Return for edit"),
          estimatedCost: marketingDetail.estimatedCost ?? 0,
          // The hub knows which rung holds the request, not which one comes after it.
          nextStepName: null,
          requestCode: marketingDetail.requestCode,
          requesterName: selected.employeeName,
        })
      : null;
  const marketingDialogRef = useDialogA11y<HTMLDivElement>({
    onClose: () => setMarketingConfirm(null),
    open: marketingPrompt !== null,
  });

  return (
    <div className="space-y-5">
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

      {!embedded && (
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip>{stats.total} pending</AdminInsightChip>
              <AdminInsightChip tone={stats.overdue > 0 ? "orange" : "slate"}>{stats.overdue} overdue</AdminInsightChip>
              <AdminInsightChip tone={highPriorityCount > 0 ? "orange" : "slate"}>{highPriorityCount} urgent</AdminInsightChip>
              <AdminInsightChip tone="slate">Avg {stats.avgAge}d age</AdminInsightChip>
            </>
          )}
          description="Review approvals, escalations, and manager decisions from the admin workspace without switching into the employee portal experience."
          eyebrow="Phoenix Workforce"
          icon={<Inbox className="h-3.5 w-3.5" />}
          title="Action Center"
        />
      )}

      {allItems.length === 0 ? (
        <div className={`flex min-h-[420px] flex-col items-center justify-center gap-5 p-12 text-center ${adminPanelClassName}`}>
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-1 ring-emerald-200/70 shadow-[0_12px_30px_rgba(16,185,129,0.18)]">
            <span className="absolute inset-0 rounded-full bg-emerald-400/10 blur-xl" aria-hidden />
            <CheckCircle2 className="h-10 w-10" />
          </div>
          <div>
            <p className="text-xl font-black tracking-tight text-slate-900">{notice ? "Request not found" : "All clear"}</p>
            <p className="mt-1.5 max-w-xs text-sm leading-6 text-slate-500">
              {notice ?? "No approvals or reviews waiting on you right now. You're on top of everything."}
            </p>
          </div>
        </div>
      ) : (
        <div className={`flex min-h-[640px] flex-col overflow-hidden lg:h-[calc(100dvh-16rem)] lg:min-h-[560px] lg:flex-row ${adminPanelClassName}`}>
          {/* Left rail */}
          <div className="flex w-full flex-col border-b border-[#E5EAF1] lg:w-[21rem] lg:shrink-0 lg:border-b-0 lg:border-r max-h-[45vh] lg:max-h-none">
            {/* Super-admin view-as switcher */}
            {canViewAs && managers && managers.length > 0 && (
              <div className="border-b border-[#E5EAF1] bg-slate-50/70 px-4 py-2.5">
                {viewAsLoading ? (
                  <p className="text-phx-xs text-slate-400">Loading queue…</p>
                ) : (
                  <SearchableSelect
                    value={viewAsHrId ?? ""}
                    onChange={(e) => {
                      setViewAsHrId(e.target.value || null);
                      setViewAsItems(null);
                      setSelectedId(null);
                    }}
                    className="w-full px-2.5 py-1.5 text-phx-xs"
                  >
                    <option value="">My queue</option>
                    {managers.map((m) => (
                      <option key={m.hrId} value={m.hrId}>{m.name} ({m.hrId})</option>
                    ))}
                  </SearchableSelect>
                )}
                {viewAsHrId && (
                  <p className="mt-1 flex items-center gap-1 text-phx-2xs font-bold text-orange-600">
                    <span className="h-1 w-1 rounded-full bg-orange-500" />
                    Viewing {managers.find(m => m.hrId === viewAsHrId)?.name ?? viewAsHrId}&apos;s queue
                  </p>
                )}
              </div>
            )}

            {/* Rail header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#E5EAF1] bg-gradient-to-b from-white to-slate-50/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">Queue</span>
                <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-phx-ink px-2 py-0.5 text-phx-xs font-black leading-none text-white">{stats.total}</span>
              </div>
              <div className="flex items-center gap-3 text-phx-xs">
                {stats.overdue > 0 && (
                  <span className="flex items-center gap-1 font-bold text-rose-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />{stats.overdue} overdue
                  </span>
                )}
                <span className="text-slate-400">avg <span className="font-bold text-slate-600">{stats.avgAge}d</span></span>
              </div>
            </div>

            {/* Module filter tabs */}
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#E5EAF1] bg-white px-2.5 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {modules.map((mod) => {
                const count = moduleCounts[mod] ?? 0;
                if (mod !== "all" && count === 0) return null;
                const active = activeModule === mod;
                return (
                  <button
                    key={mod}
                    onClick={() => {
                      setActiveModule(mod);
                      setActiveFilter("all");
                      setBulkSelected(new Set());
                      const firstInModule = allItems.find((item) => mod === "all" || item.module === mod);
                      if (firstInModule) selectItem(firstInModule);
                    }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-phx-xs font-bold transition-all ${
                      active
                        ? "bg-slate-900 text-white shadow-[0_4px_12px_rgba(15,23,42,0.18)]"
                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    }`}
                  >
                    {mod === "all" ? "All" : ACTION_HUB_MODULE_LABELS[mod as ActionHubModule]}
                    <span className={`inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 py-0.5 text-phx-2xs font-black leading-none ${
                      active ? "bg-orange-500 text-white" : "bg-slate-200/80 text-slate-600"
                    }`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Quick filter chips */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[#E5EAF1] bg-slate-50/50 px-3 py-2">
              {(["all", "overdue", "high"] as const).map((f) => {
                const chipCount = f === "all" ? filteredByModule.length : f === "overdue" ? overdueTotalCount : highPriorityCount;
                if (f !== "all" && chipCount === 0) return null;
                return (
                  <button
                    key={f}
                    onClick={() => setActiveFilter(f)}
                    className={`rounded-full border px-3 py-1 text-phx-xs font-bold transition-colors ${
                      activeFilter === f
                        ? f === "overdue"
                          ? "border-rose-200 bg-rose-50 text-rose-700"
                          : f === "high"
                            ? "border-orange-200 bg-orange-50 text-orange-700"
                            : "border-slate-300 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {f === "all" ? "All" : f === "overdue" ? `Overdue (${chipCount})` : `Urgent (${chipCount})`}
                  </button>
                );
              })}
            </div>

            {/* Item list */}
            <div className="flex-1 overflow-y-auto">
              {filteredItems.length === 0 ? (
                <p className="p-6 text-center text-sm text-slate-400">No items match this filter.</p>
              ) : (
                <ul className="divide-y divide-[#EEF2F7]">
                  {filteredItems.map((item) => {
                    const canBulk = isBulkModule(item.module);
                    const isSelected = selectedId === item.id;
                    return (
                      <li key={item.id} className="group relative">
                        <div
                          role="button"
                          tabIndex={0}
                          aria-pressed={isSelected}
                          onClick={() => selectItem(item)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectItem(item); } }}
                          className={`cursor-pointer px-4 py-3 text-left outline-none transition-colors focus-visible:bg-orange-50/60 ${
                            isSelected
                              ? "border-l-[3px] border-orange-500 bg-orange-50/70 pl-[13px]"
                              : "border-l-[3px] border-transparent hover:bg-slate-50"
                          }`}
                        >
                          <div className="mb-1.5 flex flex-wrap items-center gap-1">
                            <ModuleBadge module={item.module} />
                            <UrgencyBadge urgency={item.urgency} />
                            <SlaBadge item={item} />
                            {canBulk && (
                              <span
                                role="checkbox"
                                aria-checked={bulkSelected.has(item.id)}
                                aria-label={`Select ${item.employeeName}`}
                                tabIndex={0}
                                className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded border text-phx-2xs font-bold transition-colors ${
                                  bulkSelected.has(item.id)
                                    ? "border-orange-500 bg-orange-500 text-white"
                                    : "border-slate-300 bg-white text-transparent hover:border-orange-400"
                                }`}
                                onClick={(e) => toggleBulk(item, e)}
                                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") toggleBulk(item, e); }}
                              >
                                ✓
                              </span>
                            )}
                          </div>
                          <div className="flex items-start justify-between gap-1">
                            <p className={`text-sm font-bold leading-snug ${isSelected ? "text-slate-900" : "text-slate-800"}`}>
                              {item.employeeName}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); snoozeAndUpdate(item.id); }}
                              title="Snooze for 24h"
                              className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-slate-500"
                              aria-label="Snooze 24h"
                            >
                              ⏱
                            </button>
                          </div>
                          <p className="text-xs text-slate-500">{item.title}</p>
                          <p className="mt-0.5 text-phx-xs text-slate-400">
                            {item.employeeHrId} · {item.statusLabel}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {viewAsItems !== null && viewAsItems.length < viewAsTotal && (
                <div className="border-t border-[#EEF2F7] px-4 py-3">
                  <button
                    onClick={loadMoreViewAs}
                    disabled={viewAsLoading}
                    className="w-full rounded-lg border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {viewAsLoading ? "Loading…" : `Load more (${viewAsTotal - viewAsItems.length} remaining)`}
                  </button>
                </div>
              )}
            </div>

            {/* Bulk approve footer */}
            {bulkSelected.size > 0 && (
              <div className="shrink-0 border-t border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-700">{bulkSelected.size} selected</span>
                  <button
                    disabled={bulkBusy}
                    onClick={() => void handleBulkApprove()}
                    className={cn(
                      phxButtonApproveDenseClassName,
                      "px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-50",
                    )}
                  >
                    {bulkBusy ? "Approving…" : "Approve all"}
                  </button>
                  <button
                    onClick={() => setBulkSelected(new Set())}
                    className="text-xs text-slate-400 hover:text-slate-700"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Shortcuts hint */}
            <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-4 py-1.5">
              <button
                onClick={() => setShowShortcuts(true)}
                className="text-phx-xs text-slate-400 hover:text-slate-600"
              >
                ? Keyboard shortcuts
              </button>
            </div>
          </div>

          {/* Right detail panel */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-white">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-300 ring-1 ring-slate-200">
                  <Inbox className="h-6 w-6" />
                </div>
                <p className="text-sm font-bold text-slate-500">{notice ?? "Select an item to review it"}</p>
                <p className="text-xs text-slate-400">press <kbd className="rounded bg-slate-100 px-1 font-mono text-phx-2xs text-slate-500">j</kbd> / <kbd className="rounded bg-slate-100 px-1 font-mono text-phx-2xs text-slate-500">k</kbd> to navigate · <kbd className="rounded bg-slate-100 px-1 font-mono text-phx-2xs text-slate-500">?</kbd> for shortcuts</p>
              </div>
            ) : (
              <div>
                {/* Detail header — branded dark band */}
                <div className="relative overflow-hidden border-b border-slate-200 bg-[linear-gradient(135deg,#0a0a0c_0%,#101016_58%,#1b1003_100%)] px-5 py-4 sm:px-7">
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0" />
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <ModuleBadge module={selected.module} />
                    <UrgencyBadge urgency={selected.urgency} />
                    <SlaBadge item={selected} />
                  </div>
                  <h2 className="text-lg font-black text-white">{selected.employeeName}</h2>
                  <p className="text-sm text-slate-400">{selected.employeeHrId} · {selected.title}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>Status: <span className="font-semibold text-slate-300">{selected.statusLabel}</span></span>
                    <span>Submitted {new Date(selected.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}</span>
                    {priorLeaveHint && priorLeaveHint.length > 0 && (
                      <span>
                        Prior:{" "}
                        {priorLeaveHint.map((d, i) => (
                          <span key={i} className={d === "approved" ? "font-bold text-emerald-400" : d === "rejected" ? "font-bold text-rose-400" : "text-slate-500"}>
                            {d === "approved" ? "✓" : d === "rejected" ? "✗" : "–"}{" "}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>

                <div className="p-5 sm:p-7">
                  {/* Details | Context tabs */}
                  <div className="mb-5 flex gap-1 border-b border-slate-200">
                    {(["details", "context"] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setDetailTab(tab)}
                        className={`pb-2 px-1 text-xs font-bold transition-colors ${
                          detailTab === tab
                            ? "border-b-2 border-orange-500 text-orange-600"
                            : "text-slate-400 hover:text-slate-600"
                        }`}
                      >
                        {tab === "details" ? "Details" : "Employee Context"}
                      </button>
                    ))}
                  </div>

                  {detailTab === "context" ? (
                    <div className="mb-6 rounded-[14px] border border-[#E5EAF1] bg-[#FBFCFD] p-4">
                      <EmployeeContextPanel data={contextData} loading={contextLoading} />
                    </div>
                  ) : (
                    <>
                      {/* Module-specific detail */}
                      <div className="mb-6 rounded-[14px] border border-[#E5EAF1] bg-[#FBFCFD] p-4">
                        {selected.detail.module === "leave" && <LeaveDetailView detail={selected.detail} />}
                        {selected.detail.module === "resignation" && <ResignationDetailView detail={selected.detail} />}
                        {selected.detail.module === "excuse" && <ExcuseDetailView detail={selected.detail} />}
                        {selected.detail.module === "outstation" && <OutstationDetailView detail={selected.detail} />}
                        {selected.detail.module === "marketing" && <MarketingDetailView detail={selected.detail} />}
                        {selected.detail.module === "contract_renewal" && <ContractRenewalDetailView detail={selected.detail} />}
                        {selected.detail.module === "weekly_plan" && <WeeklyPlanCalendar detail={selected.detail} />}
                      </div>

                      {/* Action zone */}
                      <div className="rounded-[14px] border border-[#E5EAF1] bg-[#FBFCFD] p-4">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                          <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Decision</p>
                        </div>
                        {notice ? (
                          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
                            {notice}
                          </div>
                        ) : selected.readOnlyReason ? (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
                            {selected.readOnlyReason}
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {/* Template rejection reasons */}
                            {REJECTION_TEMPLATES[selected.module].length > 0 && (
                              <SearchableSelect
                                defaultValue=""
                                disabled={busy}
                                onChange={(e) => {
                                  if (e.target.value) {
                                    setComment(e.target.value);
                                    e.target.value = "";
                                  }
                                }}
                                className="w-full px-3 py-2 text-xs"
                              >
                                <option value="">— Select a template reason —</option>
                                {REJECTION_TEMPLATES[selected.module].map((t) => (
                                  <option key={t.label} value={t.text}>
                                    {t.label}
                                  </option>
                                ))}
                              </SearchableSelect>
                            )}

                            <textarea
                              ref={textareaRef}
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                              placeholder="Add a comment or rejection reason…"
                              rows={3}
                              disabled={busy}
                              className={phxTextareaClassName}
                            />

                            {error && (
                              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
                                {error}
                              </p>
                            )}

                            {/* Action buttons */}
                            <div className="flex flex-wrap gap-2 pt-1">
                              {selected.module === "leave" && selected.detail.module === "leave" && (() => {
                                const actions = resolveLeaveActions(selected.detail);
                                return actions.length > 0
                                  ? actions.map((action) => (
                                    <button
                                      key={action.key}
                                      disabled={busy}
                                      onClick={() => handleLeaveAction(action.key)}
                                      className={`rounded px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 ${
                                        action.variant === "approve"
                                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                          : action.variant === "reject"
                                            ? "bg-rose-600 text-white hover:bg-rose-700"
                                            : "bg-slate-700 text-white hover:bg-slate-800"
                                      }`}
                                    >
                                      {busy ? "…" : action.label}
                                    </button>
                                  ))
                                  : <p className="text-sm text-slate-400">No actions available for you on this request.</p>;
                              })()}

                              {selected.module === "resignation" && (() => {
                                const actions = resolveResignationActions(selected.statusLabel.replace(/ /g, "_"));
                                return actions.length > 0
                                  ? actions.map((action) => (
                                    <button
                                      key={action.key}
                                      disabled={busy}
                                      onClick={() => handleResignationAction(action.key)}
                                      className={`rounded px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 ${
                                        action.variant === "approve"
                                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                          : action.variant === "reject"
                                            ? "bg-rose-600 text-white hover:bg-rose-700"
                                            : "bg-amber-500 text-white hover:bg-amber-600"
                                      }`}
                                    >
                                      {busy ? "…" : action.label}
                                    </button>
                                  ))
                                  : <p className="text-sm text-slate-400">No workflow actions available.</p>;
                              })()}

                              {selected.module === "excuse" && (
                                <>
                                  <button disabled={busy} onClick={() => handleExcuseAction("approve")}
                                    className={phxButtonApproveClassName}>
                                    {busy ? "…" : "Approve"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleExcuseAction("return")}
                                    className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:opacity-50">
                                    {busy ? "…" : "Return with reply"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleExcuseAction("reject")}
                                    className={phxButtonDangerClassName}>
                                    {busy ? "…" : "Reject"}
                                  </button>
                                </>
                              )}

                              {selected.module === "outstation" && (
                                <>
                                  <button disabled={busy} onClick={() => handleOutstationAction("approve")}
                                    className={phxButtonApproveClassName}>
                                    {busy ? "…" : "Approve for Payroll"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleOutstationAction("reject")}
                                    className={phxButtonDangerClassName}>
                                    {busy ? "…" : "Reject"}
                                  </button>
                                </>
                              )}

                              {selected.module === "marketing" && selected.detail.module === "marketing" && (() => {
                                const labels = selected.detail.decisionLabels;
                                return (
                                  <>
                                    <button disabled={busy} onClick={() => handleMarketingAction("approve")}
                                      className={phxButtonApproveClassName}>
                                      {busy ? "…" : (labels?.approve ?? "Approve")}
                                    </button>
                                    {labels?.return && (
                                      <button disabled={busy} onClick={() => handleMarketingAction("return")}
                                        className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:opacity-50">
                                        {busy ? "…" : labels.return}
                                      </button>
                                    )}
                                    <button disabled={busy} onClick={() => handleMarketingAction("reject")}
                                      className={phxButtonDangerClassName}>
                                      {busy ? "…" : (labels?.reject ?? "Reject")}
                                    </button>
                                  </>
                                );
                              })()}

                              {selected.module === "contract_renewal" && selected.detail.module === "contract_renewal" && (() => {
                                const status = selected.detail.currentStatus;
                                return (
                                  <>
                                    {status === "requested" && (
                                      <button disabled={busy} onClick={() => handleContractRenewalAction("manager_review")}
                                        className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:opacity-50">
                                        {busy ? "…" : "Mark Under Review"}
                                      </button>
                                    )}
                                    {status === "manager_review" && (
                                      <button disabled={busy} onClick={() => handleContractRenewalAction("hr_review")}
                                        className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:opacity-50">
                                        {busy ? "…" : "Send to HR Review"}
                                      </button>
                                    )}
                                    <button disabled={busy} onClick={() => handleContractRenewalAction("renew")}
                                      className={phxButtonApproveClassName}>
                                      {busy ? "…" : "Renew Contract"}
                                    </button>
                                    <button disabled={busy} onClick={() => handleContractRenewalAction("not_renew")}
                                      className={phxButtonDangerClassName}>
                                      {busy ? "…" : "Do Not Renew"}
                                    </button>
                                  </>
                                );
                              })()}

                              {selected.module === "weekly_plan" && selected.detail.module === "weekly_plan" && (
                                <>
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("approve")}
                                    className={phxButtonApproveClassName}>
                                    {busy ? "…" : selected.detail.stage === "manager" ? "Approve → CEO" : "Approve (final)"}
                                  </button>
                                  {selected.detail.stage === "manager" && selected.detail.items.some((i) => i.activityType === "Field") && (
                                    <button disabled={busy} onClick={() => handleRequestVisitDetails()}
                                      className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm font-bold text-sky-700 shadow-sm transition-colors hover:border-sky-400 hover:bg-sky-100 disabled:opacity-50">
                                      {busy ? "…" : "Request Visit Details"}
                                    </button>
                                  )}
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("return")}
                                    className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-600 disabled:opacity-50">
                                    {busy ? "…" : "Return for edit"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("reject")}
                                    className={phxButtonDangerClassName}>
                                    {busy ? "…" : "Reject"}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {marketingPrompt && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
          <div
            aria-labelledby="action-center-marketing-confirm-title"
            aria-modal
            className="w-full max-w-md rounded-xl bg-white shadow-xl"
            ref={marketingDialogRef}
            role="dialog"
          >
            <div className="px-5 py-4">
              <h2 className="text-base font-bold text-slate-950" id="action-center-marketing-confirm-title">
                {marketingPrompt.title}
              </h2>
              <p className="mt-2 text-sm text-slate-700">{marketingPrompt.body}</p>
              <p className="mt-2 text-sm font-medium text-slate-950">{marketingPrompt.consequence}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <button
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700"
                onClick={() => setMarketingConfirm(null)}
                type="button"
              >
                {marketingPrompt.cancelLabel}
              </button>
              <button
                className={`rounded-lg px-4 py-2 text-sm font-bold text-white ${
                  marketingConfirm === "reject"
                    ? "bg-rose-600"
                    : marketingConfirm === "return"
                      ? "bg-amber-500"
                      : "bg-emerald-600"
                }`}
                disabled={busy}
                onClick={confirmMarketingAction}
                type="button"
              >
                {marketingPrompt.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
