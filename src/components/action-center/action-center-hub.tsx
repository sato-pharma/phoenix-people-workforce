"use client";

import { humanizeCode } from "@/lib/format/code-label";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import { vacationTypeLabel } from "@/lib/vacation/calculations";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
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
import { resolveResignationActions } from "@/lib/action-center/resignation-actions";
import { OUTSTATION_CLAIM_CHANGED_CODE } from "@/lib/outstation/claim-revision";
import {
  buildMarketingDecisionConfirmPrompt,
  type MarketingConfirmDecision,
} from "@/lib/marketing-requests/decision-confirm-prompt";
import { approvalActionClassName, type ApprovalTone } from "@/components/approvals-hub/approval-action-kit";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingEmpty,
  LandingRailLine,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { phxTextareaClassName } from "@/components/ui/form-tokens";


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

// The kit's language (landing-kit.tsx): a module is named in small capitals beside a square swatch of
// its colour, never a filled pill; urgency and the SLA are coloured small text, and the SLA's age is
// a thin rail under the row. Orange is kept for the title tick alone.
const MODULE_DOTS: Record<ActionHubModule, string> = {
  leave: "bg-sky-500",
  resignation: "bg-rose-500",
  excuse: "bg-amber-500",
  outstation: "bg-violet-500",
  marketing: "bg-emerald-500",
  contract_renewal: "bg-teal-500",
  weekly_plan: "bg-indigo-500",
};

const URGENCY_TEXT: Record<string, string> = {
  high: "text-rose-700",
  normal: "text-amber-700",
  low: "text-slate-500",
};

/** The panel every hub surface sits in: the kit's white sheet, its hairline and the soft depth token. */
const HUB_PANEL = `border border-slate-200 bg-white ${adminSoftDepthClassName}`;
/** The small capitals every label in the hub is set in. */
const HUB_LABEL = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";
/**
 * The keyboard ring for a row inside the queue's own scroller: the kit's orange outline drawn INSIDE
 * the row, so the scroller cannot clip it the way it clips an outline drawn outside.
 */
const ROW_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#F05A1A]";

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
    <span className={`inline-flex items-center gap-1.5 ${HUB_LABEL}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${MODULE_DOTS[module]}`} />
      {ACTION_HUB_MODULE_LABELS[module]}
    </span>
  );
}

function UrgencyBadge({ urgency }: { urgency: string }) {
  if (urgency === "normal") return null;
  return (
    <span className={`text-phx-xs font-bold uppercase tracking-[0.1em] ${URGENCY_TEXT[urgency] ?? "text-slate-500"}`}>
      {urgency === "high" ? "Urgent" : "Low"}
    </span>
  );
}

type SlaState = "within" | "near" | "over";

function slaStateOf(item: ActionHubItem): SlaState {
  if (itemIsOverdue(item)) return "over";
  return SLA_THRESHOLDS[item.module] - itemSlaAge(item) <= 1 ? "near" : "within";
}

const SLA_RAIL: Record<SlaState, string> = { within: "bg-emerald-500", near: "bg-amber-500", over: "bg-rose-500" };

function SlaBadge({ item }: { item: ActionHubItem }) {
  const age = itemSlaAge(item);
  if (age <= 0) return null;
  const overdue = itemIsOverdue(item);
  const threshold = SLA_THRESHOLDS[item.module];
  const daysLeft = threshold - age;
  if (overdue) {
    return (
      <span className="text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums text-rose-700">
        Overdue {age}d
      </span>
    );
  }
  if (daysLeft <= 1) {
    return (
      <span className="text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums text-amber-700">
        {daysLeft === 0 ? "Due today" : "1d left"}
      </span>
    );
  }
  return null;
}

/**
 * How long a request has waited against its module's SLA, as a 2px rail: emerald while it is within
 * the window, amber on its last day, rose once it is over. Full width means the SLA is spent.
 */
function SlaRail({ item }: { item: ActionHubItem }) {
  const threshold = SLA_THRESHOLDS[item.module];
  const width = Math.max(0, Math.min(100, (itemSlaAge(item) / Math.max(1, threshold)) * 100));
  return (
    <div aria-hidden="true" className="mt-2 h-0.5 w-full bg-slate-100">
      <div className={`h-full ${SLA_RAIL[slaStateOf(item)]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={HUB_LABEL}>{label}</dt>
      <dd className={`break-words text-sm font-semibold ${LANDING_INK}`} dir="auto">{value}</dd>
    </div>
  );
}

/** A note or a reason under the facts: its words in full, on a 2px rail — rose when it is a refusal. */
function DetailNote({ label, children, tone = "neutral" }: { label: string; children: React.ReactNode; tone?: "neutral" | "reject" }) {
  return (
    <div className="col-span-2 min-w-0">
      <dt className={`mb-1 text-phx-xs font-bold uppercase tracking-[0.1em] ${tone === "reject" ? "text-rose-700" : "text-slate-500"}`}>{label}</dt>
      <dd
        className={`whitespace-pre-line break-words border-l-2 py-1 pl-3 text-sm ${tone === "reject" ? "border-rose-500 text-rose-800" : "border-slate-300 text-slate-700"}`}
        dir="auto"
      >
        {children}
      </dd>
    </div>
  );
}

const STEP_RAIL: Record<string, string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  pending: "bg-amber-400",
};

const STEP_TEXT: Record<string, string> = {
  approved: "text-emerald-700",
  rejected: "text-rose-700",
  pending: "text-amber-700",
};

function ApprovalTimeline({ steps }: { steps: LeaveDetail["approvalSteps"] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-3">
        <LandingTitle as="h3">Approval history</LandingTitle>
      </div>
      <ol className="divide-y divide-slate-200 border border-slate-200">
        {steps.map((step) => (
          <li key={step.stepKey} className="flex min-w-0 gap-3 px-3 py-2.5">
            <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${STEP_RAIL[step.status] ?? "bg-slate-300"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={`text-xs font-bold ${LANDING_INK}`}>{humanizeCode(step.genericStep)}</span>
                {step.approverName && <span className="break-words text-phx-xs text-slate-500" dir="auto">· {step.approverName}</span>}
                <span className={`ml-auto text-phx-xs font-black ${STEP_TEXT[step.status] ?? "text-slate-500"}`}>
                  {step.status === "approved" ? "✓ approved" : step.status === "rejected" ? "✗ rejected" : step.status}
                </span>
                {step.decidedAt && (
                  <span className="text-phx-xs tabular-nums text-slate-400">
                    {new Date(step.decidedAt).toLocaleDateString("en", { day: "2-digit", month: "short" })}
                  </span>
                )}
              </div>
              {step.decisionComment && (
                <p className="mt-1 whitespace-pre-line break-words border-l-2 border-slate-300 pl-2 text-phx-xs italic text-slate-600" dir="auto">
                  &ldquo;{step.decisionComment}&rdquo;
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
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
          <div className="col-span-2 flex items-center gap-2">
            <span aria-hidden="true" className={`h-3 w-1 shrink-0 ${detail.slaAgeDays >= 3 ? "bg-rose-500" : "bg-amber-500"}`} />
            <span className={`text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums ${detail.slaAgeDays >= 3 ? "text-rose-700" : "text-amber-700"}`}>
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
      {detail.reason && <DetailNote label="Reason">{detail.reason}</DetailNote>}
      {detail.workflowNotes && <DetailNote label="Notes">{detail.workflowNotes}</DetailNote>}
      {detail.rejectedReason && (
        <DetailNote label="Rejected reason" tone="reject">
          {detail.rejectedReason}
        </DetailNote>
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
  const recTone =
    detail.approvalRecommendation === "auto_approve"
      ? { rail: "bg-emerald-500", text: "text-emerald-700" }
      : detail.approvalRecommendation === "hr_review"
        ? { rail: "bg-rose-500", text: "text-rose-700" }
        : { rail: "bg-amber-500", text: "text-amber-700" };

  return (
    <dl className="grid grid-cols-2 gap-4">
      <DetailRow label="Expense type" value={detail.expenseType} />
      <DetailRow label="Destination" value={detail.toLabel} />
      <DetailRow label="Trip start" value={detail.tripStartDate} />
      <DetailRow label="Trip end" value={detail.tripEndDate} />
      <DetailRow label="Claimed amount" value={`${Number(detail.claimedTotalAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`} />
      <DetailRow label="Allowance" value={`${Number(detail.allowanceAmount || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`} />
      <div className="col-span-2 flex min-w-0 gap-3">
        <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${recTone.rail}`} />
        <div className="min-w-0">
          <span className={`text-phx-xs font-bold uppercase tracking-[0.1em] ${recTone.text}`}>
            {humanizeCode(detail.approvalRecommendation)}
          </span>
          {detail.approvalReason && <p className="mt-0.5 break-words text-xs text-slate-500">{detail.approvalReason}</p>}
        </div>
      </div>
      {detail.notes && <DetailNote label="Notes">{detail.notes}</DetailNote>}
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
      <DetailRow label="Status" value={requestStatusLabel(detail.currentStatus)} />
      <DetailRow label="Job title" value={detail.jobTitle} />
      <DetailRow label="Line" value={detail.lineName} />
      <DetailRow label="Area" value={detail.areaName} />
      {detail.proposedStartDate && <DetailRow label="Proposed start" value={detail.proposedStartDate} />}
      {detail.proposedEndDate && <DetailRow label="Proposed end" value={detail.proposedEndDate} />}
      {detail.workflowNotes && <DetailNote label="Notes">{detail.workflowNotes}</DetailNote>}
      {detail.decisionReason && (
        <DetailNote label="Decision reason" tone="reject">
          {detail.decisionReason}
        </DetailNote>
      )}
    </dl>
  );
}

// The day-by-day plan grid (WeeklyPlanCalendar + PlanActivityCard + helpers) now lives in
// ./weekly-plan-calendar.tsx so the Approvals Hub plan pages render the identical calendar from
// one source. Imported above.

function EmployeeContextPanel({ data, loading }: { data: ContextData | null; loading: boolean }) {
  if (loading) return <LandingEmpty>Loading context…</LandingEmpty>;
  if (!data) return <LandingEmpty>Context unavailable.</LandingEmpty>;

  const priorLeaveDecisions = (data.recentLeave ?? []).map((r) => r.hrDecision ?? r.managerDecision);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2.5">
          <LandingTitle as="h3">Attendance · last 30 days</LandingTitle>
        </div>
        {/* Six figures on one hairline grid: the figure carries the tone, the ground stays white. */}
        <div className="grid grid-cols-3 border-l border-t border-slate-200">
          {[
            { label: "Complete", value: data.attendance.completeDays, cls: "text-emerald-700" },
            { label: "Late", value: data.attendance.lateDays, cls: "text-amber-700" },
            { label: "Absent", value: data.attendance.absentDays, cls: "text-rose-700" },
            { label: "Short days", value: data.attendance.shortDays, cls: LANDING_INK },
            { label: "Deductions", value: data.attendance.deductionDays, cls: LANDING_INK },
            { label: "Total tracked", value: data.attendance.totalRows, cls: LANDING_INK },
          ].map(({ label, value, cls }) => (
            <div key={label} className="min-w-0 border-b border-r border-slate-200 px-2 py-2.5 text-center">
              <p className={`text-lg font-black tabular-nums ${cls}`}>{value}</p>
              <p className={`break-words ${HUB_LABEL}`}>{label}</p>
            </div>
          ))}
        </div>
      </div>

      {(data.recentLeave?.length ?? 0) > 0 && (
        <div>
          <div className="mb-2">
            <LandingTitle as="h3">
              Recent leave &nbsp;
              <span className="font-mono tracking-wider text-slate-400">
                {priorLeaveDecisions.map((d) => d === "approved" ? "✓" : d === "rejected" ? "✗" : "–").join(" ")}
              </span>
            </LandingTitle>
          </div>
          <div className="space-y-1">
            {data.recentLeave.map((r, i) => {
              const d = r.hrDecision ?? r.managerDecision;
              return (
                <div key={i} className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
                  <span className={d === "approved" ? "font-bold text-emerald-700" : d === "rejected" ? "font-bold text-rose-700" : "text-slate-400"}>
                    {d === "approved" ? "✓" : d === "rejected" ? "✗" : "–"}
                  </span>
                  <span className="min-w-0 break-words">{vacationTypeLabel(r.vacationType)} · {r.startDate} – {r.endDate}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(data.recentExcuses?.length ?? 0) > 0 && (
        <div>
          <div className="mb-2">
            <LandingTitle as="h3">Recent excuses</LandingTitle>
          </div>
          <div className="space-y-1">
            {data.recentExcuses.map((e, i) => (
              <div key={i} className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
                <span className={e.status === "approved" ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>
                  {e.status === "approved" ? "✓" : "✗"}
                </span>
                <span className="min-w-0 break-words">{humanizeCode(e.excuseType)} · {e.excuseDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A key, as the kit draws one: a square hairline frame in monospace. */
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="border border-slate-200 bg-white px-1 font-mono text-phx-xs font-bold text-slate-600">{children}</kbd>;
}

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={onClose}>
      <div
        className={`w-full max-w-72 ${HUB_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
          <LandingTitle>Keyboard shortcuts</LandingTitle>
          <button
            aria-label="Close"
            onClick={onClose}
            className={`text-xl leading-none text-slate-400 transition-colors hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
          >
            ×
          </button>
        </div>
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-20" />
            <col />
          </colgroup>
          <tbody>
            {[
              ["j / ↓", "Next item"],
              ["k / ↑", "Previous item"],
              ["a", "Approve (excuse / outstation)"],
              ["r", "Focus comment textarea"],
              ["Esc", "Clear selection"],
              ["?", "Toggle this panel"],
            ].map(([key, desc]) => (
              <tr key={key} className="border-b border-slate-200 last:border-0">
                <td className="py-2 pl-4 pr-2 align-top">
                  <Kbd>{key}</Kbd>
                </td>
                <td className="break-words py-2 pr-4 text-xs text-slate-600">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The one approvals interface's tone for a hub action (REC-032): the same act looks the same here as
 *  on the request page. */
function hubActionTone(key: string, variant: "approve" | "reject" | "neutral"): ApprovalTone {
  if (variant === "approve") return "approve";
  if (variant === "reject") return "reject";
  if (key === "acknowledge") return "acknowledge";
  if (key.startsWith("return")) return "return";
  return "neutral";
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
        // Nothing waiting: one calm line on a rail, never an empty square with a glowing icon.
        <section className={HUB_PANEL}>
          <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
            <LandingTitle>{notice ? "Request not found" : "All clear"}</LandingTitle>
          </header>
          <LandingRailLine rail={notice ? "bg-amber-500" : "bg-emerald-500"}>
            {notice ?? "No approvals or reviews waiting on you right now. You're on top of everything."}
          </LandingRailLine>
        </section>
      ) : (
        <div className={`flex min-h-[640px] flex-col overflow-hidden lg:h-[calc(100dvh-16rem)] lg:min-h-[560px] lg:flex-row ${HUB_PANEL}`}>
          {/* Left rail */}
          <div className="flex max-h-[45vh] w-full flex-col border-b border-slate-200 lg:max-h-none lg:w-[21rem] lg:shrink-0 lg:border-b-0 lg:border-r">
            {/* Super-admin view-as switcher */}
            {canViewAs && managers && managers.length > 0 && (
              <div className="border-b border-slate-200 px-4 py-2.5">
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
                      <option key={m.hrId} value={m.hrId}>{m.name}</option>
                    ))}
                  </SearchableSelect>
                )}
                {viewAsHrId && (
                  <p className={`mt-1.5 flex items-center gap-1.5 break-words text-phx-xs font-bold ${LANDING_INK}`} dir="auto">
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-[#08111f]" />
                    Viewing {managers.find(m => m.hrId === viewAsHrId)?.name ?? "this manager"}&apos;s queue
                  </p>
                )}
              </div>
            )}

            {/* Rail header */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <LandingTitle>Queue</LandingTitle>
                <span className={`text-phx-sm font-black tabular-nums ${LANDING_INK}`}>{stats.total}</span>
              </div>
              <div className="flex items-center gap-3 text-phx-xs">
                {stats.overdue > 0 && (
                  <span className="font-bold uppercase tracking-[0.1em] tabular-nums text-rose-700">
                    {stats.overdue} overdue
                  </span>
                )}
                <span className="uppercase tracking-[0.1em] text-slate-500">avg <span className={`font-bold tabular-nums ${LANDING_INK}`}>{stats.avgAge}d</span></span>
              </div>
            </div>

            {/* Module filter tabs — they WRAP, never a sideways scroller (the fits-the-screen rule). */}
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-slate-200 px-2.5 py-2.5">
              {modules.map((mod) => {
                const count = moduleCounts[mod] ?? 0;
                if (mod !== "all" && count === 0) return null;
                const active = activeModule === mod;
                return (
                  <button
                    key={mod}
                    aria-pressed={active}
                    onClick={() => {
                      setActiveModule(mod);
                      setActiveFilter("all");
                      setBulkSelected(new Set());
                      const firstInModule = allItems.find((item) => mod === "all" || item.module === mod);
                      if (firstInModule) selectItem(firstInModule);
                    }}
                    className={`flex min-h-8 items-center gap-1.5 border px-2.5 py-1 text-phx-xs font-bold uppercase tracking-[0.08em] transition-colors motion-reduce:transition-none ${LANDING_FOCUS} ${
                      active
                        ? "border-[#08111f] bg-[#08111f] text-white"
                        : "border-transparent text-slate-500 hover:border-slate-200 hover:text-[#08111f]"
                    }`}
                  >
                    {mod === "all" ? "All" : ACTION_HUB_MODULE_LABELS[mod as ActionHubModule]}
                    <span className={`tabular-nums ${active ? "text-white/60" : "text-slate-400"}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Quick filter chips */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2">
              {(["all", "overdue", "high"] as const).map((f) => {
                const chipCount = f === "all" ? filteredByModule.length : f === "overdue" ? overdueTotalCount : highPriorityCount;
                if (f !== "all" && chipCount === 0) return null;
                const on = activeFilter === f;
                return (
                  <button
                    key={f}
                    aria-pressed={on}
                    onClick={() => setActiveFilter(f)}
                    className={`min-h-8 border px-3 py-1 text-phx-xs font-bold tabular-nums transition-colors motion-reduce:transition-none ${LANDING_FOCUS} ${
                      on
                        ? f === "all"
                          ? "border-[#08111f] bg-[#08111f] text-white"
                          : "border-rose-600 bg-white text-rose-700"
                        : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-[#08111f]"
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
                <LandingEmpty>No items match this filter.</LandingEmpty>
              ) : (
                <ul className="divide-y divide-slate-200">
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
                          className={`cursor-pointer border-l-[3px] py-3 pl-[13px] pr-4 text-left transition-colors motion-reduce:transition-none ${ROW_FOCUS} ${
                            isSelected
                              ? "border-[#08111f] bg-slate-50"
                              : "border-transparent hover:bg-slate-50"
                          }`}
                        >
                          <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <ModuleBadge module={item.module} />
                            <UrgencyBadge urgency={item.urgency} />
                            <SlaBadge item={item} />
                            {canBulk && (
                              <span
                                role="checkbox"
                                aria-checked={bulkSelected.has(item.id)}
                                aria-label={`Select ${item.employeeName}`}
                                tabIndex={0}
                                className={`ml-auto flex h-5 w-5 shrink-0 items-center justify-center border text-phx-xs font-bold transition-colors motion-reduce:transition-none ${LANDING_FOCUS} ${
                                  bulkSelected.has(item.id)
                                    ? "border-[#08111f] bg-[#08111f] text-white"
                                    : "border-slate-300 bg-white text-transparent hover:border-[#08111f]"
                                }`}
                                onClick={(e) => toggleBulk(item, e)}
                                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") toggleBulk(item, e); }}
                              >
                                ✓
                              </span>
                            )}
                          </div>
                          <div className="flex min-w-0 items-start justify-between gap-2">
                            <p className={`min-w-0 break-words text-sm font-bold leading-snug ${LANDING_INK}`} dir="auto">
                              {item.employeeName}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); snoozeAndUpdate(item.id); }}
                              title="Snooze for 24h"
                              className={`shrink-0 p-0.5 text-slate-300 opacity-0 transition-opacity hover:text-slate-500 focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none ${LANDING_FOCUS}`}
                              aria-label="Snooze 24h"
                            >
                              ⏱
                            </button>
                          </div>
                          <p className="break-words text-xs text-slate-600" dir="auto">{item.title}</p>
                          <p className="mt-0.5 break-words text-phx-xs text-slate-500">
                            {item.statusLabel}
                          </p>
                          <SlaRail item={item} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {viewAsItems !== null && viewAsItems.length < viewAsTotal && (
                <div className="border-t border-slate-200 px-4 py-3">
                  <button
                    onClick={loadMoreViewAs}
                    disabled={viewAsLoading}
                    className={landingActionClassName("outline", "w-full")}
                  >
                    {viewAsLoading ? "Loading…" : `Load more (${viewAsTotal - viewAsItems.length} remaining)`}
                  </button>
                </div>
              )}
            </div>

            {/* Bulk approve footer — a flat white sheet on a hairline, never a floating card. */}
            {bulkSelected.size > 0 && (
              <div className="shrink-0 border-t border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-bold tabular-nums ${LANDING_INK}`}>{bulkSelected.size} selected</span>
                  <button
                    disabled={bulkBusy}
                    onClick={() => void handleBulkApprove()}
                    className={approvalActionClassName("approve", "dense")}
                  >
                    {bulkBusy ? "Approving…" : "Approve all"}
                  </button>
                  <button
                    onClick={() => setBulkSelected(new Set())}
                    className={`text-xs font-bold text-slate-500 transition-colors hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Shortcuts hint */}
            <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-1.5">
              <button
                onClick={() => setShowShortcuts(true)}
                className={`text-phx-xs text-slate-500 transition-colors hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
              >
                ? Keyboard shortcuts
              </button>
            </div>
          </div>

          {/* Right detail panel */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-white">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
                <p className="text-sm font-bold text-slate-500">{notice ?? "Select an item to review it"}</p>
                <p className="text-xs text-slate-500">press <Kbd>j</Kbd> / <Kbd>k</Kbd> to navigate · <Kbd>?</Kbd> for shortcuts</p>
              </div>
            ) : (
              <div>
                {/* Detail header — the kit's white header: who, what, how long it has waited. */}
                <div className="border-b border-slate-200 px-5 py-4 sm:px-7">
                  <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <ModuleBadge module={selected.module} />
                    <UrgencyBadge urgency={selected.urgency} />
                    <SlaBadge item={selected} />
                  </div>
                  <h2 className={`break-words text-lg font-black ${LANDING_INK}`} dir="auto">{selected.employeeName}</h2>
                  <p className="break-words text-sm text-slate-600" dir="auto">{selected.title}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>Status: <span className={`font-semibold ${LANDING_INK}`}>{selected.statusLabel}</span></span>
                    <span>Submitted {new Date(selected.submittedAt).toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric" })}</span>
                    {priorLeaveHint && priorLeaveHint.length > 0 && (
                      <span>
                        Prior:{" "}
                        {priorLeaveHint.map((d, i) => (
                          <span key={i} className={d === "approved" ? "font-bold text-emerald-700" : d === "rejected" ? "font-bold text-rose-700" : "text-slate-400"}>
                            {d === "approved" ? "✓" : d === "rejected" ? "✗" : "–"}{" "}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <SlaRail item={selected} />
                </div>

                <div className="p-5 sm:p-7">
                  {/* Details | Context tabs */}
                  <div className="mb-5 flex flex-wrap gap-4 border-b border-slate-200">
                    {(["details", "context"] as const).map((tab) => (
                      <button
                        key={tab}
                        aria-pressed={detailTab === tab}
                        onClick={() => setDetailTab(tab)}
                        className={`-mb-px border-b-2 px-1 pb-2 text-phx-xs font-bold uppercase tracking-[0.1em] transition-colors motion-reduce:transition-none ${LANDING_FOCUS} ${
                          detailTab === tab
                            ? "border-[#08111f] text-[#08111f]"
                            : "border-transparent text-slate-500 hover:text-[#08111f]"
                        }`}
                      >
                        {tab === "details" ? "Details" : "Employee Context"}
                      </button>
                    ))}
                  </div>

                  {detailTab === "context" ? (
                    <div className="mb-6 border border-slate-200 p-4">
                      <EmployeeContextPanel data={contextData} loading={contextLoading} />
                    </div>
                  ) : (
                    <>
                      {/* Module-specific detail */}
                      <div className="mb-6 border border-slate-200 p-4">
                        {selected.detail.module === "leave" && <LeaveDetailView detail={selected.detail} />}
                        {selected.detail.module === "resignation" && <ResignationDetailView detail={selected.detail} />}
                        {selected.detail.module === "excuse" && <ExcuseDetailView detail={selected.detail} />}
                        {selected.detail.module === "outstation" && <OutstationDetailView detail={selected.detail} />}
                        {selected.detail.module === "marketing" && <MarketingDetailView detail={selected.detail} />}
                        {selected.detail.module === "contract_renewal" && <ContractRenewalDetailView detail={selected.detail} />}
                        {selected.detail.module === "weekly_plan" && <WeeklyPlanCalendar detail={selected.detail} />}
                      </div>

                      {/* Action zone */}
                      <div className="border border-slate-200">
                        <div className="border-b border-slate-200 px-4 py-2.5">
                          <LandingTitle as="h3">Decision</LandingTitle>
                        </div>
                        {notice ? (
                          <LandingRailLine rail="bg-emerald-500">
                            <span className={`font-bold ${LANDING_INK}`}>{notice}</span>
                          </LandingRailLine>
                        ) : selected.readOnlyReason ? (
                          <LandingRailLine rail="bg-amber-500">
                            <span className={`font-bold ${LANDING_INK}`}>{selected.readOnlyReason}</span>
                          </LandingRailLine>
                        ) : (
                          <div className="space-y-3 p-4">
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
                              <p className="break-words border-l-4 border-rose-500 py-1.5 pl-3 text-sm font-bold text-rose-700" role="alert">
                                {error}
                              </p>
                            )}

                            {/* Action buttons */}
                            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:justify-end">
                              {selected.module === "leave" && selected.detail.module === "leave" && (() => {
                                const actions = resolveLeaveActions(selected.detail);
                                return actions.length > 0
                                  ? actions.map((action) => (
                                    <button
                                      key={action.key}
                                      disabled={busy}
                                      onClick={() => handleLeaveAction(action.key)}
                                      className={approvalActionClassName(hubActionTone(action.key, action.variant))}
                                    >
                                      {busy ? "…" : action.label}
                                    </button>
                                  ))
                                  : <p className="text-sm text-slate-500">No actions available for you on this request.</p>;
                              })()}

                              {selected.module === "resignation" && selected.detail.module === "resignation" && (() => {
                                const actions = resolveResignationActions(selected.detail.status);
                                return actions.length > 0
                                  ? actions.map((action) => (
                                    <button
                                      key={action.key}
                                      disabled={busy}
                                      onClick={() => handleResignationAction(action.key)}
                                      className={approvalActionClassName(hubActionTone(action.key, action.variant))}
                                    >
                                      {busy ? "…" : action.label}
                                    </button>
                                  ))
                                  : <p className="text-sm text-slate-500">No workflow actions available.</p>;
                              })()}

                              {selected.module === "excuse" && (
                                <>
                                  <button disabled={busy} onClick={() => handleExcuseAction("approve")}
                                    className={approvalActionClassName("approve")}>
                                    {busy ? "…" : "Approve"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleExcuseAction("return")}
                                    className={approvalActionClassName("return")}>
                                    {busy ? "…" : "Return with reply"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleExcuseAction("reject")}
                                    className={approvalActionClassName("reject")}>
                                    {busy ? "…" : "Reject"}
                                  </button>
                                </>
                              )}

                              {selected.module === "outstation" && (
                                <>
                                  <button disabled={busy} onClick={() => handleOutstationAction("approve")}
                                    className={approvalActionClassName("approve")}>
                                    {busy ? "…" : "Approve for Payroll"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleOutstationAction("reject")}
                                    className={approvalActionClassName("reject")}>
                                    {busy ? "…" : "Reject"}
                                  </button>
                                </>
                              )}

                              {selected.module === "marketing" && selected.detail.module === "marketing" && (() => {
                                const labels = selected.detail.decisionLabels;
                                return (
                                  <>
                                    <button disabled={busy} onClick={() => handleMarketingAction("approve")}
                                      className={approvalActionClassName("approve")}>
                                      {busy ? "…" : (labels?.approve ?? "Approve")}
                                    </button>
                                    {labels?.return && (
                                      <button disabled={busy} onClick={() => handleMarketingAction("return")}
                                        className={approvalActionClassName("return")}>
                                        {busy ? "…" : labels.return}
                                      </button>
                                    )}
                                    <button disabled={busy} onClick={() => handleMarketingAction("reject")}
                                      className={approvalActionClassName("reject")}>
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
                                        className={approvalActionClassName("neutral")}>
                                        {busy ? "…" : "Mark Under Review"}
                                      </button>
                                    )}
                                    {status === "manager_review" && (
                                      <button disabled={busy} onClick={() => handleContractRenewalAction("hr_review")}
                                        className={approvalActionClassName("neutral")}>
                                        {busy ? "…" : "Send to HR Review"}
                                      </button>
                                    )}
                                    <button disabled={busy} onClick={() => handleContractRenewalAction("renew")}
                                      className={approvalActionClassName("approve")}>
                                      {busy ? "…" : "Renew Contract"}
                                    </button>
                                    <button disabled={busy} onClick={() => handleContractRenewalAction("not_renew")}
                                      className={approvalActionClassName("reject")}>
                                      {busy ? "…" : "Do Not Renew"}
                                    </button>
                                  </>
                                );
                              })()}

                              {selected.module === "weekly_plan" && selected.detail.module === "weekly_plan" && (
                                <>
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("approve")}
                                    className={approvalActionClassName("approve")}>
                                    {busy ? "…" : selected.detail.stage === "manager" ? "Approve → CEO" : "Approve (final)"}
                                  </button>
                                  {selected.detail.stage === "manager" && selected.detail.items.some((i) => i.activityType === "Field") && (
                                    <button disabled={busy} onClick={() => handleRequestVisitDetails()}
                                      className={approvalActionClassName("neutral")}>
                                      {busy ? "…" : "Request Visit Details"}
                                    </button>
                                  )}
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("return")}
                                    className={approvalActionClassName("return")}>
                                    {busy ? "…" : "Return for edit"}
                                  </button>
                                  <button disabled={busy} onClick={() => handleWeeklyPlanAction("reject")}
                                    className={approvalActionClassName("reject")}>
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
            className={`w-full max-w-md ${HUB_PANEL}`}
            ref={marketingDialogRef}
            role="dialog"
          >
            <div className="px-5 py-4">
              <h2 className={`break-words text-base font-bold ${LANDING_INK}`} id="action-center-marketing-confirm-title">
                {marketingPrompt.title}
              </h2>
              <p className="mt-2 break-words text-sm text-slate-700">{marketingPrompt.body}</p>
              <p className={`mt-2 break-words text-sm font-medium ${LANDING_INK}`}>{marketingPrompt.consequence}</p>
            </div>
            {/* The are-you-sure pair wears the one approvals interface: the confirm tone whatever the act. */}
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-3 sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                className={approvalActionClassName("neutral")}
                onClick={() => setMarketingConfirm(null)}
                type="button"
              >
                {marketingPrompt.cancelLabel}
              </button>
              <button
                className={approvalActionClassName("confirm")}
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
