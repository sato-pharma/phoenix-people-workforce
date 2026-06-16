"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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

// ── Snooze helpers (localStorage, no backend) ────────────────────────────────
const SNOOZE_KEY = "phoenix-action-snooze:v1";
function getSnoozeMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>; }
  catch { return {}; }
}
function setSnoozeExpiry(id: string) {
  const m = getSnoozeMap();
  m[id] = Date.now() + 86_400_000;
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(m));
}
function isSnoozed(id: string): boolean {
  return (getSnoozeMap()[id] ?? 0) > Date.now();
}
function purgeSnoozed() {
  const m = getSnoozeMap();
  const now = Date.now();
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v > now))));
}

type Props = {
  initialData: ActionHubData;
  initialModule?: ActionHubModule | null;
  initialId?: string | null;
  callerRole?: string | null;
};

type ContextData = {
  attendance: {
    absentDays: number;
    completeDays: number;
    deductionDays: number;
    exceptionDays: number;
    lateDays: number;
    shortDays: number;
    totalRows: number;
    dateFrom: string;
    dateTo: string;
  };
  recentLeave: Array<{
    endDate: string;
    hrDecision: "approved" | "rejected" | null;
    managerDecision: "approved" | "rejected" | null;
    startDate: string;
    vacationType: string;
  }>;
  recentExcuses: Array<{
    excuseDate: string;
    excuseType: "morning" | "afternoon";
    status: string;
  }>;
};

const SLA_THRESHOLDS: Record<ActionHubModule, number> = {
  leave: 3,
  excuse: 2,
  outstation: 3,
  resignation: 5,
  marketing: 3,
  contract_renewal: 7,
};

const MODULE_COLORS: Record<ActionHubModule, string> = {
  leave: "bg-sky-100 text-sky-800 border-sky-300",
  resignation: "bg-rose-100 text-rose-800 border-rose-300",
  excuse: "bg-amber-100 text-amber-900 border-amber-300",
  outstation: "bg-violet-100 text-violet-800 border-violet-300",
  marketing: "bg-emerald-100 text-emerald-800 border-emerald-300",
  contract_renewal: "bg-teal-100 text-teal-800 border-teal-300",
};

const URGENCY_COLORS: Record<string, string> = {
  high: "bg-rose-100 text-rose-800 border-rose-300",
  normal: "bg-amber-100 text-amber-900 border-amber-300",
  low: "bg-slate-100 text-slate-600 border-slate-300",
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
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${MODULE_COLORS[module]}`}>
      {ACTION_HUB_MODULE_LABELS[module]}
    </span>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  if (urgency === "normal") return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${URGENCY_COLORS[urgency]}`}>
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
      <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800">
        Overdue {age}d
      </span>
    );
  }
  if (daysLeft <= 1) {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
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
      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  );
}

function ApprovalTimeline({ steps }: { steps: LeaveDetail["approvalSteps"] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <p className="mb-3 text-[11px] font-black uppercase tracking-wide text-slate-500">Approval history</p>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.stepKey} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${step.status === "approved" ? "bg-emerald-500" : step.status === "rejected" ? "bg-rose-500" : step.status === "pending" ? "bg-amber-400" : "bg-slate-300"}`} />
              <span className="text-xs font-bold text-slate-700">{step.genericStep.replace(/_/g, " ")}</span>
              {step.approverName && <span className="text-[11px] text-slate-500">· {step.approverName}</span>}
              <span className={`ml-auto text-[11px] font-black ${step.status === "approved" ? "text-emerald-700" : step.status === "rejected" ? "text-rose-700" : step.status === "pending" ? "text-amber-700" : "text-slate-500"}`}>
                {step.status === "approved" ? "✓ approved" : step.status === "rejected" ? "✗ rejected" : step.status}
              </span>
              {step.decidedAt && (
                <span className="text-[10px] text-slate-400">
                  {new Date(step.decidedAt).toLocaleDateString("en", { day: "2-digit", month: "short" })}
                </span>
              )}
            </div>
            {step.decisionComment && (
              <p className="mt-0.5 rounded bg-slate-50 px-2 py-1 text-[11px] italic text-slate-600">
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
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${detail.slaAgeDays >= 3 ? "border-rose-300 bg-rose-100 text-rose-800" : "border-amber-300 bg-amber-100 text-amber-900"}`}>
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
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Reason</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.reason}</dd>
        </div>
      )}
      {detail.workflowNotes && (
        <div className="col-span-2">
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.workflowNotes}</dd>
        </div>
      )}
      {detail.rejectedReason && (
        <div className="col-span-2">
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-rose-600">Rejected reason</dt>
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
      {detail.fraudFlags.length > 0 && (
        <div className="col-span-2">
          <dt className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-rose-600">Fraud flags</dt>
          <dd className="flex flex-wrap gap-1.5">
            {detail.fraudFlags.map((flag) => (
              <span key={flag} className="rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-800">
                {flag.replace(/_/g, " ")}
              </span>
            ))}
          </dd>
        </div>
      )}
      {detail.notes && (
        <div className="col-span-2">
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes</dt>
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
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Notes</dt>
          <dd className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{detail.workflowNotes}</dd>
        </div>
      )}
      {detail.decisionReason && (
        <div className="col-span-2">
          <dt className="mb-1 text-[11px] font-bold uppercase tracking-wide text-rose-600">Decision reason</dt>
          <dd className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{detail.decisionReason}</dd>
        </div>
      )}
    </dl>
  );
}

function EmployeeContextPanel({ data, loading }: { data: ContextData | null; loading: boolean }) {
  if (loading) return <p className="text-sm text-slate-400">Loading context…</p>;
  if (!data) return <p className="text-sm text-slate-400">Context unavailable.</p>;

  const priorLeaveDecisions = data.recentLeave.map((r) => r.hrDecision ?? r.managerDecision);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2.5 text-[11px] font-black uppercase tracking-wide text-slate-500">
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
              <p className="text-[10px] font-bold uppercase">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {data.recentLeave.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-500">
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

      {data.recentExcuses.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-500">Recent excuses</p>
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
                  <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-700">{key}</kbd>
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

export function ActionCenterHub({ initialData, initialModule, initialId, callerRole }: Props) {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contextCacheRef = useRef(new Map<string, ContextData>());

  const [activeModule, setActiveModule] = useState<ActionHubModule | "all">(initialModule ?? "all");
  const [activeFilter, setActiveFilter] = useState<"all" | "overdue" | "high">("all");
  const [viewAsItems, setViewAsItems] = useState<ActionHubItem[] | null>(null);

  const allItems = useMemo(() => viewAsItems ?? initialData.items, [initialData, viewAsItems]);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (initialId) {
      const found = initialData.items.find((item) => item.id === initialId && (initialModule ? item.module === initialModule : true));
      return found ? found.id : initialData.items[0]?.id ?? null;
    }
    return allItems[0]?.id ?? null;
  });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  const canViewAs = callerRole === "Super Admin" || callerRole === "HR Manager";

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
      const cached = contextCacheRef.current.get(hrId);
      if (cached) { setContextData(cached); return; }
      setContextLoading(true);
      setContextData(null);
      try {
        const r = await fetch(`/api/action-center/employee-context?hrId=${encodeURIComponent(hrId)}`);
        const d = (await r.json()) as ContextData;
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
    void fetch("/api/action-center/managers")
      .then((r) => r.json())
      .then((d: { managers?: Array<{ hrId: string; name: string }> }) => {
        if (Array.isArray(d.managers)) setManagers(d.managers);
      })
      .catch(() => {});
  }, [canViewAs, managers]);

  // Fetch view-as items when a manager is selected
  useEffect(() => {
    let cancelled = false;
    async function loadViewAs() {
      if (!viewAsHrId) { setViewAsItems(null); return; }
      setViewAsLoading(true);
      try {
        const r = await fetch(`/api/action-center/hub-data?viewAs=${encodeURIComponent(viewAsHrId)}`);
        const d = (await r.json()) as { items?: ActionHubItem[] };
        if (!cancelled && Array.isArray(d.items)) setViewAsItems(d.items);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setViewAsLoading(false);
      }
    }
    void loadViewAs();
    return () => { cancelled = true; };
  }, [viewAsHrId]);

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
        void callApi(`/api/admin/outstation/${selected.id}`, { comment: null }, "POST");
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
    void callApi(`/api/vacations/requests/${selected.id}/decision`, {
      decision: action === "acknowledge" ? "approve" : action,
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

  function handleExcuseAction(decision: "approve" | "reject") {
    if (!selected) return;
    void callApi(`/api/excuses/${selected.id}/decision`, { decision, comment: comment.trim() || null });
  }

  function handleOutstationAction(decision: "approve" | "reject") {
    if (!selected) return;
    if (decision === "reject" && !comment.trim()) { setError("A rejection reason is required."); return; }
    if (decision === "approve") {
      void callApi(`/api/admin/outstation/${selected.id}`, { comment: comment.trim() || null }, "POST");
    } else {
      void callApi(`/api/admin/outstation/${selected.id}`, { comment: comment.trim() }, "PATCH");
    }
  }

  function handleMarketingAction(decision: string) {
    if (!selected) return;
    if ((decision === "reject" || decision === "return") && !comment.trim()) {
      setError("A comment is required for this action.");
      return;
    }
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

  async function handleBulkApprove() {
    if (bulkSelected.size === 0) return;
    setBulkBusy(true);
    const toApprove = allItems.filter((i) => bulkSelected.has(i.id));
    const results = await Promise.allSettled(
      toApprove.map((item) => {
        if (item.module === "excuse") {
          return fetch(`/api/excuses/${item.id}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          });
        }
        if (item.module === "leave") {
          return fetch(`/api/vacations/requests/${item.id}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "approve", comment: "" }),
          });
        }
        return fetch(`/api/admin/outstation/${item.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      }),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    setBulkBusy(false);
    setBulkSelected(new Set());
    if (failed > 0) {
      setError(`${toApprove.length - failed} approved, ${failed} failed.`);
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

  const modules: Array<ActionHubModule | "all"> = ["all", "leave", "resignation", "excuse", "outstation", "marketing", "contract_renewal"];
  const isBulkModule = (m: ActionHubModule | "all") => m === "excuse" || m === "outstation" || m === "leave";

  const priorLeaveHint = contextData?.recentLeave.length
    ? contextData.recentLeave.map((r) => r.hrDecision ?? r.managerDecision)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

      {/* Page header */}
      <div className="border-b border-slate-200 bg-slate-900 px-4 py-3 sm:px-6">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-orange-400">Phoenix Workforce</p>
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-black text-white">Action Center</h1>
          {allItems.length > 0 && (
            <span className="rounded-full bg-orange-500 px-2.5 py-0.5 text-xs font-black text-white">
              {allItems.length}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-slate-400">All pending approvals, reviews, and decisions in one place.</p>
      </div>

      {allItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-2xl">✓</div>
          <p className="text-lg font-black text-slate-900">All clear</p>
          <p className="max-w-xs text-sm text-slate-500">No pending approvals or reviews. Check back when new requests come in.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Left rail */}
          <div className="flex w-full flex-col border-b border-slate-200 lg:w-80 lg:shrink-0 lg:border-b-0 lg:border-r">
            {/* Super-admin view-as switcher */}
            {canViewAs && managers && managers.length > 0 && (
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                {viewAsLoading ? (
                  <p className="text-[11px] text-slate-400">Loading queue…</p>
                ) : (
                  <select
                    value={viewAsHrId ?? ""}
                    onChange={(e) => {
                      setViewAsHrId(e.target.value || null);
                      setViewAsItems(null);
                      setSelectedId(null);
                    }}
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 focus:outline-none"
                  >
                    <option value="">My queue</option>
                    {managers.map((m) => (
                      <option key={m.hrId} value={m.hrId}>{m.name} ({m.hrId})</option>
                    ))}
                  </select>
                )}
                {viewAsHrId && (
                  <p className="mt-0.5 text-[10px] text-orange-600 font-bold">Viewing {managers.find(m => m.hrId === viewAsHrId)?.name ?? viewAsHrId}&apos;s queue</p>
                )}
              </div>
            )}

            {/* Stats bar */}
            <div className="flex items-center gap-4 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px]">
              <span className="text-slate-500">
                <span className="font-black text-slate-800">{stats.total}</span> pending
              </span>
              {stats.overdue > 0 && (
                <span className="text-slate-500">
                  <span className="font-black text-rose-700">{stats.overdue}</span> overdue
                </span>
              )}
              <span className="text-slate-500">
                Avg <span className="font-black text-slate-800">{stats.avgAge}</span>d
              </span>
            </div>

            {/* Module filter tabs */}
            <div className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 p-2">
              {modules.map((mod) => {
                const count = moduleCounts[mod] ?? 0;
                if (mod !== "all" && count === 0) return null;
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
                    className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold transition-colors ${
                      activeModule === mod
                        ? "bg-orange-500 text-white shadow-sm"
                        : "text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {mod === "all" ? "All" : ACTION_HUB_MODULE_LABELS[mod as ActionHubModule]}
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black ${activeModule === mod ? "bg-orange-600 text-orange-100" : "bg-slate-200 text-slate-700"}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Quick filter chips */}
            <div className="flex items-center gap-1.5 border-b border-slate-100 bg-white px-3 py-2">
              {(["all", "overdue", "high"] as const).map((f) => {
                const chipCount = f === "all" ? filteredByModule.length : f === "overdue" ? overdueTotalCount : highPriorityCount;
                if (f !== "all" && chipCount === 0) return null;
                return (
                  <button
                    key={f}
                    onClick={() => setActiveFilter(f)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition-colors ${
                      activeFilter === f
                        ? f === "overdue"
                          ? "border-rose-400 bg-rose-100 text-rose-800"
                          : f === "high"
                            ? "border-orange-400 bg-orange-100 text-orange-800"
                            : "border-slate-300 bg-slate-100 text-slate-800"
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
                <ul className="divide-y divide-slate-100">
                  {filteredItems.map((item) => {
                    const canBulk = isBulkModule(item.module);
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => selectItem(item)}
                          className={`w-full px-4 py-3 text-left transition-colors hover:bg-orange-50 ${
                            selectedId === item.id ? "border-l-2 border-orange-500 bg-orange-50" : "border-l-2 border-transparent"
                          }`}
                        >
                          <div className="mb-1.5 flex items-center gap-1.5">
                            <ModuleBadge module={item.module} />
                            <UrgencyBadge urgency={item.urgency} />
                            <SlaBadge item={item} />
                            {canBulk && (
                              <span
                                role="checkbox"
                                aria-checked={bulkSelected.has(item.id)}
                                aria-label={`Select ${item.employeeName}`}
                                tabIndex={0}
                                className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold transition-colors ${
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
                          <div className="flex items-center justify-between gap-1">
                            <p className="text-sm font-bold text-slate-900">{item.employeeName}</p>
                            <button
                              onClick={(e) => { e.stopPropagation(); snoozeAndUpdate(item.id); }}
                              title="Snooze for 24h"
                              className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-slate-500"
                              aria-label="Snooze 24h"
                            >
                              ⏱
                            </button>
                          </div>
                          <p className="text-xs text-slate-600">{item.title}</p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            {item.employeeHrId} · {item.statusLabel}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
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
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
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
                className="text-[11px] text-slate-400 hover:text-slate-600"
              >
                ? Keyboard shortcuts
              </button>
            </div>
          </div>

          {/* Right detail panel */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
                <p className="text-sm text-slate-400">Select an item from the list to review it.</p>
                <p className="text-xs text-slate-300">Tip: press j / k to navigate, ? for keyboard shortcuts</p>
              </div>
            ) : (
              <div className="p-5 sm:p-7">
                {/* Item header */}
                <div className="mb-5">
                  <div className="mb-2 flex items-center gap-2">
                    <ModuleBadge module={selected.module} />
                    <UrgencyBadge urgency={selected.urgency} />
                  </div>
                  <h2 className="text-xl font-black text-slate-900">{selected.employeeName}</h2>
                  <p className="text-sm text-slate-500">{selected.employeeHrId} · {selected.title}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Status: <span className="font-semibold text-slate-600">{selected.statusLabel}</span>
                    {" · "}Submitted {new Date(selected.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}
                  </p>
                  {priorLeaveHint && priorLeaveHint.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-slate-400">
                      Prior decisions:{" "}
                      {priorLeaveHint.map((d, i) => (
                        <span key={i} className={d === "approved" ? "font-bold text-emerald-600" : d === "rejected" ? "font-bold text-rose-600" : "text-slate-400"}>
                          {d === "approved" ? "✓" : d === "rejected" ? "✗" : "–"}{" "}
                        </span>
                      ))}
                    </p>
                  )}
                </div>

                {/* Details | Context tabs */}
                <div className="mb-4 flex gap-1 border-b border-slate-200">
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
                  <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <EmployeeContextPanel data={contextData} loading={contextLoading} />
                  </div>
                ) : (
                  <>
                    {/* Module-specific detail */}
                    <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      {selected.detail.module === "leave" && <LeaveDetailView detail={selected.detail} />}
                      {selected.detail.module === "resignation" && <ResignationDetailView detail={selected.detail} />}
                      {selected.detail.module === "excuse" && <ExcuseDetailView detail={selected.detail} />}
                      {selected.detail.module === "outstation" && <OutstationDetailView detail={selected.detail} />}
                      {selected.detail.module === "marketing" && <MarketingDetailView detail={selected.detail} />}
                      {selected.detail.module === "contract_renewal" && <ContractRenewalDetailView detail={selected.detail} />}
                    </div>

                    <hr className="mb-6 border-slate-200" />

                    {/* Action zone */}
                    {notice ? (
                      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
                        {notice}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Template rejection reasons */}
                        {REJECTION_TEMPLATES[selected.module].length > 0 && (
                          <div>
                            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">
                              Quick templates
                            </label>
                            <select
                              defaultValue=""
                              disabled={busy}
                              onChange={(e) => {
                                if (e.target.value) {
                                  setComment(e.target.value);
                                  e.target.value = "";
                                }
                              }}
                              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 focus:border-orange-300 focus:outline-none disabled:opacity-50"
                            >
                              <option value="">— Select a template reason —</option>
                              {REJECTION_TEMPLATES[selected.module].map((t) => (
                                <option key={t.label} value={t.text}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
                            Comment / reason
                          </label>
                          <textarea
                            ref={textareaRef}
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder="Add a comment or rejection reason…"
                            rows={3}
                            disabled={busy}
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:opacity-50"
                          />
                        </div>

                        {error && (
                          <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
                            {error}
                          </p>
                        )}

                        {/* Action buttons per module */}
                        {selected.module === "leave" && selected.detail.module === "leave" && (() => {
                          const actions = resolveLeaveActions(selected.detail);
                          return actions.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {actions.map((action) => (
                                <button
                                  key={action.key}
                                  disabled={busy}
                                  onClick={() => handleLeaveAction(action.key)}
                                  className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 ${
                                    action.variant === "approve"
                                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                      : action.variant === "reject"
                                        ? "bg-rose-600 text-white hover:bg-rose-700"
                                        : "bg-slate-600 text-white hover:bg-slate-700"
                                  }`}
                                >
                                  {busy ? "…" : action.label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-slate-400">No actions available for you on this request.</p>
                          );
                        })()}

                        {selected.module === "resignation" && (() => {
                          const actions = resolveResignationActions(selected.statusLabel.replace(/ /g, "_"));
                          return actions.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {actions.map((action) => (
                                <button
                                  key={action.key}
                                  disabled={busy}
                                  onClick={() => handleResignationAction(action.key)}
                                  className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 ${
                                    action.variant === "approve"
                                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                      : action.variant === "reject"
                                        ? "bg-rose-600 text-white hover:bg-rose-700"
                                        : "bg-amber-500 text-white hover:bg-amber-600"
                                  }`}
                                >
                                  {busy ? "…" : action.label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-slate-400">No workflow actions available for you on this resignation.</p>
                          );
                        })()}

                        {selected.module === "excuse" && (
                          <div className="flex flex-wrap gap-2">
                            <button
                              disabled={busy}
                              onClick={() => handleExcuseAction("approve")}
                              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {busy ? "…" : "Approve"}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => handleExcuseAction("reject")}
                              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                            >
                              {busy ? "…" : "Reject"}
                            </button>
                          </div>
                        )}

                        {selected.module === "outstation" && (
                          <div className="flex flex-wrap gap-2">
                            <button
                              disabled={busy}
                              onClick={() => handleOutstationAction("approve")}
                              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {busy ? "…" : "Approve for Payroll"}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => handleOutstationAction("reject")}
                              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                            >
                              {busy ? "…" : "Reject"}
                            </button>
                          </div>
                        )}

                        {selected.module === "marketing" && selected.detail.module === "marketing" && (() => {
                          const labels = selected.detail.decisionLabels;
                          return (
                            <div className="flex flex-wrap gap-2">
                              <button
                                disabled={busy}
                                onClick={() => handleMarketingAction("approve")}
                                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {busy ? "…" : (labels?.approve ?? "Approve")}
                              </button>
                              {labels?.return && (
                                <button
                                  disabled={busy}
                                  onClick={() => handleMarketingAction("return")}
                                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                                >
                                  {busy ? "…" : labels.return}
                                </button>
                              )}
                              <button
                                disabled={busy}
                                onClick={() => handleMarketingAction("reject")}
                                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                              >
                                {busy ? "…" : (labels?.reject ?? "Reject")}
                              </button>
                            </div>
                          );
                        })()}

                        {selected.module === "contract_renewal" && selected.detail.module === "contract_renewal" && (() => {
                          const status = selected.detail.currentStatus;
                          return (
                            <div className="flex flex-wrap gap-2">
                              {status === "requested" && (
                                <button
                                  disabled={busy}
                                  onClick={() => handleContractRenewalAction("manager_review")}
                                  className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                                >
                                  {busy ? "…" : "Mark Under Review"}
                                </button>
                              )}
                              {status === "manager_review" && (
                                <button
                                  disabled={busy}
                                  onClick={() => handleContractRenewalAction("hr_review")}
                                  className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                                >
                                  {busy ? "…" : "Send to HR Review"}
                                </button>
                              )}
                              <button
                                disabled={busy}
                                onClick={() => handleContractRenewalAction("renew")}
                                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {busy ? "…" : "Renew Contract"}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => handleContractRenewalAction("not_renew")}
                                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                              >
                                {busy ? "…" : "Do Not Renew"}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
