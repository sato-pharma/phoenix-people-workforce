"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  Printer,
  Search,
  Send,
  WifiOff,
} from "lucide-react";

import { ChoiceGroup } from "@/components/ui/choice-group";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import type {
  EmployeeExcuseRequest,
  EmployeeExcuseStatus,
  EmployeeExcuseWorkspaceData,
} from "@/lib/excuses/service";
import {
  phxButtonAccentClassName,
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingEmpty,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  LandingRow,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Types ────────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

type EmployeeExcusesWorkspaceProps = {
  initialData: EmployeeExcuseWorkspaceData;
};

type ExcuseTab = "request" | "history";

type QueuedExcuseSubmission = {
  excuseDate: string;
  excuseType: "morning" | "afternoon";
  id: string;
  timestamp: number;
};

type DateWarning = {
  kind: "error" | "warning";
  text: string;
};

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

// The landing kit's status rule: a status is a coloured word (and, on a card, a 4px rail), never a
// filled pill. The same four colours as the plans: approved green, rejected rose, returned amber,
// awaiting the manager sky.
function statusInk(status: EmployeeExcuseStatus): string {
  if (status === "approved") return "text-emerald-700";
  if (status === "rejected") return "text-rose-700";
  if (status === "returned_to_employee") return "text-amber-700";
  return "text-sky-700";
}

function statusRail(status: EmployeeExcuseStatus): string {
  if (status === "approved") return "bg-emerald-500";
  if (status === "rejected") return "bg-rose-500";
  if (status === "returned_to_employee") return "bg-amber-500";
  return "bg-sky-500";
}

/** The status word's shape — small tracked capitals that wrap inside a narrow column. */
const statusWordClassName = "break-words text-phx-xs font-bold uppercase tracking-[0.08em]";

function statusLabel(status: EmployeeExcuseStatus): string {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "returned_to_employee") return "Returned to employee";
  return "Pending";
}

function typeLabel(type: "morning" | "afternoon") {
  return type === "morning" ? "Morning excuse" : "Afternoon excuse";
}

// Africa/Cairo, not the clock. Inside a client component `toISOString()` is still UTC, so this
// used to pre-fill YESTERDAY for the first 2-3 hours of a Cairo day — on a correctly-set Cairo
// machine, not just a traveller's. validateExcuseDate then compared it against the browser's own
// today and rejected it as a past date, so the form opened with Submit already disabled.
function todayDate() {
  return currentCairoDateOnlyIso();
}

// DATE-ONLY (`excuse_date`, a `date` column — formatDateTime below is the true INSTANT and correctly
// uses Cairo), which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what
// stops the calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to
// Cairo.
function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(value));
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Date Validation (#3) ─────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function validateExcuseDate(dateString: string): DateWarning | null {
  if (!dateString) return { kind: "error", text: "Please select a date." };

  const parts = dateString.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);

  // Past date check. Compared against Cairo's calendar day, not the viewer's browser clock —
  // both sides of this comparison must resolve "today" the same way as the field's default
  // (todayDate above), or the form contradicts itself and blocks a valid same-day excuse.
  // YYYY-MM-DD strings compare correctly lexicographically, so no Date round-trip is needed.
  if (dateString < currentCairoDateOnlyIso()) {
    return { kind: "error", text: "Cannot submit excuses for past dates." };
  }

  // Weekend check (Friday = 5, Saturday = 6 for Egypt work week)
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    return { kind: "warning", text: "This date falls on a weekend (Fri/Sat)." };
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Offline Queue Hook (#2) + SSR Hydration Guard ────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function useOfflineQueue(onReplay: (payload: QueuedExcuseSubmission) => Promise<void>) {
  const [queue, setQueue] = useState<QueuedExcuseSubmission[]>([]);
  // SSR hydration guard: always start `true` to match server output,
  // then sync the real browser value inside useEffect.
  const [isOnline, setIsOnline] = useState(true);
  const replayingRef = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline(navigator.onLine);

    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Replay queue when back online
  useEffect(() => {
    if (!isOnline || queue.length === 0 || replayingRef.current) return;
    replayingRef.current = true;

    (async () => {
      const pending = [...queue];
      for (const item of pending) {
        try {
          await onReplay(item);
          setQueue((current) => current.filter((q) => q.id !== item.id));
        } catch {
          break;
        }
      }
      replayingRef.current = false;
    })();
  }, [isOnline, queue, onReplay]);

  function enqueue(excuseDate: string, excuseType: "morning" | "afternoon") {
    const submission: QueuedExcuseSubmission = {
      excuseDate,
      excuseType,
      id: `q-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: Date.now(),
    };
    setQueue((current) => [...current, submission]);
  }

  return { enqueue, isOnline, queueLength: queue.length };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Style Tokens ─────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const inputClass  = phxFieldClassName;

const labelClass = phxLabelTextClassName;

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Metric Card ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MetricCard({
  description,
  label,
  tone,
  value,
}: {
  description: string;
  label: string;
  /** The figure's colour on navy — white when absent; rose once the allowance is used up. */
  tone?: string;
  value: number | string;
}) {
  return (
    // A tile on the navy board: one step lighter than the board, the figure white and tabular.
    <div className={`min-w-0 px-3 py-2.5 ${LANDING_NAVY_TILE}`}>
      <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-white/60">{label}</p>
      <div className="mt-1.5">
        <LandingFigure onNavy tone={tone}>
          {value}
        </LandingFigure>
      </div>
      <p className="mt-1.5 break-words text-phx-xs font-medium leading-4 text-white/45">{description}</p>
    </div>
  );
}

/** A condition line — offline, sent, an error — with its tone on a 4px rail, never a tinted box. */
function ExcuseNotice({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: ReactNode;
  tone: "amber" | "emerald" | "rose";
}) {
  const rail = tone === "amber" ? "bg-amber-500" : tone === "emerald" ? "bg-emerald-500" : "bg-rose-600";
  return (
    <div className={`flex min-w-0 items-start gap-3 border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName}`}>
      <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${rail}`} />
      {icon}
      <div className="min-w-0 flex-1 break-words text-phx-sm font-bold leading-snug text-slate-700">{children}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Usage Distribution Bar ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function UsageDistributionBar({
  allowance,
  approved,
  pending,
  remaining,
}: {
  allowance: number;
  approved: number;
  pending: number;
  remaining: number;
}) {
  if (allowance === 0) return null;

  const approvedPct = (approved / allowance) * 100;
  const pendingPct = (pending / allowance) * 100;
  const remainingPct = (remaining / allowance) * 100;

  return (
    <LandingPanel
      bodyClassName="px-3 py-3 sm:px-4"
      right={<LandingMeta items={[`${allowance} ${allowance === 1 ? "excuse" : "excuses"} allowed this month`]} />}
      title="Monthly usage"
    >
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        {approvedPct > 0 ? (
          <div
            className="h-full bg-emerald-500 transition-all duration-500 motion-reduce:transition-none"
            style={{ width: `${approvedPct}%` }}
            title={`Approved: ${approved}`}
          />
        ) : null}
        {pendingPct > 0 ? (
          <div
            className="h-full bg-sky-500 transition-all duration-500 motion-reduce:transition-none"
            style={{ width: `${pendingPct}%` }}
            title={`Pending: ${pending}`}
          />
        ) : null}
        {remainingPct > 0 ? (
          <div
            className="h-full bg-slate-200 transition-all duration-500 motion-reduce:transition-none"
            style={{ width: `${remainingPct}%` }}
            title={`Remaining: ${remaining}`}
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
          <span className="text-emerald-700">Approved {approved}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-sky-500" />
          <span className="text-sky-700">Pending {pending}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-slate-300" />
          <span className="text-slate-600">Remaining {remaining}</span>
        </span>
      </div>
    </LandingPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Monthly Trend Sparkline (#5) ─────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MonthlyTrendSparkline({ requests }: { requests: EmployeeExcuseRequest[] }) {
  // Build a 6-month buckets from current month back
  const buckets = useMemo(() => {
    const now = new Date();
    const months: { count: number; key: string; label: string }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short" });
      months.push({ count: 0, key, label });
    }
    for (const r of requests) {
      const rKey = r.excuseDate?.slice(0, 7);
      const bucket = months.find((m) => m.key === rKey);
      if (bucket) bucket.count++;
    }
    return months;
  }, [requests]);

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const barMaxHeight = 48;

  if (requests.length === 0) return null;

  return (
    <LandingPanel bodyClassName="px-3 py-3 sm:px-4" title="Monthly trend">
      <div className="flex items-end justify-between gap-1">
        {buckets.map((b) => {
          const h = Math.max(4, (b.count / maxCount) * barMaxHeight);
          return (
            <div key={b.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className={`text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>{b.count}</span>
              <div
                className="w-full bg-[#08111f] transition-all duration-500 motion-reduce:transition-none"
                style={{ height: `${h}px` }}
                title={`${b.label}: ${b.count} excuses`}
              />
              <span className="text-phx-xs font-bold uppercase tracking-[0.06em] text-slate-500">{b.label}</span>
            </div>
          );
        })}
      </div>
    </LandingPanel>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── History Request Card (Mobile) ───────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function ExcuseHistoryCard({
  onEditReturned,
  request,
}: {
  onEditReturned: (request: EmployeeExcuseRequest) => void;
  request: EmployeeExcuseRequest;
}) {
  return (
    <div className="flex min-w-0 gap-3 px-3 py-3">
      <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${statusRail(request.status)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <div className="min-w-0 flex-1">
            <p className={`break-words text-phx-md font-bold ${LANDING_INK}`}>{typeLabel(request.excuseType)}</p>
            <p className="mt-0.5 text-phx-xs font-medium tabular-nums text-slate-500">
              {formatDate(request.excuseDate)} · {request.durationHours}h
            </p>
            <p className="mt-0.5 break-words font-mono text-phx-sm font-bold text-slate-400">{request.requestCode}</p>
          </div>
          <span className={`${statusWordClassName} ${statusInk(request.status)}`}>
            {statusLabel(request.status)}
          </span>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Manager</p>
            <p className="mt-0.5 break-words text-phx-sm font-semibold text-slate-700">{request.managerName ?? "Not assigned"}</p>
          </div>
          <div className="min-w-0">
            <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Submitted</p>
            <p className="mt-0.5 break-words text-phx-sm font-semibold tabular-nums text-slate-700">{formatDateTime(request.createdAt)}</p>
          </div>
        </div>

        {request.managerDecisionAt ? (
          <div className="mt-2 border-t border-slate-200 pt-2">
            <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">Decision</p>
            <p className="mt-0.5 text-phx-xs font-semibold tabular-nums text-slate-600">{formatDateTime(request.managerDecisionAt)}</p>
            {request.managerDecisionComment ? (
              <p className="mt-0.5 break-words text-phx-xs font-medium leading-4 text-slate-500" dir="auto">{request.managerDecisionComment}</p>
            ) : null}
          </div>
        ) : null}
        {request.status === "returned_to_employee" ? (
          <button
            className={landingActionClassName("outline", "mt-3")}
            onClick={() => onEditReturned(request)}
            type="button"
          >
            Edit and resubmit
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Exported Component (Error Boundary Wrapper) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function EmployeeExcusesWorkspace(props: EmployeeExcusesWorkspaceProps) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Excuses workspace failed to load">
      <EmployeeExcusesWorkspaceInner {...props} />
    </WorkspaceErrorBoundary>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Main Workspace ──────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function EmployeeExcusesWorkspaceInner({ initialData }: EmployeeExcusesWorkspaceProps) {
  const [workspace, setWorkspace] = useState(initialData);
  const [activeTab, setActiveTab] = useState<ExcuseTab>("request");
  const [excuseDate, setExcuseDate] = useState(todayDate());
  const [excuseType, setExcuseType] = useState<"morning" | "afternoon">("morning");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [resubmitRequestId, setResubmitRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  /* ── History search filter (#4) ─────────────────── */
  const [historySearch, setHistorySearch] = useState("");

  /* ── Focus trap ref for history panel ────────────── */
  const historyPanelRef = useRef<HTMLDivElement>(null);

  const currentMonthLabel = useMemo(() => {
    const [year, month] = workspace.monthly.yearMonth.split("-");
    return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }, [workspace.monthly.yearMonth]);

  /* ── Date validation (#3) ────────────────────────── */
  const dateWarning = useMemo(() => validateExcuseDate(excuseDate), [excuseDate]);
  const hasDateError = dateWarning?.kind === "error";

  /* ── Offline queue (#2) ──────────────────────────── */
  const replayExcuseRequest = useCallback(async (item: QueuedExcuseSubmission) => {
    const response = await fetch("/api/excuses", {
      body: JSON.stringify({ excuseDate: item.excuseDate, excuseType: item.excuseType }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error("Replay failed");
    const payload = await response.json().catch(() => null) as {
      workspace?: EmployeeExcuseWorkspaceData;
    } | null;
    if (payload?.workspace) setWorkspace(payload.workspace);
  }, []);

  const { enqueue, isOnline, queueLength } = useOfflineQueue(replayExcuseRequest);

  const submitDisabled = submitting || submitSuccess || (!resubmitRequestId && workspace.monthly.remaining <= 0) || hasDateError;

  /* ── Stats by status ─────────────────────────────── */
  const statusCounts = useMemo(() => {
    const counts = { approved: 0, pending: 0, rejected: 0, returned: 0 };
    for (const r of workspace.requests) {
      if (r.status === "approved") counts.approved++;
      else if (r.status === "rejected") counts.rejected++;
      else if (r.status === "returned_to_employee") counts.returned++;
      else counts.pending++;
    }
    return counts;
  }, [workspace.requests]);

  /* ── Filtered history (#4) ───────────────────────── */
  const filteredRequests = useMemo(() => {
    if (!historySearch.trim()) return workspace.requests;
    const q = historySearch.toLowerCase().trim();
    return workspace.requests.filter((r) => {
      const searchable = [
        r.requestCode,
        r.excuseDate,
        typeLabel(r.excuseType),
        statusLabel(r.status),
        r.managerName,
        formatDate(r.excuseDate),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(q);
    });
  }, [workspace.requests, historySearch]);

  const historyTotal = workspace.requests.length;

  /* ── Focus trap on history tab ──────────────────── */
  useEffect(() => {
    if (activeTab !== "history") return;
    const container = historyPanelRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = container!.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeTab]);

  /* ── Submit handler with optimistic animation (#1) ── */
  const handleSubmit = useCallback(() => {
    setMessage(null);

    if (resubmitRequestId && !isOnline) {
      setMessage({ kind: "error", text: "Reconnect before resubmitting a returned request." });
      return;
    }

    // Offline: enqueue instead of fetching (#2)
    if (!isOnline) {
      enqueue(excuseDate, excuseType);
      setMessage({ kind: "success", text: "Request queued. It will be sent when you reconnect." });
      return;
    }

    setSubmitting(true);
    (async () => {
      try {
        const response = await fetch(resubmitRequestId ? `/api/excuses/${resubmitRequestId}/resubmit` : "/api/excuses", {
          body: JSON.stringify({ excuseDate, excuseType }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const payload = await response.json().catch(() => null) as {
          message?: string;
          success?: boolean;
          workspace?: EmployeeExcuseWorkspaceData;
        } | null;

        if (!response.ok || !payload?.success || !payload.workspace) {
          throw new Error(payload?.message || "Unable to submit excuse request.");
        }

        setWorkspace(payload.workspace);
        setResubmitRequestId(null);

        // Optimistic success animation (#1)
        setSubmitSuccess(true);
        setTimeout(() => {
          setSubmitSuccess(false);
          setActiveTab("history");
          setMessage({ kind: "success", text: resubmitRequestId ? "Excuse request resubmitted to your direct manager." : "Excuse request sent to your direct manager." });
        }, 1200);
      } catch (error) {
        setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Unable to submit excuse request.",
        });
      } finally {
        setSubmitting(false);
      }
    })();
  }, [excuseDate, excuseType, isOnline, enqueue, resubmitRequestId]);

  const editReturnedRequest = useCallback((request: EmployeeExcuseRequest) => {
    setResubmitRequestId(request.id);
    setExcuseDate(request.excuseDate);
    setExcuseType(request.excuseType);
    setMessage({
      kind: "success",
      text: "Returned request loaded. Edit the date/type if needed, then resubmit.",
    });
    setActiveTab("request");
  }, []);

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Tab Items ─────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  const tabItems: { count: number; label: string; value: ExcuseTab }[] = [
    { count: 0, label: "New Excuse", value: "request" },
    { count: workspace.requests.length, label: "History", value: "history" },
  ];

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Render ───────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  return (
    <div className="excuse-workspace-premium space-y-3" dir="auto">
      {/* Print-friendly stylesheet (#6) */}
      <style>{`
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .excuse-workspace-premium { padding: 0; }
          .excuse-workspace-premium [role="tablist"],
          .excuse-workspace-premium .print\\:hidden { display: none !important; }
          .excuse-workspace-premium table { font-size: 10px; }
          .excuse-workspace-premium td, .excuse-workspace-premium th { padding: 4px 6px; }
          nav, header, footer, aside { display: none !important; }
        }
      `}</style>

      {/* ── Offline banner (#2) ───────────────────────────────── */}
      {!isOnline ? (
        <ExcuseNotice icon={<WifiOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />} tone="amber">
          You are offline. Requests will be queued and sent automatically when you reconnect.
          {queueLength > 0 ? ` (${queueLength} queued)` : ""}
        </ExcuseNotice>
      ) : null}

      {/* ── Optimistic success animation (#1) ─────────────────── */}
      {submitSuccess ? (
        <div className="animate-in fade-in duration-300 motion-reduce:animate-none">
          <ExcuseNotice icon={<CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />} tone="emerald">
            Excuse request submitted successfully. Switching to history...
          </ExcuseNotice>
        </div>
      ) : null}

      {/* ── Metric Cards — the page's one navy board ────────────── */}
      <LandingNavyBoard label="Key figures" right={<LandingMeta items={[currentMonthLabel]} onNavy />}>
        <div className="grid grid-cols-2 gap-px xs:grid-cols-4">
          <MetricCard
            description={`Allowance for ${currentMonthLabel}`}
            label="Monthly limit"
            value={workspace.monthly.allowance}
          />
          <MetricCard
            description="Approved excuses this month"
            label="Used"
            value={workspace.monthly.used}
          />
          <MetricCard
            description="Awaiting manager decision"
            label="Pending"
            value={workspace.monthly.pending}
          />
          <MetricCard
            description="Available excuses left"
            label="Remaining"
            tone={workspace.monthly.remaining <= 0 ? "text-rose-300" : undefined}
            value={workspace.monthly.remaining}
          />
        </div>
      </LandingNavyBoard>

      {/* ── Usage Distribution Bar ────────────────────────────── */}
      <UsageDistributionBar
        allowance={workspace.monthly.allowance}
        approved={workspace.monthly.approved}
        pending={workspace.monthly.pending}
        remaining={workspace.monthly.remaining}
      />

      {/* ── Tab Bar ────────────────────────────────────────────── */}
      <div
        className={`flex w-full flex-wrap border border-slate-200 bg-white ${adminSoftDepthClassName}`}
        role="tablist"
        aria-label="Excuse workspace tabs"
      >
        {tabItems.map((tab) => {
          const active = activeTab === tab.value;
          return (
            <button
              aria-selected={active}
              className={`flex min-h-10 items-center gap-2 border-b-2 px-3 text-phx-md font-bold transition-colors motion-reduce:transition-none ${LANDING_FOCUS} ${
                active ? "border-[#08111f] text-[#08111f]" : "border-transparent text-slate-500 hover:text-[#08111f]"
              }`}
              key={tab.value}
              role="tab"
              type="button"
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
              {tab.count > 0 ? (
                <span className={`inline-flex h-5 min-w-5 items-center justify-center px-1 text-phx-sm font-bold tabular-nums ${
                  active ? "bg-[#08111f] text-white" : "bg-slate-100 text-slate-600"
                }`}>
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ── Main Content Grid ─────────────────────────────────── */}
      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        {/* ── Left Panel ────────────────────────────────────────── */}
        <div>
          {/* ═════ Request Tab ═════ */}
          {activeTab === "request" ? (
            <LandingPanel right={<LandingMeta items={["Simple workflow"]} />} title="Request a 2-hour excuse">
              <div className="space-y-4 p-3 sm:p-4">
                <div className="grid gap-3 xs:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className={labelClass}>Date</span>
                    <input
                      className={inputClass}
                      onChange={(event) => setExcuseDate(event.target.value)}
                      type="date"
                      value={excuseDate}
                    />
                    {/* Date validation warning (#3) */}
                    {dateWarning ? (
                      <p className={`mt-1 text-phx-xs font-bold ${dateWarning.kind === "error" ? "text-rose-600" : "text-amber-600"}`}>
                        {dateWarning.text}
                      </p>
                    ) : null}
                  </label>
                  <div className="space-y-1.5">
                    <span className={labelClass}>Excuse type</span>
                    <ChoiceGroup
                      aria-label="Excuse type"
                      className="grid-cols-2"
                      onChange={(value) => setExcuseType(value)}
                      options={[
                        { label: "Morning excuse", value: "morning" },
                        { label: "Afternoon excuse", value: "afternoon" },
                      ]}
                      value={excuseType}
                    />
                  </div>
                </div>

                {/* Message */}
                {message ? (
                  <ExcuseNotice
                    icon={message.kind === "success"
                      ? <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      : <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />}
                    tone={message.kind === "success" ? "emerald" : "rose"}
                  >
                    {message.text}
                  </ExcuseNotice>
                ) : null}

                {/* Submit button with optimistic states (#1) */}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    className={cn(
                      phxButtonAccentClassName,
                      LANDING_FOCUS,
                      "motion-reduce:transition-none",
                      // Sent turns the same button green — the one state the accent token does not
                      // carry, and the one thing a rep looks for after pressing it.
                      submitSuccess && "border-emerald-600 bg-emerald-600 hover:bg-emerald-700",
                    )}
                    disabled={submitDisabled}
                    onClick={handleSubmit}
                    type="button"
                  >
                    {submitSuccess ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Submitted
                      </>
                    ) : submitting ? (
                      "Sending..."
                    ) : !isOnline ? (
                      <>
                        <WifiOff className="h-3.5 w-3.5" />
                        Queue Request
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        {resubmitRequestId ? "Resubmit request" : "Submit request"}
                      </>
                    )}
                  </button>

                  {workspace.monthly.remaining <= 0 && !resubmitRequestId ? (
                    <p className="text-phx-xs font-bold text-rose-600">
                      Monthly limit reached for {currentMonthLabel}.
                    </p>
                  ) : null}
                  {resubmitRequestId ? (
                    <button
                      className={`text-phx-xs font-bold text-slate-500 underline-offset-2 transition-colors hover:text-[#08111f] hover:underline motion-reduce:transition-none ${LANDING_FOCUS}`}
                      onClick={() => {
                        setResubmitRequestId(null);
                        setMessage(null);
                      }}
                      type="button"
                    >
                      Cancel resubmit
                    </button>
                  ) : null}
                </div>
              </div>
            </LandingPanel>
          ) : null}

          {/* ═════ History Tab ═════ */}
          {activeTab === "history" ? (
            <div ref={historyPanelRef}>
            <LandingPanel
              right={
                <>
                  <LandingMeta
                    items={[
                      "Request history",
                      filteredRequests.length === historyTotal
                        ? `${historyTotal} requests`
                        : `${filteredRequests.length} of ${historyTotal}`,
                    ]}
                  />
                  <button
                    className={landingActionClassName("outline", "print:hidden")}
                    onClick={() => window.print()}
                    title="Print history"
                    type="button"
                  >
                    <Printer aria-hidden="true" className="h-3 w-3" /> Print
                  </button>
                </>
              }
              title="Excuse requests"
            >

              {/* Search filter (#4) */}
              {historyTotal > 0 ? (
                <div className="border-b border-slate-200 px-3 py-2.5 sm:px-4 print:hidden">
                  <div className="relative">
                    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      aria-label="Search excuse requests"
                      className={cn(inputClass, "pl-9")}
                      placeholder="Search by date, type, status, manager..."
                      value={historySearch}
                      onChange={(event) => setHistorySearch(event.target.value)}
                    />
                  </div>
                </div>
              ) : null}

              {/* Status distribution mini-bar */}
              {historyTotal > 0 ? (
                <div className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
                  <div className="flex h-2 w-full overflow-hidden bg-slate-100">
                    {statusCounts.approved > 0 ? (
                      <div
                        className="h-full bg-emerald-500 transition-all duration-500 motion-reduce:transition-none"
                        style={{ width: `${(statusCounts.approved / historyTotal) * 100}%` }}
                        title={`Approved: ${statusCounts.approved}`}
                      />
                    ) : null}
                    {statusCounts.pending > 0 ? (
                      <div
                        className="h-full bg-sky-500 transition-all duration-500 motion-reduce:transition-none"
                        style={{ width: `${(statusCounts.pending / historyTotal) * 100}%` }}
                        title={`Pending: ${statusCounts.pending}`}
                      />
                    ) : null}
                    {statusCounts.rejected > 0 ? (
                      <div
                        className="h-full bg-rose-500 transition-all duration-500 motion-reduce:transition-none"
                        style={{ width: `${(statusCounts.rejected / historyTotal) * 100}%` }}
                        title={`Rejected: ${statusCounts.rejected}`}
                      />
                    ) : null}
                    {statusCounts.returned > 0 ? (
                      <div
                        className="h-full bg-amber-500 transition-all duration-500 motion-reduce:transition-none"
                        style={{ width: `${(statusCounts.returned / historyTotal) * 100}%` }}
                        title={`Returned: ${statusCounts.returned}`}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums">
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
                      <span className="text-emerald-700">Approved {statusCounts.approved}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2 w-2 bg-sky-500" />
                      <span className="text-sky-700">Pending {statusCounts.pending}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2 w-2 bg-rose-500" />
                      <span className="text-rose-700">Rejected {statusCounts.rejected}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="inline-block h-2 w-2 bg-amber-500" />
                      <span className="text-amber-700">Returned {statusCounts.returned}</span>
                    </span>
                  </div>
                </div>
              ) : null}

              {/* Desktop table (md+) */}
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-phx-sm" data-portal-desktop-table>
                  <colgroup>
                    <col className="w-[14%]" />
                    <col className="w-[15%]" />
                    <col className="w-[8%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[23%]" />
                  </colgroup>
                  <thead className="bg-white text-phx-xs font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Date</th>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Type</th>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Duration</th>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Manager</th>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Status</th>
                      <th className="border-b border-r border-slate-200 px-3 py-2.5">Submitted</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Decision</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredRequests.map((request) => (
                      <tr key={request.id} className="bg-white transition-colors hover:bg-slate-50 motion-reduce:transition-none">
                        <td className="border-r border-slate-200 px-3 py-2.5 break-words font-semibold tabular-nums text-slate-700">
                          {formatDate(request.excuseDate)}
                          <span className="mt-0.5 block font-mono text-phx-sm font-bold text-slate-400">{request.requestCode}</span>
                        </td>
                        <td className={`border-r border-slate-200 px-3 py-2.5 break-words font-semibold ${LANDING_INK}`}>{typeLabel(request.excuseType)}</td>
                        <td className={`border-r border-slate-200 px-3 py-2.5 text-center font-bold tabular-nums ${LANDING_INK}`}>{request.durationHours}h</td>
                        <td className="border-r border-slate-200 px-3 py-2.5 break-words font-semibold text-slate-700">{request.managerName ?? "—"}</td>
                        <td className="border-r border-slate-200 px-3 py-2.5">
                          <span className={`${statusWordClassName} ${statusInk(request.status)}`}>
                            {statusLabel(request.status)}
                          </span>
                        </td>
                        <td className="border-r border-slate-200 px-3 py-2.5 break-words font-medium tabular-nums text-slate-600">{formatDateTime(request.createdAt)}</td>
                        <td className="break-words px-3 py-2.5 text-phx-xs">
                          {request.managerDecisionAt ? (
                            <div>
                              <p className="font-medium tabular-nums text-slate-600">{formatDateTime(request.managerDecisionAt)}</p>
                              {request.managerDecisionComment ? (
                                <p className="mt-0.5 leading-4 text-slate-500" dir="auto">{request.managerDecisionComment}</p>
                              ) : null}
                              {request.status === "returned_to_employee" ? (
                                <button
                                  className={landingActionClassName("outline", "mt-2")}
                                  onClick={() => editReturnedRequest(request)}
                                  type="button"
                                >
                                  Edit and resubmit
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filteredRequests.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={7}>
                          {historySearch ? "No matching requests found." : "No excuse requests yet."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              {/* Mobile card view (< xs / 480px) */}
              <div className="block divide-y divide-slate-200 md:hidden">
                {filteredRequests.length === 0 ? (
                  <LandingEmpty>
                    {historySearch ? "No matching requests found." : "No excuse requests yet."}
                  </LandingEmpty>
                ) : (
                  filteredRequests.map((request) => (
                    <ExcuseHistoryCard key={request.id} request={request} onEditReturned={editReturnedRequest} />
                  ))
                )}
              </div>
            </LandingPanel>
            </div>
          ) : null}
        </div>

        {/* ── Right Sidebar ─────────────────────────────────────── */}
        <div className="space-y-3">
          {/* Monthly trend sparkline (#5) */}
          <MonthlyTrendSparkline requests={workspace.requests} />

          {/* Profile card */}
          <LandingPanel title="Employee profile">
            <h3 className={`break-words border-b border-slate-200 px-3 py-2.5 text-base font-extrabold sm:px-4 ${LANDING_INK}`} dir="auto">
              {workspace.employee.fullName}
            </h3>
            <LandingRow label="Role" value={workspace.employee.roleLabel} />
            <LandingRow label="Line" value={workspace.employee.lineName ?? "Head Office"} />
            <LandingRow label="Manager" value={workspace.employee.managerName ?? "Not assigned"} />
          </LandingPanel>

          {/* Policy info card */}
          <LandingPanel bodyClassName="px-3 py-3 sm:px-4" title="Excuse policy">
            <div className="space-y-2 text-phx-sm leading-5 text-slate-600">
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-[#08111f]" />
                <span>Each excuse covers a 2-hour window (morning or afternoon).</span>
              </div>
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-[#08111f]" />
                <span>{workspace.monthly.allowance} excuses allowed per calendar month.</span>
              </div>
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-[#08111f]" />
                <span>Rejected requests do not count against the monthly limit.</span>
              </div>
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 bg-[#08111f]" />
                <span>Your direct manager receives an email with approve/reject links.</span>
              </div>
            </div>
          </LandingPanel>
        </div>
      </div>
    </div>
  );
}
